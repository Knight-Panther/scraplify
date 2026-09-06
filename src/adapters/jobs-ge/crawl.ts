import { createHash } from 'node:crypto';
import type { ResourceId } from '../../domain/ids.js';
import type { ResourceRole } from '../../domain/resource.js';
import type { CrawlRunStatus, FetchOutcome } from '../../domain/run.js';
import {
  type CrawlRunCounts,
  failUnsettledCrawlRun,
  extendSourceBackoff,
  getSourceBackoffUntil,
  getCrawlCursor,
  setCrawlCursor,
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
import { type FetchControl, responseBackoffUntil } from '../../net/fetch-control.js';
import { jobsGePolicy, jobsGeSource } from '../../policies/jobs-ge.js';
import { JOBS_GE_DETAIL_PARSER_VERSION, parseJobsGeDetailPage } from './detail.js';
import { type DiscoveredListing, parseAdsPage } from './discovery.js';

const ADS_PATH = '/ge/ads/';

/**
 * Safety cap on the discovery walk, not a real expectation — jobs.ge's
 * current corpus is ~19 pages (RECON_NOTES.md: 5,647 listings / ~300 per
 * page). Hitting this without the walk's own natural stop condition firing
 * first (see discoverAllListings) means discovery did not complete, so the
 * run is marked 'partial' rather than 'completed'.
 */
const MAX_DISCOVERY_PAGES = 200;

/**
 * A coarse guard against §21.3's "sudden listing-count collapse" anomaly:
 * jobs.ge's discovery walk can structurally look "complete" (a page
 * contributing zero new IDs) while actually reflecting a broken or empty
 * response rather than genuine end-of-results — an empty page 1 followed by
 * an equally-empty page 2 would otherwise satisfy discoverAllListings' stop
 * condition immediately. This is not the full semantic-failure-detection
 * system §21.3 describes (deferred, like incremental overlap), just a cheap
 * floor that keeps an obviously-broken run from being treated as full
 * coverage and driving mass closure — current real count is 5,647, more
 * than 50x this default.
 */
const DEFAULT_MIN_EXPECTED_DISCOVERED_LISTINGS = 100;

/**
 * A coarse guard against a source-wide DETAIL-parsing regression (distinct
 * from DEFAULT_MIN_EXPECTED_DISCOVERED_LISTINGS, which only covers
 * discovery-page health): discovery succeeding while a large share of
 * discovered listings quarantine on parse is itself evidence this run's
 * results aren't trustworthy enough to drive closure, even though
 * individual listings quarantining is routine and expected (concept
 * §21.3/§26: "anomalous crawls must not advance missing streaks";
 * adversarial review, 2026-09-05, round 3). 10% tolerates ordinary
 * per-listing noise across a real ~5,647-listing corpus while catching a
 * genuine site-wide template break, which would push this far higher.
 */
const DEFAULT_MAX_QUARANTINE_RATE = 0.1;

/**
 * A coarse guard against systemic detail-FETCH failure (distinct from
 * DEFAULT_MAX_QUARANTINE_RATE, which only covers parse failures on
 * successfully-fetched pages): discovery succeeding while most or all
 * detail fetches fail (timeouts, 403/429, an SSRF/policy block) is itself
 * evidence this run acquired no real content, even though quarantineRate
 * stays 0 — nothing got fetched to parse, so nothing threw (adversarial
 * review, 2026-09-05, round 9; a re-raise of a round-4 idea this project
 * originally logged and deliberately skipped as P2 — see docs/STATUS.md —
 * now taken because a different review pass re-flagged it and the fix is
 * this cheap). Looser than the 10% quarantine ceiling: a fetch failure is
 * expected to be transient and self-healing (network blips, rate limits)
 * where a parse failure is evidence of an actual template break — too
 * tight a ceiling here would make 'partial' sticky on an ordinary flaky
 * day, which silently stops closure forever (a worse failure than the one
 * this guard exists to catch). 50% targets systemic acquisition failure
 * (a ban/WAF/policy-block), the anomaly concept §21.3 actually names, not
 * ordinary noise. Does NOT gate closure via discoveryOk's other purpose —
 * touchSourceListingSeen already protects every fetch-failed listing from
 * looking missing regardless of this guard, so tripping it only affects
 * `status`/whether reconciliation runs at all, never listing correctness.
 */
const DEFAULT_MAX_FETCH_FAILURE_RATE = 0.5;

/**
 * A guard against a RELATIVE count collapse, compared against this
 * source's own history rather than a fixed floor: DEFAULT_MIN_EXPECTED_DISCOVERED_LISTINGS
 * and the confirmation probe (see discoverAllListings) still can't rule out
 * a systemic pagination/caching regression that serves identical content
 * at every page number queried, including the distant probe — e.g. the
 * same 100-300 listings on every request, which would clear the fixed
 * floor easily while the real ~5,647-listing corpus has effectively
 * collapsed (adversarial review, 2026-09-05, round 4). 50% tolerates
 * ordinary day-to-day churn while catching a genuine collapse. Skipped
 * entirely (never blocks) when this source has no prior 'completed' run to
 * compare against — a source's first-ever run has no baseline to judge by.
 */
const DEFAULT_MIN_RELATIVE_COVERAGE_RATIO = 0.5;

/**
 * Project decision (2026-09-04, docs/STATUS.md): 3 consecutive misses before
 * closure. Concept §13 requires the first miss to become `missing_suspected`,
 * never `closed`, which rules out the reconciliation module's own minimum of
 * 2 — 3 gives one extra confirming run of margin before acting on an absence.
 */
export const DEFAULT_MISSING_STREAK_THRESHOLD = 3;

export interface RunJobsGeCrawlDeps {
  db: Database;
  httpFetcher: HttpFetcher;
  /** Injectable clock, defaults to the real wall clock. Tests supply a fixed/advancing one for determinism. */
  now?: () => string;
}

export interface RunJobsGeCrawlOptions {
  /** concept §13: "missing across the configured number of complete successful reconciliations." Must be >= 2 — see reconcile-source-listings.ts. */
  missingStreakThreshold: number;
  /**
   * 'full' (the default) walks the entire corpus. 'incremental' stops after
   * `incrementalPages` index pages — concept §19.2's cadence table calls for
   * "jobs.ge lightweight discovery" every 30–60 minutes, which a full walk
   * cannot satisfy: at ~5,647 listings and robots.txt's mandated 5s crawl
   * delay at concurrency 1, one full walk is ~5,666 requests / ~7.9 hours.
   *
   * This is bounded recent-page polling, exactly as hr.ge's own incremental
   * mode is (src/adapters/hr-ge/crawl.ts) — NOT §10.1's adaptive rolling
   * overlap window against a high-water mark, which stays deferred (§28).
   * The invariants are the same as hr.ge's and are what make it safe: the
   * run records `fullCoverage=false`, so `closeMissingListings` refuses it
   * and no missing streak can advance off a deliberately partial view; the
   * full walk's own cursor is neither consumed nor overwritten; and the
   * whole-corpus health guards are skipped rather than failed, since a
   * one-page slice legitimately looks like a catastrophic collapse next to a
   * full-run baseline.
   */
  mode?: 'full' | 'incremental';
  /** Index pages to cover in 'incremental' mode. Defaults to 2, matching hr.ge. Ignored in 'full' mode. */
  incrementalPages?: number;
  /** See DEFAULT_MIN_EXPECTED_DISCOVERED_LISTINGS. Overridable for testing; production callers should rarely need to. */
  minExpectedDiscoveredListings?: number;
  /** See DEFAULT_MAX_QUARANTINE_RATE. Overridable for testing; production callers should rarely need to. */
  maxQuarantineRate?: number;
  /** See DEFAULT_MAX_FETCH_FAILURE_RATE. Overridable for testing; production callers should rarely need to. */
  maxFetchFailureRate?: number;
  /** See DEFAULT_MIN_RELATIVE_COVERAGE_RATIO. Overridable for testing; production callers should rarely need to. */
  minRelativeCoverageRatio?: number;
}

export interface RunJobsGeCrawlResult {
  crawlRun: CrawlRunRow;
}

/**
 * Idempotently ensures jobs.ge's `sources`/`source_policies` rows exist —
 * nothing in this codebase has ever inserted them before now (every prior
 * DB test used a throwaway random-UUID source instead), but every write
 * this crawl makes (resources, source_listings, crawl_runs) has a NOT NULL
 * FK to `sources.id`, so the real jobsGeSource.id row must exist first.
 * Safe to call on every run: onConflictDoNothing makes this a no-op after
 * the first time.
 */
export async function ensureJobsGeSourceSeeded(db: Database): Promise<void> {
  await db
    .insert(sources)
    .values({
      id: jobsGeSource.id,
      slug: jobsGeSource.slug,
      displayName: jobsGeSource.displayName,
      baseUrl: jobsGeSource.baseUrl,
    })
    .onConflictDoNothing();

  await db
    .insert(sourcePoliciesTable)
    .values({
      id: jobsGePolicy.id,
      sourceId: jobsGePolicy.sourceId,
      policyVersion: jobsGePolicy.policyVersion,
      allowedAcquisitionModes: jobsGePolicy.allowedAcquisitionModes,
      allowedPathPatterns: jobsGePolicy.allowedPathPatterns,
      disallowedPathPatterns: jobsGePolicy.disallowedPathPatterns,
      disallowedHosts: jobsGePolicy.disallowedHosts,
      allowedHosts: jobsGePolicy.allowedHosts,
      authenticationScope: jobsGePolicy.authenticationScope,
      rateLimit: jobsGePolicy.rateLimit,
      termsUrl: jobsGePolicy.termsUrl,
      robotsUrl: jobsGePolicy.robotsUrl,
      retention: jobsGePolicy.retention,
      display: jobsGePolicy.display,
      linkedResources: jobsGePolicy.linkedResources,
      reviewDate: jobsGePolicy.reviewDate,
      evidence: jobsGePolicy.evidence,
      notes: jobsGePolicy.notes,
      decisionOwner: jobsGePolicy.decisionOwner,
    })
    .onConflictDoNothing();
}

function buildAdsPageUrl(page: number): string {
  const url = new URL(ADS_PATH, jobsGeSource.baseUrl);
  url.searchParams.set('page', String(page));
  return url.toString();
}

function classifyOutcome(error: unknown, result: HttpFetchResult | null): FetchOutcome {
  if (error instanceof UrlNotAllowedError || error instanceof SsrfBlockedError) return 'blocked';
  if (error !== null) return 'failure';
  if (result === null) return 'failure';
  if (
    result.status === 403 ||
    result.status === 202 ||
    result.headers['x-amzn-waf-action'] !== undefined
  )
    return 'blocked';
  if (result.status === 429) return 'retry';
  return result.status === 200 ? 'success' : 'failure';
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

/**
 * Fetches one URL and unconditionally records the attempt — a resource row
 * (upsertResource) plus a fetch_attempts row — regardless of outcome, so
 * every fetch this crawl makes is accounted for per concept §21.1, not just
 * the successful ones.
 */
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
    await extendSourceBackoff(db, jobsGeSource.id, backoffUntil, attemptedAt);
  const succeeded = outcome === 'success' && fetchResult !== null;

  const resource = await upsertResource(db, {
    sourceId: jobsGeSource.id,
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
  /** True only if the walk reached its own natural stop (see below) rather than a fetch failure or the MAX_DISCOVERY_PAGES safety cap. */
  complete: boolean;
}

function idSet(listing: readonly DiscoveredListing[]): Set<string> {
  return new Set(listing.map((l) => l.sourceRecordId));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * How far past a candidate clamp page to probe for confirmation — see
 * discoverAllListings. RECON_NOTES.md confirmed jobs.ge returns identical
 * content not just at the immediate next page but at several far-apart
 * out-of-range page numbers (19's content repeated at 20, 21, AND 50), so a
 * fixed jump well within that confirmed range is real, evidenced behavior,
 * not an arbitrary guess.
 */
export const CLAMP_CONFIRMATION_PROBE_OFFSET = 20;

/**
 * Fetches `page` and returns its parsed listing ID set, or null if the
 * fetch itself failed — used both by the main walk and by the clamp
 * confirmation probe below, which needs the exact same fetch-and-parse
 * step but must never let its own failure be mistaken for "walk failed."
 */
async function fetchPageIds(
  db: Database,
  httpFetcher: HttpFetcher,
  crawlRun: CrawlRunRow,
  now: () => string,
  page: number,
  control: FetchControl,
): Promise<{ ids: Set<string>; listings: DiscoveredListing[] } | null> {
  if (control.stopped) return null;
  const url = buildAdsPageUrl(page);
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
  if (outcome !== 'success' || fetchResult === null) return null;

  const parsed = parseAdsPage(fetchResult.body);
  const pageListings = [...parsed.vip, ...parsed.standard];
  return { ids: idSet(pageListings), listings: pageListings };
}

/**
 * Walks `/ge/ads/?page=N` from page 1, merging VIP and standard partitions
 * into one map keyed by sourceRecordId (VIP recurs identically across
 * pages per RECON_NOTES.md — the map absorbs that naturally). A candidate
 * stop fires when a page's own ID set is non-empty AND exactly equal to the
 * immediately preceding page's — jobs.ge clamps out-of-range page numbers
 * to the last real page rather than erroring, so a genuine last page is
 * followed by byte-for-byte identical repeats (RECON_NOTES.md), which this
 * detects directly rather than inferring from "zero new IDs against
 * everything accumulated so far" (an earlier version of this function;
 * comparing against the cumulative map would treat a single broken or
 * empty response mid-corpus as a legitimate stop too).
 *
 * That candidate is NOT trusted on its own: a single repeated response
 * could also be a transient cache/proxy glitch serving the previous page's
 * content again, rather than genuine terminal pagination (adversarial
 * review, 2026-09-05, round 3) — with a 100-listing floor, a coincidence on
 * page 1 vs. a duplicate page 2 would already clear it, yet only reflect a
 * tiny fraction of the real corpus. So a candidate stop is CONFIRMED by an
 * independent probe at `page + CLAMP_CONFIRMATION_PROBE_OFFSET`: only if
 * that far-apart page's content ALSO matches does this declare `complete`.
 * If the probe fails or disagrees, the candidate is treated as a fluke and
 * the walk resumes normally from the next page — false negatives (walking
 * further than strictly needed) are the safe direction to err in here, not
 * false positives.
 */
async function discoverAllListings(
  db: Database,
  httpFetcher: HttpFetcher,
  crawlRun: CrawlRunRow,
  now: () => string,
  control: FetchControl,
  incrementalPages: number | null,
): Promise<DiscoverAllListingsResult> {
  const listings = new Map<string, DiscoveredListing>();
  let complete = false;
  let previousPageIds: Set<string> | null = null;
  const lastPage = incrementalPages ?? MAX_DISCOVERY_PAGES;

  for (let page = 1; page <= lastPage && !control.stopped; page++) {
    const fetched = await fetchPageIds(db, httpFetcher, crawlRun, now, page, control);
    if (fetched === null) break;
    const { ids: pageIds, listings: pageListings } = fetched;

    if (pageIds.size > 0 && previousPageIds !== null && setsEqual(pageIds, previousPageIds)) {
      const probe = await fetchPageIds(
        db,
        httpFetcher,
        crawlRun,
        now,
        page + CLAMP_CONFIRMATION_PROBE_OFFSET,
        control,
      );
      if (probe !== null && setsEqual(probe.ids, pageIds)) {
        complete = true;
        break;
      }
      // Unconfirmed — a fluke, not the real clamp. Fall through and keep walking.
    }

    for (const listing of pageListings) {
      listings.set(listing.sourceRecordId, listing);
    }
    previousPageIds = pageIds;

    // Exhausting a deliberately bounded page budget is this walk reaching
    // its own intended stop, not a truncation — so it sets `complete` the
    // same way the confirmed clamp above does. That only ever means "this
    // walk covered what it set out to cover"; it says nothing about whole-
    // corpus coverage, which is carried separately by the run's
    // `fullCoverage=false` and is what actually gates closure.
    if (incrementalPages !== null && page === incrementalPages) complete = true;
  }

  return { listings, complete };
}

/**
 * Runs one full jobs.ge crawl: discovers the entire listing space, fetches
 * and parses every listing's detail page, writes revisions, then reconciles
 * missing/expired listings. Every fetch (discovery pages and detail pages
 * alike) is recorded as a resource + fetch attempt regardless of outcome.
 *
 * `fullCoverage` is set from the run's MODE at crawl-run start: true for a
 * full-corpus walk, false for a bounded incremental poll (see
 * RunJobsGeCrawlOptions.mode). Whether a full walk actually succeeded is a
 * separate question, decided by `status` after it completes (or doesn't) —
 * reconcile-source-listings.ts's closeMissingListings requires both to
 * proceed, so an incomplete discovery walk (a failed page fetch, the
 * MAX_DISCOVERY_PAGES safety cap, or too few listings found — see
 * DEFAULT_MIN_EXPECTED_DISCOVERED_LISTINGS) naturally leaves the run
 * ineligible for closure without needing its own separate check here. An
 * incremental run is ineligible on the coverage flag alone, whatever its
 * status — which is why bounded polling cannot advance a missing streak
 * even when it finishes perfectly cleanly.
 *
 * §10.1's adaptive rolling-overlap-window optimization remains deferred
 * (§28, docs/STATUS.md); incremental mode here is fixed-page polling only.
 *
 * A per-listing fetch or parse failure never aborts the whole run — one bad
 * detail page is routine, not catastrophic (concept §21.3 distinguishes
 * this from a run-level anomaly) — but the two are tracked distinctly, per
 * concept §26's "parse failures are typed and quarantined" acceptance
 * criterion: a FETCH failure (network/HTTP-level, transient) increments
 * failedCount and calls touchSourceListingSeen (still present in
 * discovery, just couldn't be refetched this time); a PARSE failure (the
 * fetch succeeded, but our parser couldn't extract the content — a
 * markup/template mismatch, a real parser-health signal) increments
 * quarantinedCount, quarantines both the listing and its resource, and
 * records a typed parser_incidents row instead. An unexpected error from
 * the DB write path itself (writeSourceListingRevision, or
 * fetchAndRecord's own bookkeeping calls) is NOT swallowed the same way —
 * it aborts the run (marked 'failed') and rethrows, since continuing after
 * a bookkeeping failure would likely just produce more inconsistent state.
 *
 * finishCrawlRun is called twice: once to persist 'completed'/'partial'
 * status (with missing/expired still 0) so closeMissingListings can read an
 * authoritative, already-committed crawl_runs row rather than a
 * caller-supplied claim about this run's own completeness (adversarial
 * review, 2026-09-04 — see reconcile-source-listings.ts), then again with
 * the real reconciliation counts patched in.
 */
export async function runJobsGeCrawl(
  deps: RunJobsGeCrawlDeps,
  options: RunJobsGeCrawlOptions,
): Promise<RunJobsGeCrawlResult> {
  const { db, httpFetcher } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const minExpectedDiscoveredListings =
    options.minExpectedDiscoveredListings ?? DEFAULT_MIN_EXPECTED_DISCOVERED_LISTINGS;
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

  await ensureJobsGeSourceSeeded(db);

  const startedAt = now();
  const crawlRun = await startCrawlRun(db, {
    sourceId: jobsGeSource.id,
    startedAt,
    // The single most important line in bounded mode: a partial view of the
    // corpus must never be recorded as full coverage, because that flag is
    // exactly what closeMissingListings reads to decide whether absence is
    // real. With it false, every listing outside this slice is simply not
    // considered, rather than counted as missing.
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
    // Read but deliberately not applied in incremental mode: the cursor is
    // the full walk's own position through the whole corpus, and rotating a
    // one-page slice by it would be meaningless. Incremental polling neither
    // consumes nor advances it (see the cursor write below) — matching
    // hr.ge, so a bounded poll can never cost the full walk its progress.
    const previousCursor = incremental ? null : await getCrawlCursor(db, jobsGeSource.id);
    const backoffUntil = await getSourceBackoffUntil(db, jobsGeSource.id);
    const control: FetchControl = {
      stopped: backoffUntil !== null && Date.parse(backoffUntil) > Date.parse(now()),
    };
    const { listings, complete } = await discoverAllListings(
      db,
      httpFetcher,
      crawlRun,
      now,
      control,
      incrementalPages,
    );
    counts.discoveredCount = listings.size;
    // Tracked separately per concept §26 ("VIP and standard sections are
    // measured separately") — also what the VIP/standard health guards
    // below need, since a combined-total collapse check alone can't see a
    // ~10-row VIP wipeout inside a ~5,647-row total (adversarial review,
    // 2026-09-05, round 5).
    for (const listing of listings.values()) {
      if (listing.partition === 'vip') counts.vipCount++;
      else counts.standardCount++;
    }

    const orderedListings = [...listings.values()];
    const cursorIndex = orderedListings.findIndex(
      (listing) => listing.sourceRecordId === previousCursor,
    );
    const offset = Math.max(0, cursorIndex);
    const rotatedListings = [...orderedListings.slice(offset), ...orderedListings.slice(0, offset)];
    let resumeAt: string | null = null;
    let hasResumeDecision = false;
    for (const [index, listing] of rotatedListings.entries()) {
      if (control.stopped) break;
      const identity = {
        sourceId: jobsGeSource.id,
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
        resumeAt =
          outcome === 'success'
            ? (rotatedListings[(index + 1) % rotatedListings.length]?.sourceRecordId ??
              listing.sourceRecordId)
            : listing.sourceRecordId;
        hasResumeDecision = true;
      }
      if (outcome !== 'success' || fetchResult === null) {
        counts.failedCount++;
        // Still present in discovery even though the detail fetch failed —
        // must not look "missing" to closeMissingListings, which only has
        // lastSeenAt to go on (adversarial review, 2026-09-05).
        await touchSourceListingSeen(db, identity, attemptedAt);
        continue;
      }

      let content: ReturnType<typeof parseJobsGeDetailPage>;
      try {
        content = parseJobsGeDetailPage({
          html: fetchResult.body,
          extractionMethod: 'http',
          provenance: {
            resourceId: resource.id as ResourceId,
            fetchedAt: attemptedAt,
            notes: null,
          },
        });
      } catch (parseError) {
        counts.quarantinedCount++;
        // Fetch succeeded (real bytes were retrieved) but parsing failed —
        // a markup/template mismatch, not a network blip. concept §26's
        // acceptance criteria require parse failures to be "typed and
        // quarantined," not folded into an ordinary failedCount
        // (adversarial review, 2026-09-05): quarantine the listing itself
        // (excluding it from touchSourceListingSeen/closeMissingListings'
        // status transitions, though NOT from writeSourceListingRevision's
        // allowReopen path below — a later successful re-parse is exactly
        // the evidence this was transient, round 8), the resource (bytes
        // were fetched fine, only extraction failed), and record a typed
        // incident a human or future supervised-repair process can act on.
        await quarantineSourceListing(db, identity, attemptedAt);
        await upsertResource(db, {
          sourceId: jobsGeSource.id,
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
          sourceId: jobsGeSource.id,
          crawlRunId: crawlRun.id,
          detectedAt: attemptedAt,
          kind: 'field_missing',
          severity: 'warning',
          evidence: {
            sourceRecordId: listing.sourceRecordId,
            url: listing.url,
            resourceId: resource.id,
            parserVersion: JOBS_GE_DETAIL_PARSER_VERSION,
            error: parseError instanceof Error ? parseError.message : String(parseError),
          },
        });
        continue;
      }

      // allowReopen: a successful, non-stale re-fetch and re-parse within a
      // full discovery walk IS the confirmed-reappearance evidence
      // write-source-listing-revision.ts requires before reactivating a
      // closed/expired listing (concept §13; adversarial review, 2026-09-05).
      const writeResult = await writeSourceListingRevision(db, identity, content, attemptedAt, {
        allowReopen: true,
      });
      if (writeResult.outcome === 'new') counts.newCount++;
      else if (writeResult.outcome === 'changed') counts.changedCount++;
      else if (writeResult.outcome === 'unchanged') counts.unchangedCount++;
      // 'stale' isn't bucketed here — see write-source-listing-revision.ts;
      // it shouldn't occur within one sequential, single-writer run.
      if (writeResult.reopened) counts.reopenedCount++;
    }

    // Computed only after every listing has been processed — quarantineRate
    // needs the final quarantinedCount, so this can't be decided right
    // after discovery the way discoveredCount/complete alone could be
    // (adversarial review, 2026-09-05, round 3).
    const quarantineRate = listings.size > 0 ? counts.quarantinedCount / listings.size : 0;
    // Same denominator, same zero-guard, computed alongside quarantineRate
    // for the same reason: needs the final failedCount, so can't be decided
    // right after discovery (adversarial review, 2026-09-05, round 9).
    const fetchFailureRate = listings.size > 0 ? counts.failedCount / listings.size : 0;

    // A systemic pagination/caching regression that serves identical
    // content at every page number queried (including the distant
    // confirmation probe) can still clear `complete`, the fixed floor, and
    // the quarantine-rate check — none of them know what this source's
    // corpus is actually supposed to look like. Comparing against its own
    // last completed run's discoveredCount does (adversarial review,
    // 2026-09-05, round 4).
    const lastCompletedRun = await getLastCompletedCrawlRun(db, jobsGeSource.id);
    // `lastCompletedRun === null` means "no run has ever earned 'completed'
    // status," NOT "no history exists" — a prior `partial` run (e.g.
    // discovery succeeded fully but a detail-fetch storm made that run
    // partial) can still have persisted a real discoveredCount. Treating
    // null as "never blocks" let a severely truncated crawl certify itself
    // as this source's first 'completed' run and become the baseline for
    // every later comparison (adversarial review, 2026-09-05, round 10).
    // Falling back to the max full-coverage discoveredCount ever observed
    // (any status) closes that gap while still never blocking a genuinely
    // first-ever run, which has no prior full-coverage row at all and gets
    // 0 back — same "never blocks" outcome round 4 originally decided on.
    const baselineDiscoveredCount =
      lastCompletedRun !== null
        ? lastCompletedRun.discoveredCount
        : await getMaxDiscoveredCountForSource(db, jobsGeSource.id, crawlRun.id);
    const baselineOk =
      baselineDiscoveredCount === 0 ||
      listings.size >= baselineDiscoveredCount * minRelativeCoverageRatio;

    // The combined-total baseline above can't see a single partition going
    // to zero — VIP is only ~10 of a ~5,647-listing corpus, so losing it
    // entirely (e.g. the `.vipEntries` selector silently stops matching)
    // barely moves the total and would sail past both the fixed floor and
    // the relative-collapse ratio. A plain floor on VIP isn't right either:
    // a legitimately VIP-less run (no one currently has a promoted slot) is
    // a real, non-anomalous state, not distinguishable from "the parser
    // broke" without something to compare against. So this only fires when
    // the LAST completed run itself had a non-zero count for that
    // partition and this run doesn't — "went from something to nothing,"
    // not "is currently small or zero" (adversarial review, 2026-09-05,
    // round 5).
    const vipOk =
      lastCompletedRun === null || lastCompletedRun.vipCount === 0 || counts.vipCount > 0;
    const standardOk =
      lastCompletedRun === null || lastCompletedRun.standardCount === 0 || counts.standardCount > 0;

    // The whole-corpus guards (the fixed floor, the relative-coverage
    // baseline, and the per-partition collapse checks) are skipped in
    // incremental mode rather than merely passed: all three ask "does this
    // run look like the whole corpus?", and a deliberately bounded slice
    // correctly does not. A one-page run's ~310 listings against a ~5,647
    // baseline is a 0.05 ratio — it would fail baselineOk every time and
    // never certify, which would make bounded mode useless rather than safe.
    // The guards that still apply are the ones about THIS slice's own health:
    // parse quarantine rate, fetch failure rate, whether the walk reached its
    // intended stop, and whether a source-wide stop signal fired.
    const discoveryOk =
      complete &&
      (incremental || listings.size >= minExpectedDiscoveredListings) &&
      quarantineRate <= maxQuarantineRate &&
      fetchFailureRate <= maxFetchFailureRate &&
      (incremental || baselineOk) &&
      (incremental || vipOk) &&
      (incremental || standardOk) &&
      !control.stopped;

    // Incremental polls leave both cursor branches alone entirely. Writing
    // a resume point from a bounded slice would strand the full walk partway
    // through a corpus this run never looked at, and clearing the cursor
    // would falsely claim a healthy full sweep had happened.
    if (!incremental) {
      if (hasResumeDecision) {
        await setCrawlCursor(db, jobsGeSource.id, resumeAt, now());
      } else if (discoveryOk && counts.failedCount === 0 && counts.quarantinedCount === 0) {
        await setCrawlCursor(db, jobsGeSource.id, null, now());
      }
    }

    const finishedAt = now();
    const runStatus: CrawlRunStatus = discoveryOk ? 'completed' : 'partial';

    // Settlement — the terminal status write, expiry, missing-reconciliation,
    // final counts, and the reconciledAt write that releases the exclusivity
    // lock — all happen in ONE transaction (adversarial review, 2026-09-05,
    // round 9): previously these were separate autocommitted steps, so a
    // crash or transient DB failure between them could leave listings closed
    // while the run itself stayed unsettled (reconciledAt still null), or
    // let the catch block below relabel an already-reconciled run 'failed'.
    // Building settledCounts as a NEW local object rather than mutating the
    // outer `counts` matters here specifically: if this transaction rolls
    // back, the catch block below still uses the outer `counts` to mark the
    // run 'failed' — it must never report expiry/closure that the database
    // itself rolled back.
    const finalRun = await db.transaction(async (tx) => {
      // reconciledAt deliberately omitted here — the row's exclusivity lock
      // (src/db/schema/runs.ts's partial unique index keys on reconciledAt,
      // not status) must stay held through reconciliation below, or another
      // invocation could start in this exact window and race it (adversarial
      // review, 2026-09-05, round 6). status is set now so
      // closeMissingListingsInTransaction can read this persisted terminal
      // value — including its own, not-yet-committed write within this same
      // transaction, which is fine: eligibility still comes from the
      // database's own record, never a caller-supplied claim.
      await finishCrawlRun(tx, crawlRun.id, { finishedAt, status: runStatus, counts });

      const expireResult = await expireOverdueListings(tx, {
        sourceId: jobsGeSource.id,
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

      // reconciledAt set here, once reconciliation has actually committed —
      // this is what finally releases the exclusivity lock.
      return finishCrawlRun(tx, crawlRun.id, {
        finishedAt,
        status: runStatus,
        counts: settledCounts,
        reconciledAt: finishedAt,
      });
    });
    return { crawlRun: finalRun };
  } catch (err) {
    // A 'failed' run never reaches reconciliation and never will — nothing
    // to hold the lock for, so it's released immediately rather than left
    // stuck (matching the existing documented stance on stale locks: a
    // clean 'failed' marking is exactly what's supposed to let a future
    // run proceed). Conditional on reconciledAt still being null (not a
    // plain finishCrawlRun call) — the settlement transaction above can
    // ambiguously fail: PostgreSQL commits (expiry, closure, counts,
    // reconciledAt all persisted) but the client never receives the COMMIT
    // acknowledgment, so db.transaction still throws here even though the
    // run already genuinely settled (adversarial review, 2026-09-05, round
    // 10). Unconditionally overwriting that row would relabel an
    // already-reconciled run 'failed' with stale pre-settlement counts —
    // failUnsettledCrawlRun's own no-op-if-already-settled result is
    // deliberately not inspected further: a null return means the row is
    // already authoritative, and is left exactly as settlement wrote it.
    await failUnsettledCrawlRun(db, crawlRun.id, {
      finishedAt: now(),
      counts,
      reconciledAt: now(),
    });
    throw err;
  }
}
