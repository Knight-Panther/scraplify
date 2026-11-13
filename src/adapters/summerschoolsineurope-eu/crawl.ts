import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  type CrawlRunCounts,
  extendSourceBackoff,
  failUnsettledCrawlRun,
  finishCrawlRun,
  getSourceBackoffUntil,
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
  crawlRuns,
  resources,
  sourceListingRevisions,
  sourceListings,
  sources,
} from '../../db/schema/index.js';
import { type SyncSourcePolicyResult, syncSourcePolicy } from '../../db/source-policies.js';
import type { Database, DatabaseOrTransaction } from '../../db/types.js';
import {
  quarantineSourceListing,
  touchSourceListingSeen,
  writeSourceListingRevision,
} from '../../db/write-source-listing-revision.js';
import type { ResourceId } from '../../domain/ids.js';
import type { ResourceRole } from '../../domain/resource.js';
import type { CrawlRunStatus, FetchOutcome } from '../../domain/run.js';
import { type FetchControl, responseBackoffUntil } from '../../net/fetch-control.js';
import {
  type HttpFetcher,
  type HttpFetchResult,
  SsrfBlockedError,
  UrlNotAllowedError,
} from '../../net/http-fetcher.js';
import {
  isListingFacetValueAllowed,
  isSummerSchoolsEuUrlAllowed,
  LISTING_STATUS_PARAM,
  LISTING_STATUS_VALUE,
  summerSchoolsEuPolicy,
  summerSchoolsEuSource,
} from '../../policies/summerschoolsineurope-eu.js';
import { PolicyRevisionSupersededError, withPolicyRevalidation } from '../policy-revalidation.js';
import {
  type KnownListing,
  loadKnownListings,
  needsDetailFetch,
  setDiscoveryFingerprint,
} from '../refetch.js';
import { recordRunAnomalies } from '../run-anomalies.js';
import {
  type CourseAttributes,
  parseCoursePage,
  SUMMER_SCHOOLS_DETAIL_PARSER_VERSION,
} from './detail.js';
import {
  type CourseCard,
  cardFingerprint,
  type ParsedListingPage,
  parseListingPage,
} from './listing.js';
import { parseCourseSitemap, parseSitemapIndex, sitemapsChangedSince } from './sitemap.js';
import { coverListing, type Filters } from './walk.js';

/** Courses on one listing page. */
const PAGE_CAPACITY = 12;
/** Requests for one listing page or sitemap before it counts as failed (one timeout must not end a walk). */
const INDEX_ATTEMPTS = 3;
const DEFAULT_MAX_LISTING_REQUESTS = 400;
const DEFAULT_MAX_DETAIL_FETCHES = 700;
const DEFAULT_MAX_QUARANTINE_RATE = 0.1;
const DEFAULT_MAX_FETCH_FAILURE_RATE = 0.5;
/** A course missing from this many complete walks in a row closes (choice C). */
export const MISSING_STREAK_THRESHOLD = 3;
/** Sitemaps whose index date is newer than the last completed run, less this overlap, are read. */
const SITEMAP_OVERLAP_MS = 2 * 24 * 60 * 60 * 1000;
/** After a 403 or a Cloudflare challenge the source rests this long; the next scheduled run is a day away. */
const CHALLENGE_BACKOFF_MS = 6 * 60 * 60 * 1000;
/**
 * Kinsta's page cache keeps a page up to 2 h (`s-maxage=7200`), so a read
 * that soon after a change may have been the old page: the sitemap trigger
 * counts a read as this much earlier than it was.
 */
const PAGE_CACHE_MS = 2 * 60 * 60 * 1000;
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;
const OPEN_STATUSES = ['active', 'missing_suspected'] as const;

export interface RunSummerSchoolsCrawlDeps {
  db: Database;
  httpFetcher: HttpFetcher;
  now?: () => string;
}

export interface RunSummerSchoolsCrawlOptions {
  /** 'all' fetches every listed course page, for use after a parser change. */
  refetch?: 'changed' | 'all';
  /** 'all' reads every course sitemap, not just those dated after the last completed run. */
  sitemaps?: 'changed' | 'all';
  maxListingRequests?: number;
  maxDetailFetches?: number;
  maxQuarantineRate?: number;
  maxFetchFailureRate?: number;
  /** The reviewed override of the mass-closure cap (reconcile-source-listings.ts). */
  allowMassClosure?: boolean;
}

