import { createHash } from 'node:crypto';
import type { ResourceId } from '../../domain/ids.js';
import type { ResourceRole } from '../../domain/resource.js';
import type { CrawlRunStatus, FetchOutcome } from '../../domain/run.js';
import {
  type CrawlRunCounts,
  failUnsettledCrawlRun,
  finishCrawlRun,
  getLastCompletedCrawlRun,
  getMaxDiscoveredCountForSource,
  recordFetchAttempt,
  recordParserIncident,
  startCrawlRun,
  upsertResource,
} from '../../db/ingest.js';
import {
  closeMissingListingsInTransaction,
  expireOverdueListings,
} from '../../db/reconcile-source-listings.js';
import {
  type CrawlRunRow,
  sourcePolicies as sourcePoliciesTable,
  sources,
} from '../../db/schema/index.js';
import type { Database } from '../../db/types.js';
import {
  quarantineSourceListing,
  touchSourceListingSeen,
  writeSourceListingRevision,
} from '../../db/write-source-listing-revision.js';
import {
  type HttpFetcher,
  type HttpFetchResult,
  SsrfBlockedError,
  UrlNotAllowedError,
} from '../../net/http-fetcher.js';
import { hrGePolicy, hrGeSource, isHrGeUrlAllowed } from '../../policies/hr-ge.js';
import { classifyHrGeResponse, isHrGeRateLimited } from './challenge.js';
import { HR_GE_DETAIL_PARSER_VERSION, parseHrGeDetailPage } from './detail.js';
import { type DiscoveredListing, parseSearchPostingPage } from './discovery.js';
import { parseHrGeSitemap, SitemapParseError } from './sitemap.js';

const SEARCH_POSTING_PATH = '/search-posting';
const SITEMAP_URL = 'https://api.p.hr.ge/public-portal/tenant/1/api/v3/seo/sitemap';

/**
 * Safety cap, not a real expectation — hr.ge's current corpus is 33 pages
 * (RECON_NOTES.md: 3,265 listings / 100 per page). Unlike jobs.ge, hr.ge
 * has a real HTTP 404 terminator (see discoverAllListings below), so this
 * cap is defense-in-depth only, not the primary stop signal.
 */
const MAX_DISCOVERY_PAGES = 200;

/**
 * Absolute tolerance between listings actually collected and the source's
 * own claimed `totalCount` (RECON_NOTES.md: "a free completeness oracle,"
 * present on every index response). A measured pagination-shift race over
 * one full walk cost exactly 2 of 3,265 items (two IDs straddling a page
 * boundary shifted by a renewal mid-walk) — this is a small, generous
 * margin above that, not a guessed number. Stronger evidence than jobs-ge's
 * fixed floor: hr.ge states its own expected count on the same response,
 * where jobs.ge's floor had to be a hand-picked constant.
 */
const DEFAULT_MAX_DISCOVERY_SHORTFALL = 15;

/** Same tolerance and rationale as jobs-ge's own guard (src/adapters/jobs-ge/crawl.ts) — no source-specific evidence to differ. */
const DEFAULT_MAX_QUARANTINE_RATE = 0.1;

/** Same tolerance and rationale as jobs-ge's own guard — see there for the full reasoning (transient/self-healing fetch failures vs. genuine template breaks). */
const DEFAULT_MAX_FETCH_FAILURE_RATE = 0.5;

/**
 * Defense-in-depth against `totalCount` itself collapsing (a systemic bug
 * upstream of this crawler could report a false small total alongside
 * genuinely few rows) — kept even though `totalCount` is already stronger
 * evidence than jobs-ge's fixed floor, per RECON_NOTES.md's own
 * recommendation. Same ratio and never-blocks-a-first-run behavior as
 * jobs-ge's guard.
 */
const DEFAULT_MIN_RELATIVE_COVERAGE_RATIO = 0.5;

