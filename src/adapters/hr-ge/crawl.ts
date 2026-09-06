import { createHash } from 'node:crypto';
import type { ResourceId } from '../../domain/ids.js';
import type { ResourceRole } from '../../domain/resource.js';
import type { CrawlRunStatus, FetchOutcome } from '../../domain/run.js';
import {
  type CrawlRunCounts,
  failUnsettledCrawlRun,
  extendSourceBackoff,
  getSourceBackoffUntil,
  finishCrawlRun,
  getCrawlCursor,
  getCrawlDiscoveryPage,
  getLastCompletedCrawlRun,
  getMaxDiscoveredCountForSource,
  markCrawlRunPartialCoverage,
  recordFetchAttempt,
  recordParserIncident,
  setCrawlCursor,
  setCrawlDiscoveryPage,
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
import { type FetchControl, responseBackoffUntil } from '../../net/fetch-control.js';
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
  mode?: 'full' | 'incremental';
  incrementalPages?: number;
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
      allowedHosts: hrGePolicy.allowedHosts,
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
 * success/failure. A WAF challenge is checked first since it can arrive on
 * any status code, including 200, and must never be parsed as if it were
 * real content (concept §21.3, §22: detect, never bypass).
 *
 * A status-200 response is always 'success' once it clears the challenge
 * check — including when `Ratelimit-Remaining: 0` is also present.
 * Adversarial review (2026-09-05) caught a real bug in an earlier version
 * of this function: checking isHrGeRateLimited BEFORE the status check
 * meant a healthy 200 response whose headers merely reported an exhausted
 * quota window was classified 'retry' and its real, successfully-fetched
 * body was discarded unparsed — "you've used your last allowed request"
 * is not the same claim as "this response is invalid." Only a genuinely
 * rejected request (concept §6.2: 429, honored as a first-class "honor
 * retry instructions" signal) reaches the rate-limit branch now.
 */
function classifyHttpResult(result: HttpFetchResult): FetchOutcome {
  if (
    classifyHrGeResponse({ status: result.status, headers: result.headers, body: result.body }) ===
    'challenged'
  ) {
    return 'blocked';
  }
  if (result.status === 200) return 'success';
  if (isHrGeRateLimited(result.status, result.headers)) return 'retry';
  return 'failure';
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
  control: FetchControl,
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
  const backoffUntil =
    fetchResult === null
      ? null
      : responseBackoffUntil(
          fetchResult,
          new Date(Date.parse(attemptedAt) + durationMs).toISOString(),
        );
  if (outcome === 'blocked' || outcome === 'retry' || backoffUntil !== null) control.stopped = true;
  if (backoffUntil !== null)
    await extendSourceBackoff(db, hrGeSource.id, backoffUntil, attemptedAt);
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
  /**
   * True only when this walk learned something decisive about where the next
   * one should start — mirroring the per-listing loop's `hasResumeDecision`.
   * False means "no information": the caller must leave any previously saved
   * page untouched rather than overwrite real progress with a guess.
   */
  hasDiscoveryResumeDecision: boolean;
  /** With a decision: the first index page this walk did not cover, or null once the terminator was reached. */
  nextDiscoveryPage: number | null;
}

/**
 * Walks `/search-posting?pg=N` from page 1 to hr.ge's own real HTTP 404
 * terminator (RECON_NOTES.md — confirmed via a full 33-page walk plus an
 * out-of-range probe, unlike jobs.ge's ambiguous clamp-to-last-page
 * behavior, so no confirmation-probe machinery is needed here). A 404 on
 * page 1 would be a genuine anomaly (an empty corpus, or the URL shape
 * itself broke) — treated the same as any other non-terminal failure:
 * `complete: false`, not silently accepted as "0 listings, done."
 *
 * The walk starts at `startPage`, not always at page 1: hr.ge's advertised
 * budget is 20 requests per 60s (policies/hr-ge.ts) while a full index is
 * ~33 pages, so a rate limit can stop the walk mid-index. Restarting at page
 * 1 every invocation would then re-spend the same budget on the same prefix
 * and never reach the pages beyond it — the terminator, and every listing
 * past the stopping point, would stay permanently unreachable (adversarial
 * review, 2026-09-06). Callers must treat a resumed walk as a suffix of the
 * corpus, never as evidence about the whole of it.
 */
async function discoverAllListings(
  db: Database,
  httpFetcher: HttpFetcher,
  crawlRun: CrawlRunRow,
  now: () => string,
  control: FetchControl,
  incrementalPages: number | null,
  startPage: number,
): Promise<DiscoverAllListingsResult> {
  const listings = new Map<string, DiscoveredListing>();
  let complete = false;
  let totalCount: number | null = null;
  // The last page whose listings were actually parsed and recorded. A page
  // that merely got a response (a 429, a challenge) is not "covered."
  let lastCoveredPage = startPage - 1;
  let hasDiscoveryResumeDecision = false;
  let nextDiscoveryPage: number | null = null;

  for (
    let page = startPage;
    page <= (incrementalPages ?? MAX_DISCOVERY_PAGES) && !control.stopped;
    page++
  ) {
    const url = buildSearchPostingUrl(page);
    const attemptedAt = now();
    const { outcome, fetchResult } = await fetchAndRecord(
      db,
      httpFetcher,
      crawlRun.id,
      'INDEX',
      url,
      attemptedAt,
      control,
    );

    if (page > 1 && outcome === 'failure' && fetchResult?.status === 404 && !control.stopped) {
      complete = true;
      // The walk ran out of pages, so there is nothing left to resume: the
      // next invocation starts a fresh sweep at page 1. True for a resumed
      // walk too — its own suffix is finished.
      hasDiscoveryResumeDecision = true;
      nextDiscoveryPage = null;
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

    totalCount = Math.max(totalCount ?? 0, parsed.totalCount);
    for (const listing of parsed.listings) {
      listings.set(listing.sourceRecordId, listing);
    }
    lastCoveredPage = page;
    if (parsed.listings.length === 0) {
      // A healthy-shaped but empty page 1 is itself an anomaly worth
      // stopping on rather than walking 200 empty pages — page > 1 empty
      // is likewise unexpected but the 404 terminator should have already
      // fired by then in the healthy case, so this only guards page 1.
      break;
    }
    if (incrementalPages !== null && page === incrementalPages) complete = true;
  }

  // A source-wide stop is the one interruption that carries real progress:
  // whatever was covered before it stays covered, so the next walk starts at
  // the first page this one did not. Both stop shapes land here — a rejected
  // request (429/challenge: the page itself is uncovered, resume AT it) and a
  // usable quota-exhausting 200 (the page was parsed and recorded, resume
  // AFTER it) — because `lastCoveredPage` only advances on the latter.
  //
  // Every other exit (a plain fetch failure, index drift, an empty page, the
  // MAX_DISCOVERY_PAGES cap) deliberately leaves the decision unmade: none of
  // them establishes where a later walk should pick up, and overwriting a
  // real saved position with a guess is worse than repeating a prefix.
  if (control.stopped && !hasDiscoveryResumeDecision) {
    hasDiscoveryResumeDecision = true;
    nextDiscoveryPage = lastCoveredPage + 1;
  }

  return { listings, complete, totalCount, hasDiscoveryResumeDecision, nextDiscoveryPage };
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
  control: FetchControl,
): Promise<DiscoveredListing[]> {
  const attemptedAt = now();
  const { outcome, fetchResult } = await fetchAndRecord(
    db,
    httpFetcher,
    crawlRun.id,
    'INDEX',
    SITEMAP_URL,
    attemptedAt,
    control,
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

  const incremental = options.mode === 'incremental';
  const incrementalPages = incremental ? (options.incrementalPages ?? 2) : null;
  if (
    incrementalPages !== null &&
    (!Number.isInteger(incrementalPages) ||
      incrementalPages < 1 ||
      incrementalPages > MAX_DISCOVERY_PAGES)
  ) {
    throw new Error('incrementalPages must be an integer between 1 and 200');
  }

  await ensureHrGeSourceSeeded(db);

  const startedAt = now();
  const crawlRun = await startCrawlRun(db, {
    sourceId: hrGeSource.id,
    startedAt,
    fullCoverage: !incremental,
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
    // Read the cursor only AFTER startCrawlRun's exclusivity lock is held
    // (adversarial review, 2026-09-05, round 6) — reading it first would
    // leave a handoff-race window where another invocation for this source
    // could start and fully settle (writing a newer cursor) between the
    // read and this run's own lock acquisition, letting this run silently
    // repeat an already-covered prefix and then overwrite that newer
    // cursor with a stale decision. Inside the try block, not between it
    // and startCrawlRun (adversarial review, round 7) — a transient
    // failure reading the cursor must still settle this run via the catch
    // block's failUnsettledCrawlRun below, or the exclusivity lock
    // (reconciledAt staying null) would block every future run for this
    // source until manually repaired.
    const previousCursor = await getCrawlCursor(db, hrGeSource.id);
    // Incremental polls are defined as "the newest pages" and must never
    // consume or advance the full walk's own position.
    const previousDiscoveryPage = incremental
      ? null
      : await getCrawlDiscoveryPage(db, hrGeSource.id);
    const startPage = previousDiscoveryPage ?? 1;
    const backoffUntil = await getSourceBackoffUntil(db, hrGeSource.id);
    const control: FetchControl = {
      stopped: backoffUntil !== null && Date.parse(backoffUntil) > Date.parse(now()),
    };

    // Recorded before any request, so the row never claims coverage this run
    // cannot have. startCrawlRun cannot decide this itself: the saved page is
    // readable only after its lock is held (see the comment above).
    if (startPage > 1) await markCrawlRunPartialCoverage(db, crawlRun.id);

    const { listings, complete, totalCount, hasDiscoveryResumeDecision, nextDiscoveryPage } =
      await discoverAllListings(
        db,
        httpFetcher,
        crawlRun,
        now,
        control,
        incrementalPages,
        startPage,
      );

    // Tracks which ids came from the sitemap cross-check rather than the
    // index walk itself — needed below so a failed detail fetch for a
    // sitemap-only candidate is never mistaken for confirmation the
    // listing still exists (see the per-listing loop's failure branch).
    const observedIds = new Set(listings.keys());
    counts.discoveredCount = observedIds.size;
    for (const listing of listings.values()) {
      if (listing.isPriority) counts.vipCount++;
      else counts.standardCount++;
    }
    const sitemapOnlyIds = new Set<string>();
    if (!incremental && !options.skipSitemapCrossCheck && !control.stopped) {
      const recovered = await crossCheckSitemap(
        db,
        httpFetcher,
        crawlRun,
        now,
        observedIds,
        control,
      );
      for (const listing of recovered) {
        listings.set(listing.sourceRecordId, listing);
        sitemapOnlyIds.add(listing.sourceRecordId);
      }
    }

    // Full crawls resume at the rejected item. Incremental polls always start at
    // the newest page and never alter the full-crawl cursor.
    const orderedListings = [...listings.values()];
    const previousCursorIndex =
      !incremental && previousCursor !== null
        ? orderedListings.findIndex((l) => l.sourceRecordId === previousCursor)
        : -1;
    const rotationOffset =
      orderedListings.length > 0
        ? (previousCursorIndex === -1 ? 0 : previousCursorIndex) % orderedListings.length
        : 0;
    const rotatedListings = [
      ...orderedListings.slice(rotationOffset),
      ...orderedListings.slice(0, rotationOffset),
    ];

    let resumeAt: string | null = null;
    let hasResumeDecision = false;
    let attemptedCount = 0;
    for (const [index, listing] of rotatedListings.entries()) {
      if (control.stopped) break;
      attemptedCount++;
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
        control,
      );
      if (control.stopped) {
        // A 200 exhausting the quota is still processed below. Resume at the
        // following item in that case; otherwise retry the rejected item.
        resumeAt =
          outcome === 'success'
            ? (rotatedListings[(index + 1) % rotatedListings.length]?.sourceRecordId ??
              listing.sourceRecordId)
            : listing.sourceRecordId;
        hasResumeDecision = true;
      }
      if (outcome !== 'success' || fetchResult === null) {
        counts.failedCount++;
        // Adversarial review (2026-09-05, round 1): a sitemap-recovered
        // candidate (see sitemapOnlyIds above) was NOT observed in this
        // run's own index walk — the sitemap carries no lastmod and can
        // retain a removed listing indefinitely (RECON_NOTES.md), so it is
        // not itself confirmation the listing still exists. Calling
        // touchSourceListingSeen unconditionally for one would bump
        // lastSeenAt and reset missingStreak on every run purely because
        // the stale sitemap kept listing it, permanently protecting a
        // genuinely-gone listing from ever closing.
        //
        // Refined (round 4): the ORIGINAL fix above skipped
        // touchSourceListingSeen for EVERY sitemap-only failure, but a
        // failure can mean two very different things — a definitive HTTP
        // 404 (the URL genuinely doesn't exist, real negative evidence) or
        // a merely TRANSIENT one (timeout, 5xx, a WAF challenge/rate-limit
        // classified 'blocked'/'retry' — no evidence either way). RECON_NOTES.md's
        // own documented pagination-shift race means a sitemap-only
        // candidate can be a perfectly live, active listing the index walk
        // simply missed by chance this run — for THAT case, a transient
        // detail-fetch failure deserves exactly the same protection an
        // ordinary index-observed listing's transient failure already gets
        // below, not the "treat as absence" the original fix gave it
        // uniformly. Only a confirmed 404 is definitive enough evidence to
        // withhold that protection — concept §6.2's "prefer an explicit
        // unknown state over an unsupported conclusion" cuts the other way
        // for anything less certain than that.
        // Refined again (round 6): status 404 alone isn't sufficient —
        // classifyHttpResult (challenge.ts) can return 'blocked' for a
        // response that happens to carry a 404 status alongside an
        // explicit WAF-challenge signal, which is evidence of a BLOCK, not
        // evidence of absence. Requiring outcome === 'failure' specifically
        // (an ordinary fetch failure, never 'blocked' or 'retry') ensures
        // only a genuinely clean 404 counts as definitive.
        const isDefinitiveSitemapOnlyAbsence =
          sitemapOnlyIds.has(listing.sourceRecordId) &&
          outcome === 'failure' &&
          fetchResult?.status === 404;
        if (!isDefinitiveSitemapOnlyAbsence) {
          await touchSourceListingSeen(db, identity, attemptedAt);
        }
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

      if (!observedIds.has(listing.sourceRecordId)) {
        observedIds.add(listing.sourceRecordId);
        counts.discoveredCount++;
        if (content.structuredAttributes.isPriority === true) counts.vipCount++;
        else counts.standardCount++;
      }
      const writeResult = await writeSourceListingRevision(db, identity, content, attemptedAt, {
        allowReopen: true,
      });
      if (writeResult.outcome === 'new') counts.newCount++;
      else if (writeResult.outcome === 'changed') counts.changedCount++;
      else if (writeResult.outcome === 'unchanged') counts.unchangedCount++;
      if (writeResult.reopened) counts.reopenedCount++;
    }

    const quarantineRate =
      listings.size > 0 ? counts.quarantinedCount / Math.max(attemptedCount, 1) : 0;
    const fetchFailureRate =
      listings.size > 0 ? counts.failedCount / Math.max(attemptedCount, 1) : 0;

    // totalCount-based completeness: stronger evidence than a fixed floor
    // since hr.ge states its own expected count on the same response
    // (RECON_NOTES.md) — but only usable when at least one page actually
    // parsed (totalCount !== null); a walk that never got past page 1
    // falls through to totalCountOk === false via the null check, which is
    // correct (no evidence of a healthy corpus at all).
    const totalCountOk =
      totalCount !== null && observedIds.size >= totalCount - maxDiscoveryShortfall;

    const lastCompletedRun = await getLastCompletedCrawlRun(db, hrGeSource.id);
    const baselineDiscoveredCount =
      lastCompletedRun !== null
        ? lastCompletedRun.discoveredCount
        : await getMaxDiscoveredCountForSource(db, hrGeSource.id, crawlRun.id);
    const baselineOk =
      baselineDiscoveredCount === 0 ||
      observedIds.size >= baselineDiscoveredCount * minRelativeCoverageRatio;

    // No VIP/standard-style per-partition collapse guard — hr.ge has no
    // structurally separate partition the way jobs.ge's .vipEntries
    // container is (RECON_NOTES.md: isPriority listings are interleaved in
    // the same ordered list, not a separate section), so there's no
    // "container silently stopped matching" failure mode analogous to
    // jobs-ge's round-5 fix to guard against. vipCount/standardCount above
    // are populated for reporting parity only.
    // A walk that resumed mid-index observed only a suffix of the corpus, so
    // it cannot certify a full sweep no matter how healthy it looks — every
    // listing on the pages before `startPage` went unobserved this run.
    // `totalCountOk` would usually catch that on its own; this states the
    // requirement directly rather than relying on a count check to imply it,
    // and it is what keeps reconciliation (which needs 'completed') away from
    // listings the run never looked at. Incremental polls are unaffected:
    // they always start at page 1 and are already excluded from closure.
    const fullIndexSweep = startPage === 1;
    const discoveryOk =
      complete &&
      fullIndexSweep &&
      (incremental || totalCountOk) &&
      quarantineRate <= maxQuarantineRate &&
      fetchFailureRate <= maxFetchFailureRate &&
      (incremental || baselineOk) &&
      !control.stopped;

    // The discovery position is written only for the two decisive outcomes
    // (a stop with covered ground behind it, or the terminator), and only
    // when it actually differs from what this run read — an unchanged value
    // would otherwise turn "never had a position" (null) into an equivalent
    // but noisier `1` on every cooldown-blocked invocation.
    if (!incremental && hasDiscoveryResumeDecision && nextDiscoveryPage !== previousDiscoveryPage) {
      await setCrawlDiscoveryPage(db, hrGeSource.id, nextDiscoveryPage, now());
    }

    // Failed/partial windows preserve progress. A known next item is saved even
    // on an interrupted run, but only a validated full sweep clears the cursor.
    if (!incremental && hasResumeDecision) {
      await setCrawlCursor(db, hrGeSource.id, resumeAt, now());
    } else if (
      !incremental &&
      discoveryOk &&
      attemptedCount === orderedListings.length &&
      counts.failedCount === 0 &&
      counts.quarantinedCount === 0
    ) {
      await setCrawlCursor(db, hrGeSource.id, null, now());
    }

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