export interface SummerSchoolsRunStats {
  listingRequests: number;
  resultSets: number;
  resamples: number;
  rootTotal: number | null;
  coursesSeen: number;
  uncovered: number;
  sitemapRequests: number;
  sitemapEntries: number;
  detailFetches: number;
  fetchedNew: number;
  fetchedCardChanged: number;
  fetchedSitemapChanged: number;
  fetchedRefetchAll: number;
  stickyDeadlines: number;
  notFound: number;
  /** Course pages not asked for because the policy refuses their URL. */
  refusedUrls: number;
  startedClosed: number;
}

export interface RunSummerSchoolsCrawlResult {
  crawlRun: CrawlRunRow;
  stats: SummerSchoolsRunStats;
}

/** Seeds the source row and syncs the policy, as every adapter does. */
export async function ensureSummerSchoolsEuSourceSeeded(
  db: Database,
): Promise<SyncSourcePolicyResult> {
  await db
    .insert(sources)
    .values({
      id: summerSchoolsEuSource.id,
      slug: summerSchoolsEuSource.slug,
      displayName: summerSchoolsEuSource.displayName,
      baseUrl: summerSchoolsEuSource.baseUrl,
    })
    .onConflictDoNothing();
  return await syncSourcePolicy(db, summerSchoolsEuPolicy);
}

/** The upcoming-course listing filtered by `filters`, the upcoming filter first, values OR-ed. */
export function listingUrl(filters: Filters): string {
  const url = new URL('/courses/', summerSchoolsEuSource.baseUrl);
  const params = new URLSearchParams([[LISTING_STATUS_PARAM, LISTING_STATUS_VALUE]]);
  for (const [facet, values] of filters) params.append(`_${facet}`, values.join(','));
  url.search = params.toString();
  return url.toString();
}