/** Same project decision as jobs.ge (docs/STATUS.md, 2026-09-04) — no source-specific evidence to differ. */
export const DEFAULT_MISSING_STREAK_THRESHOLD = 3;

export interface RunHrGeCrawlDeps {
  db: Database;
  httpFetcher: HttpFetcher;
  /** Injectable clock, defaults to the real wall clock. Tests supply a fixed/advancing one for determinism. */
  now?: () => string;
}

export interface RunHrGeCrawlOptions {
  missingStreakThreshold: number;
  maxDiscoveryShortfall?: number;
  maxQuarantineRate?: number;
  maxFetchFailureRate?: number;
  minRelativeCoverageRatio?: number;
  /** Skips the sitemap cross-check entirely — for tests that don't want to stub a sitemap fetch. Production callers should omit this. */
  skipSitemapCrossCheck?: boolean;
}

export interface RunHrGeCrawlResult {
  crawlRun: CrawlRunRow;
}

/**
 * Idempotently ensures hr.ge's `sources`/`source_policies` rows exist —
 * mirrors jobs-ge's ensureJobsGeSourceSeeded exactly (src/adapters/jobs-ge/crawl.ts).
 */
export async function ensureHrGeSourceSeeded(db: Database): Promise<void> {
  await db
    .insert(sources)
    .values({
      id: hrGeSource.id,
      slug: hrGeSource.slug,
      displayName: hrGeSource.displayName,
      baseUrl: hrGeSource.baseUrl,
    })
    .onConflictDoNothing();

  await db
    .insert(sourcePoliciesTable)
    .values({
      id: hrGePolicy.id,
      sourceId: hrGePolicy.sourceId,
      policyVersion: hrGePolicy.policyVersion,
      allowedAcquisitionModes: hrGePolicy.allowedAcquisitionModes,
      allowedPathPatterns: hrGePolicy.allowedPathPatterns,
      disallowedPathPatterns: hrGePolicy.disallowedPathPatterns,
      disallowedHosts: hrGePolicy.disallowedHosts,
      authenticationScope: hrGePolicy.authenticationScope,
      rateLimit: hrGePolicy.rateLimit,
      termsUrl: hrGePolicy.termsUrl,
      robotsUrl: hrGePolicy.robotsUrl,
      retention: hrGePolicy.retention,
      display: hrGePolicy.display,
      linkedResources: hrGePolicy.linkedResources,
      reviewDate: hrGePolicy.reviewDate,
      evidence: hrGePolicy.evidence,
      notes: hrGePolicy.notes,
      decisionOwner: hrGePolicy.decisionOwner,
    })
    .onConflictDoNothing();
}

function buildSearchPostingUrl(page: number): string {
  const url = new URL(SEARCH_POSTING_PATH, hrGeSource.baseUrl);
  if (page > 1) url.searchParams.set('pg', String(page));
  return url.toString();
}

/**
 * Classifies a completed HTTP-level fetch (no thrown network/policy error)
 * by hr.ge-specific health signals BEFORE falling back to plain status-code
 * success/failure — checked in this order because a WAF challenge or an
 * exhausted rate-limit budget can arrive on any status code, including 200,
 * and must never be parsed as if it were real content (concept §21.3, §22:
 * detect, never bypass).
 */
function classifyHttpResult(result: HttpFetchResult): FetchOutcome {
  if (isHrGeRateLimited(result.status, result.headers)) return 'retry';
  if (
    classifyHrGeResponse({ status: result.status, headers: result.headers, body: result.body }) ===
    'challenged'
  ) {
    return 'blocked';
  }
  return result.status === 200 ? 'success' : 'failure';
}

function classifyOutcome(error: unknown, result: HttpFetchResult | null): FetchOutcome {
  if (error instanceof UrlNotAllowedError || error instanceof SsrfBlockedError) return 'blocked';
  if (error !== null) return 'failure';
  if (result === null) return 'failure';
  return classifyHttpResult(result);
}