function header(result: HttpFetchResult, name: string): string | undefined {
  const value = result.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A Cloudflare challenge (`cf-mitigated`), a 403 and its kin are a block, a
 * 429 or 503 a request to slow down: both stop the run (docs/PHASE_15_PLAN.md,
 * "Cloudflare: staying unblocked"). A 404 is an answer, read by the caller.
 */
function classifyOutcome(error: unknown, result: HttpFetchResult | null): FetchOutcome {
  if (error instanceof UrlNotAllowedError || error instanceof SsrfBlockedError) return 'blocked';
  if (error !== null || result === null) return 'failure';
  if (header(result, 'cf-mitigated') !== undefined) return 'blocked';
  if (result.status === 403 || result.status === 202 || result.status === 405) return 'blocked';
  if (result.status === 429 || result.status === 503) return 'retry';
  if (result.status === 200 || result.status === 404) return 'success';
  return 'failure';
}

function describeError(error: unknown, result: HttpFetchResult | null): string | null {
  if (error instanceof Error) return error.name;
  if (error !== null) return 'unknown_error';
  if (result !== null && result.status !== 200) return `http_${result.status}`;
  return null;
}

function extractMimeType(headers: HttpFetchResult['headers']): string | null {
  const raw = headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.split(';')[0]?.trim() || null;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** The Tbilisi calendar day of an instant, `YYYY-MM-DD`. */
function tbilisiDay(instant: string): string {
  return new Date(Date.parse(instant) + TBILISI_OFFSET_MS).toISOString().slice(0, 10);
}

interface Fetched {
  outcome: FetchOutcome;
  resourceId: string;
  result: HttpFetchResult | null;
}

/** One request, always recorded as a resource plus a fetch attempt (concept §21.1). */
async function fetchAndRecord(
  db: Database,
  httpFetcher: HttpFetcher,
  crawlRunId: string,
  role: ResourceRole,
  url: string,
  attemptedAt: string,
  control: FetchControl,
): Promise<Fetched> {
  const startedAtMs = Date.now();
  let result: HttpFetchResult | null = null;
  let caught: unknown = null;
  try {
    result = await httpFetcher.fetch(url);
  } catch (err) {
    if (err instanceof PolicyRevisionSupersededError) throw err;
    caught = err;
  }
  const durationMs = Date.now() - startedAtMs;
  const outcome = classifyOutcome(caught, result);
  const observedAt = new Date(Date.parse(attemptedAt) + durationMs).toISOString();
  let backoffUntil = result === null ? null : responseBackoffUntil(result, observedAt);
  if (outcome === 'blocked' && result !== null) {
    const rest = new Date(Date.parse(observedAt) + CHALLENGE_BACKOFF_MS).toISOString();
    backoffUntil = backoffUntil === null || backoffUntil < rest ? rest : backoffUntil;
  }
  // The site blocking or slowing us stops the run. A URL this crawler would
  // not send (outside the allow-list, or resolving to a private address)
  // never reached the site: that is the one URL's failure, not a block.
  const siteRefused = (outcome === 'blocked' || outcome === 'retry') && result !== null;
  if (siteRefused || backoffUntil !== null) control.stopped = true;
  if (backoffUntil !== null) {
    await extendSourceBackoff(db, summerSchoolsEuSource.id, backoffUntil, attemptedAt);
  }
  const succeeded = outcome === 'success' && result !== null && result.status === 200;
  const resource = await upsertResource(db, {
    sourceId: summerSchoolsEuSource.id,
    role,
    originalUrl: url,
    canonicalUrl: url,
    finalUrl: result?.finalUrl ?? null,
    status: succeeded ? 'fetched' : 'failed',
    fetchedAt: attemptedAt,
    contentHash: succeeded && result ? sha256(result.body) : null,
    byteSize: succeeded && result ? Buffer.byteLength(result.body, 'utf-8') : null,
    mimeType: result ? extractMimeType(result.headers) : null,
  });
  await recordFetchAttempt(db, {
    crawlRunId,
    resourceId: resource.id,
    attemptedAt,
    statusCode: result?.status ?? null,
    durationMs,
    outcome,
    errorKind: describeError(caught, result),
  });
  return { outcome, resourceId: resource.id, result };
}

/** A listing page or sitemap, asked up to three times while it merely fails; a block or a 404 is final. */
async function fetchIndex(
  db: Database,
  httpFetcher: HttpFetcher,
  crawlRunId: string,
  url: string,
  now: () => string,
  control: FetchControl,
): Promise<string | null> {
  for (let attempt = 1; attempt <= INDEX_ATTEMPTS && !control.stopped; attempt++) {
    const fetched = await fetchAndRecord(db, httpFetcher, crawlRunId, 'INDEX', url, now(), control);
    if (fetched.outcome === 'success' && fetched.result?.status === 200) return fetched.result.body;
    if (fetched.outcome !== 'failure') return null;
  }
  return null;
}

/** When the source's last completed run started (any run, full coverage or not). */
async function lastCompletedRunStartedAt(db: Database): Promise<string | null> {
  const [row] = await db
    .select({ startedAt: crawlRuns.startedAt })
    .from(crawlRuns)
    .where(and(eq(crawlRuns.sourceId, summerSchoolsEuSource.id), eq(crawlRuns.status, 'completed')))
    .orderBy(desc(crawlRuns.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

interface StoredFacts {
  deadlineRaw: string | null;
  deadlineParsed: string | null;
  modifiedAt: string | null;
}

/** The stored card deadline and page date of each known course, for the sticky deadline and the sitemap trigger. */
async function loadStoredFacts(
  db: Database,
  postIds: readonly string[],
): Promise<Map<string, StoredFacts>> {
  const facts = new Map<string, StoredFacts>();
  if (postIds.length === 0) return facts;
  const rows = await db
    .select({
      sourceRecordId: sourceListings.sourceRecordId,
      deadlineRaw: sql<string | null>`(${sourceListingRevisions.deadlineDate} ->> 'raw')`,
      deadlineParsed: sql<string | null>`(${sourceListingRevisions.deadlineDate} ->> 'parsed')`,
      modifiedAt: sql<
        string | null
      >`(${sourceListingRevisions.structuredAttributes} ->> 'modifiedAt')`,
    })
    .from(sourceListings)
    .innerJoin(
      sourceListingRevisions,
      eq(sourceListingRevisions.id, sourceListings.currentRevisionId),
    )
    .where(
      and(
        eq(sourceListings.sourceId, summerSchoolsEuSource.id),
        inArray(sourceListings.sourceRecordId, [...postIds]),
      ),
    );
  for (const row of rows) {
    if (row.sourceRecordId !== null) {
      facts.set(row.sourceRecordId, {
        deadlineRaw: row.deadlineRaw,
        deadlineParsed: row.deadlineParsed,
        modifiedAt: row.modifiedAt,
      });
    }
  }
  return facts;
}

/**
 * When each course page was last read successfully, by URL. A read that
 * found nothing new writes no revision, so only this says the sitemap's
 * newer date has been seen.
 */
async function loadLastReads(db: Database, urls: readonly string[]): Promise<Map<string, string>> {
  const reads = new Map<string, string>();
  if (urls.length === 0) return reads;
  const rows = await db
    .select({ url: resources.canonicalUrl, fetchedAt: resources.fetchedAt })
    .from(resources)
    .where(
      and(
        eq(resources.sourceId, summerSchoolsEuSource.id),
        eq(resources.role, 'OPPORTUNITY'),
        eq(resources.status, 'fetched'),
        inArray(resources.canonicalUrl, [...urls]),
      ),
    );
  for (const row of rows) {
    if (row.fetchedAt !== null) reads.set(row.url, row.fetchedAt);
  }
  return reads;
}

/** The latest of some instants, as epoch milliseconds; null when none is known. */
function latestMs(...instants: ReadonlyArray<number | null>): number | null {
  const known = instants.filter((ms): ms is number => ms !== null && !Number.isNaN(ms));
  return known.length === 0 ? null : Math.max(...known);
}

const msOf = (instant: string | null | undefined): number | null =>
  instant == null ? null : Date.parse(instant);

/**
 * Courses whose start date has passed close by that date, as `expired`
 * (choice C). The site's "future" flag lags (RECON_NOTES), so a started
 * course can stay listed; `touchSourceListingSeen` never reopens an
 * expired listing, and a course page read again reopens it only while it
 * has not started.
 */
async function expireStartedCourses(tx: DatabaseOrTransaction, today: string): Promise<number> {
  const rows = await tx
    .update(sourceListings)
    .set({ status: 'expired' })
    .where(
      and(
        eq(sourceListings.sourceId, summerSchoolsEuSource.id),
        inArray(sourceListings.status, [...OPEN_STATUSES]),
        sql`exists (select 1 from ${sourceListingRevisions} where ${sourceListingRevisions.id} = ${sourceListings.currentRevisionId} and (${sourceListingRevisions.structuredAttributes} ->> 'startDate') < ${today})`,
      ),
    )
    .returning({ id: sourceListings.id });
  return rows.length;
}

type Trigger = 'new' | 'card' | 'sitemap' | 'all';

interface DetailJob {
  card: CourseCard;
  fingerprint: string;
  trigger: Trigger;
  /** The stored deadline a vanished badge leaves behind, kept as it was resolved. */
  carriedDeadline: string | null;
}

/**
 * One summerschoolsineurope.eu run (docs/PHASE_15_PLAN.md, 15A, with its
 * "Changed" note). Membership comes from the covering walk (walk.ts); the
 * course sitemaps the index dates as changed say which course pages changed
 * without their card changing. A course page is read when the course is new,
 * its card changed, its sitemap date is newer than the page last read, it
 * was quarantined or closed, or `refetch` is 'all'.
 *
 * The run claims full coverage; it completes only when every result set of
 * the walk reached its own count and nothing failed, so a course missing
 * from three complete walks in a row closes, and no other absence counts.
 * Courses also close by their own dates: a passed registration deadline
 * (`expireOverdueListings`) and a passed start date (`expireStartedCourses`).
 */
export async function runSummerSchoolsCrawl(
  deps: RunSummerSchoolsCrawlDeps,
  options: RunSummerSchoolsCrawlOptions = {},
): Promise<RunSummerSchoolsCrawlResult> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const maxDetailFetches = options.maxDetailFetches ?? DEFAULT_MAX_DETAIL_FETCHES;
  const maxQuarantineRate = options.maxQuarantineRate ?? DEFAULT_MAX_QUARANTINE_RATE;
  const maxFetchFailureRate = options.maxFetchFailureRate ?? DEFAULT_MAX_FETCH_FAILURE_RATE;

  const policySync = await ensureSummerSchoolsEuSourceSeeded(db);
  if (policySync.outcome === 'refused-stale') {
    throw new Error(
      `runSummerSchoolsCrawl: refusing to crawl -- this deployment's summerSchoolsEuPolicy was refused as stale against the database's current revision for source ${summerSchoolsEuSource.id}.`,
    );
  }
  const httpFetcher = withPolicyRevalidation(
    deps.httpFetcher,
    db,
    summerSchoolsEuSource.id,
    policySync.currentRevisionId,
  );

  const lastCompletedStartedAt = await lastCompletedRunStartedAt(db);
  const startedAt = now();
  const crawlRun = await startCrawlRun(db, {
    sourceId: summerSchoolsEuSource.id,
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
    skippedCount: 0,
    missingCount: 0,
    expiredCount: 0,
    reopenedCount: 0,
    quarantinedCount: 0,
    failedCount: 0,
  };
  const stats: SummerSchoolsRunStats = {
    listingRequests: 0,
    resultSets: 0,
    resamples: 0,
    rootTotal: null,
    coursesSeen: 0,
    uncovered: 0,
    sitemapRequests: 0,
    sitemapEntries: 0,
    detailFetches: 0,
    fetchedNew: 0,
    fetchedCardChanged: 0,
    fetchedSitemapChanged: 0,
    fetchedRefetchAll: 0,
    stickyDeadlines: 0,
    notFound: 0,
    refusedUrls: 0,
    startedClosed: 0,
  };

  try {
    const backoffUntil = await getSourceBackoffUntil(db, summerSchoolsEuSource.id);
    const control: FetchControl = {
      stopped: backoffUntil !== null && Date.parse(backoffUntil) > Date.parse(startedAt),
    };

    // 1. Membership: the covering walk.
    const read = async (filters: Filters): Promise<ParsedListingPage | null> => {
      if (control.stopped) return null;
      const url = listingUrl(filters);
      if (!isSummerSchoolsEuUrlAllowed(url)) {
        // Never sent; counts as a failed request, so the walk is not complete.
        await recordParserIncident(db, {
          sourceId: summerSchoolsEuSource.id,
          crawlRunId: crawlRun.id,
          detectedAt: now(),
          kind: 'other',
          severity: 'warning',
          evidence: { reason: 'url_not_allowed', url },
        });
        return null;
      }
      const body = await fetchIndex(db, httpFetcher, crawlRun.id, url, now, control);
      if (body === null) return null;
      try {
        return parseListingPage(body);
      } catch (parseError) {
        await recordParserIncident(db, {
          sourceId: summerSchoolsEuSource.id,
          crawlRunId: crawlRun.id,
          detectedAt: now(),
          kind: 'field_missing',
          severity: 'warning',
          evidence: {
            url,
            error: parseError instanceof Error ? parseError.message : String(parseError),
          },
        });
        return null;
      }
    };
    const walk = await coverListing(read, {
      capacity: PAGE_CAPACITY,
      maxRequests: options.maxListingRequests ?? DEFAULT_MAX_LISTING_REQUESTS,
      // A value the policy would refuse is left out; its courses count as
      // unseen unless another facet reaches them.
      acceptValue: (_facet, value) => isListingFacetValueAllowed(value),
    });
    for (const rejected of walk.rejectedValues) {
      await recordParserIncident(db, {
        sourceId: summerSchoolsEuSource.id,
        crawlRunId: crawlRun.id,
        detectedAt: now(),
        kind: 'other',
        severity: 'warning',
        evidence: { reason: 'facet_value_not_allowed', ...rejected },
      });
    }
    stats.listingRequests = walk.requests;
    stats.resultSets = walk.resultSets;
    stats.resamples = walk.resamples;
    stats.rootTotal = walk.rootTotal;
    stats.uncovered = walk.uncovered;
    const cards = [...walk.cards.values()];
    stats.coursesSeen = cards.length;
    counts.discoveredCount = cards.length;
    counts.standardCount = cards.length;
    const disciplineSlugs = new Map(
      (walk.rootFacets.course_discipline ?? []).map((choice) => [choice.label, choice.value]),
    );

    // 2. Which course pages changed: the sitemaps the index dates after the last completed run.
    const sitemapLastmod = new Map<string, string>();
    let sitemapOk = !control.stopped;
    if (!control.stopped) {
      const indexUrl = new URL('/sitemap_index.xml', summerSchoolsEuSource.baseUrl).toString();
      stats.sitemapRequests++;
      const indexBody = await fetchIndex(db, httpFetcher, crawlRun.id, indexUrl, now, control);
      try {
        if (indexBody === null) throw new Error('sitemap index unreadable');
        const since =
          options.sitemaps === 'all' || lastCompletedStartedAt === null
            ? null
            : new Date(Date.parse(lastCompletedStartedAt) - SITEMAP_OVERLAP_MS).toISOString();
        for (const sitemap of sitemapsChangedSince(parseSitemapIndex(indexBody), since)) {
          stats.sitemapRequests++;
          const body = await fetchIndex(db, httpFetcher, crawlRun.id, sitemap.url, now, control);
          if (body === null) throw new Error(`sitemap unreadable: ${sitemap.url}`);
          for (const entry of parseCourseSitemap(body)) {
            if (entry.lastmod !== null) sitemapLastmod.set(entry.url, entry.lastmod);
          }
        }
      } catch {
        sitemapOk = false;
      }
      stats.sitemapEntries = sitemapLastmod.size;
    }

    // 3. Which course pages to read.
    const postIds = cards.map((card) => card.postId);
    const known = await loadKnownListings(db, summerSchoolsEuSource.id, postIds);
    const stored = await loadStoredFacts(db, postIds);
    const lastReads = await loadLastReads(
      db,
      cards.map((card) => card.url),
    );
    const jobs: DetailJob[] = [];
    const seenWithoutWrite: CourseCard[] = [];
    for (const card of cards) {
      const facts = stored.get(card.postId);
      // A badge gone after its day most likely went with the day: keep the
      // stored deadline as it was resolved. One gone before its day was
      // withdrawn, and the course has no deadline now.
      let effective = card;
      let carriedDeadline: string | null = null;
      if (
        card.deadlineRaw === null &&
        facts?.deadlineRaw != null &&
        facts.deadlineParsed != null &&
        Date.parse(facts.deadlineParsed) <= Date.parse(startedAt)
      ) {
        effective = { ...card, deadlineRaw: facts.deadlineRaw };
        carriedDeadline = facts.deadlineParsed;
        stats.stickyDeadlines++;
      }
      const fingerprint = cardFingerprint(effective);
      const entry: KnownListing | undefined = known.get(card.postId);
      let decision =
        options.refetch === 'all' ? 'fetch' : needsDetailFetch(entry, fingerprint, startedAt);
      let trigger: Trigger =
        options.refetch === 'all' ? 'all' : entry?.currentRevisionId == null ? 'new' : 'card';
      if (decision === 'skip') {
        // The page changed after it was last read: its own date says which
        // version is stored, and a read that found nothing new still counts.
        const lastmod = sitemapLastmod.get(card.url);
        const fetchedMs = latestMs(msOf(entry?.revisionFetchedAt), msOf(lastReads.get(card.url)));
        const readMs = latestMs(
          msOf(facts?.modifiedAt),
          fetchedMs === null ? null : fetchedMs - PAGE_CACHE_MS,
        );
        if (lastmod !== undefined && readMs !== null && Date.parse(lastmod) > readMs) {
          decision = 'fetch';
          trigger = 'sitemap';
        }
      }
      if (decision === 'fetch') {
        jobs.push({ card: effective, fingerprint, trigger, carriedDeadline });
        continue;
      }
      if (decision === 'adopt') {
        await setDiscoveryFingerprint(db, summerSchoolsEuSource.id, card.postId, fingerprint);
      }
      seenWithoutWrite.push(card);
      counts.skippedCount++;
    }

    // 4. Course pages.
    const todayAtStart = tbilisiDay(startedAt);
    for (const job of jobs) {
      if (control.stopped || stats.detailFetches >= maxDetailFetches) {
        seenWithoutWrite.push(job.card);
        continue;
      }
      const url = job.card.url;
      if (!isSummerSchoolsEuUrlAllowed(url)) {
        // A card linking to a page shape the policy does not know: that
        // course fails alone, seen all the same, and the run goes on.
        stats.refusedUrls++;
        counts.failedCount++;
        seenWithoutWrite.push(job.card);
        await recordParserIncident(db, {
          sourceId: summerSchoolsEuSource.id,
          crawlRunId: crawlRun.id,
          detectedAt: now(),
          kind: 'other',
          severity: 'warning',
          evidence: { reason: 'url_not_allowed', url, sourceRecordId: job.card.postId },
        });
        continue;
      }
      const identity = {
        sourceId: summerSchoolsEuSource.id,
        sourceRecordId: job.card.postId,
        canonicalSourceUrl: url,
      };
      const attemptedAt = now();
      stats.detailFetches++;
      const fetched = await fetchAndRecord(
        db,
        httpFetcher,
        crawlRun.id,
        'OPPORTUNITY',
        url,
        attemptedAt,
        control,
      );
      const result = fetched.result;
      if (fetched.outcome !== 'success' || result === null || result.status !== 200) {
        // Listed but unreadable: seen all the same, so absence does not count against it.
        if (result?.status === 404) stats.notFound++;
        counts.failedCount++;
        seenWithoutWrite.push(job.card);
        continue;
      }

      let content: ReturnType<typeof parseCoursePage>;
      try {
        content = parseCoursePage({
          html: result.body,
          expectedPostId: job.card.postId,
          card: {
            deadlineRaw: job.card.deadlineRaw,
            online: job.card.online,
            ...(job.carriedDeadline === null ? {} : { deadlineParsed: job.carriedDeadline }),
          },
          disciplineSlugs,
          extractionMethod: 'http',
          provenance: {
            resourceId: fetched.resourceId as ResourceId,
            fetchedAt: attemptedAt,
            notes: null,
          },
        });
      } catch (parseError) {
        counts.quarantinedCount++;
        await quarantineSourceListing(db, identity, attemptedAt);
        await upsertResource(db, {
          sourceId: summerSchoolsEuSource.id,
          role: 'OPPORTUNITY',
          originalUrl: url,
          canonicalUrl: url,
          finalUrl: result.finalUrl,
          status: 'quarantined',
          fetchedAt: attemptedAt,
          contentHash: sha256(result.body),
          byteSize: Buffer.byteLength(result.body, 'utf-8'),
          mimeType: extractMimeType(result.headers),
        });
        await recordParserIncident(db, {
          sourceId: summerSchoolsEuSource.id,
          crawlRunId: crawlRun.id,
          detectedAt: attemptedAt,
          kind: 'field_missing',
          severity: 'warning',
          evidence: {
            sourceRecordId: job.card.postId,
            url,
            resourceId: fetched.resourceId,
            parserVersion: SUMMER_SCHOOLS_DETAIL_PARSER_VERSION,
            error: parseError instanceof Error ? parseError.message : String(parseError),
          },
        });
        continue;
      }

      const attributes = content.structuredAttributes as unknown as CourseAttributes;
      const started = attributes.startDate !== null && attributes.startDate < todayAtStart;
      const deadlinePassed =
        content.deadlineDate.parsed !== null &&
        Date.parse(content.deadlineDate.parsed) <= Date.parse(attemptedAt);
      const written = await writeSourceListingRevision(db, identity, content, attemptedAt, {
        // A listed course that has neither started nor passed its deadline may reopen.
        allowReopen: !started && !deadlinePassed,
      });
      if (written.outcome === 'new') counts.newCount++;
      else if (written.outcome === 'changed') counts.changedCount++;
      else if (written.outcome === 'unchanged') counts.unchangedCount++;
      if (written.reopened) counts.reopenedCount++;
      if (written.outcome !== 'stale') {
        await setDiscoveryFingerprint(
          db,
          summerSchoolsEuSource.id,
          job.card.postId,
          job.fingerprint,
        );
      }
      if (job.trigger === 'new') stats.fetchedNew++;
      else if (job.trigger === 'card') stats.fetchedCardChanged++;
      else if (job.trigger === 'sitemap') stats.fetchedSitemapChanged++;
      else stats.fetchedRefetchAll++;
    }

    // Every listed course not written this run was still seen.
    for (const card of seenWithoutWrite) {
      await touchSourceListingSeen(
        db,
        {
          sourceId: summerSchoolsEuSource.id,
          sourceRecordId: card.postId,
          canonicalSourceUrl: card.url,
        },
        now(),
      );
    }

    // 5. Guards.
    // A refused URL counts as failed against the pages asked for: many of
    // them fail the run, and one alone on a quiet day does not (its incident
    // says so, every run, until the policy learns its shape).
    const fetchedPages = stats.detailFetches;
    const quarantineOk =
      fetchedPages === 0 || counts.quarantinedCount / fetchedPages <= maxQuarantineRate;
    const fetchFailureOk =
      fetchedPages === 0 || counts.failedCount / fetchedPages <= maxFetchFailureRate;
    const nonEmpty = (walk.rootTotal ?? 0) > 0 && cards.length > 0;
    const capOk = jobs.length <= maxDetailFetches;
    const runOk =
      walk.requestsOk &&
      walk.complete &&
      nonEmpty &&
      sitemapOk &&
      quarantineOk &&
      fetchFailureOk &&
      capOk &&
      !control.stopped;

    if (!control.stopped) {
      await recordRunAnomalies(db, {
        sourceId: summerSchoolsEuSource.id,
        crawlRunId: crawlRun.id,
        detectedAt: now(),
        guards: [
          { name: 'walkComplete', ok: walk.requestsOk, countGuard: true },
          { name: 'coverage', ok: walk.complete, countGuard: true },
          { name: 'nonEmpty', ok: nonEmpty, countGuard: true },
          { name: 'sitemapRead', ok: sitemapOk, countGuard: false },
          { name: 'quarantineRate', ok: quarantineOk, countGuard: false },
          { name: 'fetchFailureRate', ok: fetchFailureOk, countGuard: false },
        ],
        discoveredCount: cards.length,
        baselineDiscoveredCount: null,
        measurements: { ...stats, maxQuarantineRate, maxFetchFailureRate, maxDetailFetches },
      });
    }

    // 6. Settle: dates first, then absence, in one transaction.
    const finishedAt = now();
    const runStatus: CrawlRunStatus = runOk ? 'completed' : 'partial';
    const finalRun = await db.transaction(async (tx) => {
      await finishCrawlRun(tx, crawlRun.id, { finishedAt, status: runStatus, counts });
      const expired = await expireOverdueListings(tx, {
        sourceId: summerSchoolsEuSource.id,
        asOf: finishedAt,
      });
      stats.startedClosed = await expireStartedCourses(tx, tbilisiDay(finishedAt));
      const closed = await closeMissingListingsInTransaction(tx, {
        crawlRunId: crawlRun.id,
        missingStreakThreshold: MISSING_STREAK_THRESHOLD,
        allowMassClosure: options.allowMassClosure === true,
      });
      return finishCrawlRun(tx, crawlRun.id, {
        finishedAt,
        status: runStatus,
        counts: {
          ...counts,
          expiredCount: expired.expiredCount + stats.startedClosed,
          missingCount: closed.missingSuspectedCount + closed.closedCount,
        },
        reconciledAt: finishedAt,
      });
    });
    return { crawlRun: finalRun, stats };
  } catch (err) {
    await failUnsettledCrawlRun(db, crawlRun.id, {
      finishedAt: now(),
      counts,
      reconciledAt: now(),
    });
    throw err;
  }
}