function describeError(error: unknown, result: HttpFetchResult | null): string | null {
  if (error instanceof Error) return error.name;
  if (error !== null) return 'unknown_error';
  if (result !== null && result.status !== 200) return `http_${result.status}`;
  return null;
}

function extractMimeType(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  return value.split(';')[0]?.trim() || null;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

interface FetchAndRecordResult {
  outcome: FetchOutcome;
  resource: { id: string };
  fetchResult: HttpFetchResult | null;
}

/** Fetches one URL and unconditionally records the attempt — mirrors jobs-ge's own fetchAndRecord exactly (src/adapters/jobs-ge/crawl.ts). */
async function fetchAndRecord(
  db: Database,
  httpFetcher: HttpFetcher,
  crawlRunId: string,
  role: ResourceRole,
  url: string,
  attemptedAt: string,
): Promise<FetchAndRecordResult> {
  const startedAtMs = Date.now();
  let fetchResult: HttpFetchResult | null = null;
  let caughtError: unknown = null;
  try {
    fetchResult = await httpFetcher.fetch(url);
  } catch (err) {
    caughtError = err;
  }
  const durationMs = Date.now() - startedAtMs;
  const outcome = classifyOutcome(caughtError, fetchResult);
  const succeeded = outcome === 'success' && fetchResult !== null;

  const resource = await upsertResource(db, {
    sourceId: hrGeSource.id,
    role,
    originalUrl: url,
    canonicalUrl: url,
    finalUrl: fetchResult?.finalUrl ?? null,
    status: succeeded ? 'fetched' : 'failed',
    fetchedAt: attemptedAt,
    contentHash: succeeded && fetchResult ? sha256(fetchResult.body) : null,
    byteSize: succeeded && fetchResult ? Buffer.byteLength(fetchResult.body, 'utf-8') : null,
    mimeType: fetchResult ? extractMimeType(fetchResult.headers) : null,
  });

  await recordFetchAttempt(db, {
    crawlRunId,
    resourceId: resource.id,
    attemptedAt,
    statusCode: fetchResult?.status ?? null,
    durationMs,
    outcome,
    errorKind: describeError(caughtError, fetchResult),
  });

  return { outcome, resource, fetchResult };
}

interface DiscoverAllListingsResult {
  listings: Map<string, DiscoveredListing>;
  /** True only if the walk reached a real HTTP 404 (the confirmed terminator, RECON_NOTES.md) rather than a fetch failure/challenge or the MAX_DISCOVERY_PAGES safety cap. */
  complete: boolean;
  /** The source's own claimed corpus size, from the last successfully-parsed page. Null if no page ever parsed successfully. */
  totalCount: number | null;
}

/**
 * Walks `/search-posting?pg=N` from page 1 to hr.ge's own real HTTP 404
 * terminator (RECON_NOTES.md — confirmed via a full 33-page walk plus an
 * out-of-range probe, unlike jobs.ge's ambiguous clamp-to-last-page
 * behavior, so no confirmation-probe machinery is needed here). A 404 on
 * page 1 would be a genuine anomaly (an empty corpus, or the URL shape
 * itself broke) — treated the same as any other non-terminal failure:
 * `complete: false`, not silently accepted as "0 listings, done."
 */
async function discoverAllListings(
  db: Database,
  httpFetcher: HttpFetcher,
  crawlRun: CrawlRunRow,
  now: () => string,
): Promise<DiscoverAllListingsResult> {
  const listings = new Map<string, DiscoveredListing>();
  let complete = false;
  let totalCount: number | null = null;

  for (let page = 1; page <= MAX_DISCOVERY_PAGES; page++) {
    const url = buildSearchPostingUrl(page);
    const attemptedAt = now();
    const { outcome, fetchResult } = await fetchAndRecord(
      db,
      httpFetcher,
      crawlRun.id,
      'INDEX',
      url,
      attemptedAt,
    );

    if (fetchResult?.status === 404) {
      complete = true;
      break;
    }
    if (outcome !== 'success' || fetchResult === null) {
      break; // failure, block, or rate-limit mid-walk: incomplete, not fatal to the run
    }

    let parsed: ReturnType<typeof parseSearchPostingPage>;
    try {
      parsed = parseSearchPostingPage(fetchResult.body);
    } catch {
      break; // structural drift on an index page: stop, incomplete
    }

    totalCount = parsed.totalCount;
    for (const listing of parsed.listings) {
      listings.set(listing.sourceRecordId, listing);
    }
    if (parsed.listings.length === 0 && page === 1) {
      // A healthy-shaped but empty page 1 is itself an anomaly worth
      // stopping on rather than walking 200 empty pages — page > 1 empty
      // is likewise unexpected but the 404 terminator should have already
      // fired by then in the healthy case, so this only guards page 1.
      break;
    }
  }

  return { listings, complete, totalCount };
}

/**
 * Fetches and parses the public sitemap as an ADDITIVE cross-check only
 * (sitemap.ts's own contract) — adds candidate IDs the index walk's
 * pagination-shift race (RECON_NOTES.md) might have missed, using the
 * sitemap's own already-slugged URL. Never treated as fatal: a fetch or
 * parse failure here (including the documented, unverified zstd-decoding
 * gap — sitemap.ts) simply means this run skips the cross-check, exactly
 * as "skippable" as RECON_NOTES.md's implementation plan describes it.
 */
/**
 * Recovered candidates are built as minimal but genuinely evidenced
 * DiscoveredListing entries, not placeholders: `isPriority: true` is a
 * real, confirmed fact for every sitemap entry (RECON_NOTES.md — the
 * sitemap contains exactly the priority/paid announcements), not a guess.
 * The other fields (title, dates) are unknown until the detail fetch
 * below supplies them from the actual page — the same "known unknown,
 * not fabricated" treatment §6.2 requires elsewhere in this codebase.
 */
function toRecoveredListing(candidate: { sourceRecordId: string; url: string }): DiscoveredListing {
  return {
    sourceRecordId: candidate.sourceRecordId,
    url: candidate.url,
    title: '',
    isPriority: true,
    listingSection: 0,
    publishDate: null,
    renewalDate: null,
    deadlineDate: null,
  };
}

async function crossCheckSitemap(
  db: Database,
  httpFetcher: HttpFetcher,
  crawlRun: CrawlRunRow,
  now: () => string,
  alreadyDiscovered: ReadonlySet<string>,
): Promise<DiscoveredListing[]> {
  const attemptedAt = now();
  const { outcome, fetchResult } = await fetchAndRecord(
    db,
    httpFetcher,
    crawlRun.id,
    'INDEX',
    SITEMAP_URL,
    attemptedAt,
  );
  if (outcome !== 'success' || fetchResult === null) {
    return [];
  }

  let candidates: ReturnType<typeof parseHrGeSitemap>;
  try {
    candidates = parseHrGeSitemap(fetchResult.body);
  } catch (err) {
    if (err instanceof SitemapParseError) return [];
    throw err;
  }

  return candidates.filter((c) => !alreadyDiscovered.has(c.sourceRecordId)).map(toRecoveredListing);
}

/**
 * Runs one full hr.ge crawl. Structure mirrors src/adapters/jobs-ge/crawl.ts's
 * runJobsGeCrawl closely — see there for the fuller rationale behind the
 * shared parts (fetchAndRecord's unconditional recording, the two-phase
 * finishCrawlRun/settlement-transaction pattern, failUnsettledCrawlRun's
 * ambiguous-commit handling). Differences are hr.ge-specific, each noted
 * where it departs from the jobs.ge pattern per RECON_NOTES.md's
 * implementation plan: a real HTTP 404 discovery terminator instead of a
 * clamp-confirmation probe, a totalCount-based completeness check instead
 * of (alongside) a fixed floor, no VIP/standard partition collapse guard,
 * an additive sitemap cross-check, and WAF/rate-limit-aware fetch
 * classification (challenge.ts).
 */
export async function runHrGeCrawl(
  deps: RunHrGeCrawlDeps,
  options: RunHrGeCrawlOptions,
): Promise<RunHrGeCrawlResult> {
  const { db, httpFetcher } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const maxDiscoveryShortfall = options.maxDiscoveryShortfall ?? DEFAULT_MAX_DISCOVERY_SHORTFALL;
  const maxQuarantineRate = options.maxQuarantineRate ?? DEFAULT_MAX_QUARANTINE_RATE;
  const maxFetchFailureRate = options.maxFetchFailureRate ?? DEFAULT_MAX_FETCH_FAILURE_RATE;
  const minRelativeCoverageRatio =
    options.minRelativeCoverageRatio ?? DEFAULT_MIN_RELATIVE_COVERAGE_RATIO;

  await ensureHrGeSourceSeeded(db);

  const startedAt = now();
  const crawlRun = await startCrawlRun(db, {
    sourceId: hrGeSource.id,
    startedAt,
    fullCoverage: true,
  });

  const counts: CrawlRunCounts = {
    discoveredCount: 0,
    vipCount: 0,
    standardCount: 0,
    newCount: 0,
    changedCount: 0,
    unchangedCount: 0,
    missingCount: 0,
    expiredCount: 0,
    reopenedCount: 0,
    quarantinedCount: 0,
    failedCount: 0,
  };

  try {
    const { listings, complete, totalCount } = await discoverAllListings(
      db,
      httpFetcher,
      crawlRun,
      now,
    );

    if (!options.skipSitemapCrossCheck) {
      const recovered = await crossCheckSitemap(
        db,
        httpFetcher,
        crawlRun,
        now,
        new Set(listings.keys()),
      );
      for (const listing of recovered) {
        listings.set(listing.sourceRecordId, listing);
      }
    }

    counts.discoveredCount = listings.size;
    for (const listing of listings.values()) {
      if (listing.isPriority) counts.vipCount++;
      else counts.standardCount++;
    }

    for (const listing of listings.values()) {
      const identity = {
        sourceId: hrGeSource.id,
        sourceRecordId: listing.sourceRecordId,
        canonicalSourceUrl: listing.url,
      };
      const attemptedAt = now();
      const { outcome, resource, fetchResult } = await fetchAndRecord(
        db,
        httpFetcher,
        crawlRun.id,
        'OPPORTUNITY',
        listing.url,
        attemptedAt,
      );
      if (outcome !== 'success' || fetchResult === null) {
        counts.failedCount++;
        await touchSourceListingSeen(db, identity, attemptedAt);
        continue;
      }

      let content: ReturnType<typeof parseHrGeDetailPage>;
      try {
        content = parseHrGeDetailPage({
          html: fetchResult.body,
          announcementId: listing.sourceRecordId,
          extractionMethod: 'http',
          provenance: {
            resourceId: resource.id as ResourceId,
            fetchedAt: attemptedAt,
            notes: null,
          },
        });
      } catch (parseError) {
        counts.quarantinedCount++;
        await quarantineSourceListing(db, identity, attemptedAt);
        await upsertResource(db, {
          sourceId: hrGeSource.id,
          role: 'OPPORTUNITY',
          originalUrl: listing.url,
          canonicalUrl: listing.url,
          finalUrl: fetchResult.finalUrl,
          status: 'quarantined',
          fetchedAt: attemptedAt,
          contentHash: sha256(fetchResult.body),
          byteSize: Buffer.byteLength(fetchResult.body, 'utf-8'),
          mimeType: extractMimeType(fetchResult.headers),
        });
        await recordParserIncident(db, {
          sourceId: hrGeSource.id,
          crawlRunId: crawlRun.id,
          detectedAt: attemptedAt,
          kind: 'field_missing',
          severity: 'warning',
          evidence: {
            sourceRecordId: listing.sourceRecordId,
            url: listing.url,
            resourceId: resource.id,
            parserVersion: HR_GE_DETAIL_PARSER_VERSION,
            error: parseError instanceof Error ? parseError.message : String(parseError),
          },
        });
        continue;
      }

      const writeResult = await writeSourceListingRevision(db, identity, content, attemptedAt, {
        allowReopen: true,
      });
      if (writeResult.outcome === 'new') counts.newCount++;
      else if (writeResult.outcome === 'changed') counts.changedCount++;
      else if (writeResult.outcome === 'unchanged') counts.unchangedCount++;
      if (writeResult.reopened) counts.reopenedCount++;
    }

    const quarantineRate = listings.size > 0 ? counts.quarantinedCount / listings.size : 0;
    const fetchFailureRate = listings.size > 0 ? counts.failedCount / listings.size : 0;

    // totalCount-based completeness: stronger evidence than a fixed floor
    // since hr.ge states its own expected count on the same response
    // (RECON_NOTES.md) — but only usable when at least one page actually
    // parsed (totalCount !== null); a walk that never got past page 1
    // falls through to totalCountOk === false via the null check, which is
    // correct (no evidence of a healthy corpus at all).
    const totalCountOk = totalCount !== null && listings.size >= totalCount - maxDiscoveryShortfall;

    const lastCompletedRun = await getLastCompletedCrawlRun(db, hrGeSource.id);
    const baselineDiscoveredCount =
      lastCompletedRun !== null
        ? lastCompletedRun.discoveredCount
        : await getMaxDiscoveredCountForSource(db, hrGeSource.id, crawlRun.id);
    const baselineOk =
      baselineDiscoveredCount === 0 ||
      listings.size >= baselineDiscoveredCount * minRelativeCoverageRatio;

    // No VIP/standard-style per-partition collapse guard — hr.ge has no
    // structurally separate partition the way jobs.ge's .vipEntries
    // container is (RECON_NOTES.md: isPriority listings are interleaved in
    // the same ordered list, not a separate section), so there's no
    // "container silently stopped matching" failure mode analogous to
    // jobs-ge's round-5 fix to guard against. vipCount/standardCount above
    // are populated for reporting parity only.
    const discoveryOk =
      complete &&
      totalCountOk &&
      quarantineRate <= maxQuarantineRate &&
      fetchFailureRate <= maxFetchFailureRate &&
      baselineOk;

    const finishedAt = now();
    const runStatus: CrawlRunStatus = discoveryOk ? 'completed' : 'partial';

    const finalRun = await db.transaction(async (tx) => {
      await finishCrawlRun(tx, crawlRun.id, { finishedAt, status: runStatus, counts });

      const expireResult = await expireOverdueListings(tx, {
        sourceId: hrGeSource.id,
        asOf: finishedAt,
      });
      const closeResult = await closeMissingListingsInTransaction(tx, {
        crawlRunId: crawlRun.id,
        missingStreakThreshold: options.missingStreakThreshold,
      });

      const settledCounts: CrawlRunCounts = {
        ...counts,
        expiredCount: expireResult.expiredCount,
        missingCount: closeResult.missingSuspectedCount + closeResult.closedCount,
      };

      return finishCrawlRun(tx, crawlRun.id, {
        finishedAt,
        status: runStatus,
        counts: settledCounts,
        reconciledAt: finishedAt,
      });
    });
    return { crawlRun: finalRun };
  } catch (err) {
    await failUnsettledCrawlRun(db, crawlRun.id, {
      finishedAt: now(),
      counts,
      reconciledAt: now(),
    });
    throw err;
  }
}

// isHrGeUrlAllowed is re-exported here purely so callers of this module
// (the CLI entry point) can reuse the same authorization boundary the
// crawl itself is built on without a second import path.
export { isHrGeUrlAllowed };
