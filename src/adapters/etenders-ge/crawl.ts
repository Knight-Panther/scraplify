import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
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
import { expireOverdueListings } from '../../db/reconcile-source-listings.js';
import { type CrawlRunRow, crawlRuns, sourceListings, sources } from '../../db/schema/index.js';
import { type SyncSourcePolicyResult, syncSourcePolicy } from '../../db/source-policies.js';
import type { Database } from '../../db/types.js';
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
import { etendersGePolicy, etendersGeSource } from '../../policies/etenders-ge.js';
import { PolicyRevisionSupersededError, withPolicyRevalidation } from '../policy-revalidation.js';
import {
  type KnownListing,
  loadKnownListings,
  needsDetailFetch,
  setDiscoveryFingerprint,
} from '../refetch.js';
import { recordRunAnomalies } from '../run-anomalies.js';
import {
  ETENDERS_GE_DETAIL_PARSER_VERSION,
  LIVE_STATUS_CODES,
  parseEtendersGeDetailPage,
  type TenderAttributes,
} from './detail.js';
import { parseSearchPage, type TenderCard } from './discovery.js';

/** Live statuses: announced, bids open, live bidding. */
const LIVE_STATUS_SET = '_1_2_3_';
const ALL_STATUSES = '__';
/** What a full search page holds without a session (the page size lives in the server session). */
export const SEARCH_PAGE_SIZE = 20;
/** Safety cap per walk; the live set is ~2 pages and a 60-day window ~15. */
const MAX_SEARCH_PAGES = 40;
/** Default backfill on a source's first run: the 60-day closed-listing retention window. */
export const DEFAULT_FIRST_RUN_WINDOW_DAYS = 60;
/** Overlap added before the last completed run, so nothing announced around it is missed. */
const WINDOW_OVERLAP_DAYS = 2;
const MAX_WINDOW_DAYS = 120;
/** A live tender's detail page is fetched again once its stored revision is this old (documents and Q&A change without the card's amendment stamp). */
export const DEFAULT_LIVE_REFRESH_HOURS = 20;
const DEFAULT_MAX_DETAIL_FETCHES = 500;
/** Same tolerances as the job boards (src/adapters/jobs-ge/crawl.ts explains each). */
const DEFAULT_MAX_QUARANTINE_RATE = 0.1;
const DEFAULT_MAX_FETCH_FAILURE_RATE = 0.5;
/** Two "not found" answers on different runs before a listing is closed as removed (concept §13). */
const NOT_FOUND_CLOSE_STREAK = 2;
const OPEN_STATUSES = ['discovered', 'active', 'missing_suspected'] as const;
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;

export interface RunEtendersGeCrawlDeps {
  db: Database;
  httpFetcher: HttpFetcher;
  now?: () => string;
}

export interface RunEtendersGeCrawlOptions {
  /** Days of announcements to walk; defaults to "since the last completed run" (or 60 days on a first run). */
  windowDays?: number;
  /** Refetch live tenders whose stored revision is at least this old. */
  liveRefreshHours?: number;
  /** Upper bound on detail fetches per run. */
  maxDetailFetches?: number;
  /** 'all' fetches every public tender found, for use after a parser change. */
  refetch?: 'changed' | 'all';
  maxQuarantineRate?: number;
  maxFetchFailureRate?: number;
}

export interface EtendersGeRunStats {
  liveCards: number;
  windowCards: number;
  /** Cards skipped because their details are closed to the public: invite-only or anonymous buyers. */
  lockedSkipped: number;
  /** Cards that were not tenders (asset sales) or had no usable detail link. */
  otherSkipped: number;
  detailFetches: number;
  /** Known open tenders that left the live set and were checked for their closing status. */
  exitChecks: number;
  /** Listings closed because the source itself says terminated, failed or completed. */
  closedBySource: number;
  /** Detail requests answered with the site's not-found redirect. */
  notFound: number;
  windowFrom: string;
}

export interface RunEtendersGeCrawlResult {
  crawlRun: CrawlRunRow;
  stats: EtendersGeRunStats;
}

/** Seeds the source row and syncs the policy, exactly like the job-board adapters do. */
export async function ensureEtendersGeSourceSeeded(db: Database): Promise<SyncSourcePolicyResult> {
  await db
    .insert(sources)
    .values({
      id: etendersGeSource.id,
      slug: etendersGeSource.slug,
      displayName: etendersGeSource.displayName,
      baseUrl: etendersGeSource.baseUrl,
    })
    .onConflictDoNothing();
  return await syncSourcePolicy(db, etendersGePolicy);
}

/** `DD-MM-YYYY` of an instant's Tbilisi calendar day, the search form's date format. */
export function tbilisiSearchDate(instant: number): string {
  const local = new Date(instant + TBILISI_OFFSET_MS);
  const dd = String(local.getUTCDate()).padStart(2, '0');
  const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${local.getUTCFullYear()}`;
}

export function buildSearchUrl(input: {
  statuses: string;
  from: string | null;
  page: number;
}): string {
  const url = new URL('/search/', etendersGeSource.baseUrl);
  // The exact parameter set and order the site's own form produces.
  const params: [string, string][] = [
    ['ss', '-1'],
    ['ts', input.statuses],
    ['kw', ''],
    ['tn', ''],
    ['br', ''],
    ['cpv', ''],
    ['st', input.from ?? ''],
    ['end', ''],
    ['stamm', ''],
    ['endamm', ''],
  ];
  if (input.page > 1) params.push(['pg', String(input.page)]);
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

function detailUrl(sourceRecordId: string): string {
  return new URL(`/view/${sourceRecordId}/x`, etendersGeSource.baseUrl).toString();
}

function header(result: HttpFetchResult, name: string): string | undefined {
  const value = result.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function classifyOutcome(error: unknown, result: HttpFetchResult | null): FetchOutcome {
  if (error instanceof UrlNotAllowedError || error instanceof SsrfBlockedError) return 'blocked';
  if (error !== null || result === null) return 'failure';
  if (result.status === 403 || result.status === 202) return 'blocked';
  if (result.status === 429) return 'retry';
  // Redirects are answers on this source, read by the caller: not found,
  // out of range, or a sale under a tender URL.
  if (result.status === 200 || result.status === 301 || result.status === 302) return 'success';
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
  const backoffUntil =
    result === null
      ? null
      : responseBackoffUntil(result, new Date(Date.parse(attemptedAt) + durationMs).toISOString());
  if (outcome === 'blocked' || outcome === 'retry' || backoffUntil !== null) control.stopped = true;
  if (backoffUntil !== null) {
    await extendSourceBackoff(db, etendersGeSource.id, backoffUntil, attemptedAt);
  }
  const succeeded = outcome === 'success' && result !== null && result.status === 200;
  const resource = await upsertResource(db, {
    sourceId: etendersGeSource.id,
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

interface WalkResult {
  cards: TenderCard[];
  /** The walk reached the last page the paging named, with every page fetched and full. */
  complete: boolean;
  /** Every page except the last held a full page of cards. */
  pageSizesOk: boolean;
}

/** Walks one search across its pages, stopping at the last page the site's own paging names. */
async function walkSearch(
  db: Database,
  httpFetcher: HttpFetcher,
  crawlRun: CrawlRunRow,
  now: () => string,
  control: FetchControl,
  statuses: string,
  from: string | null,
): Promise<WalkResult> {
  const cards: TenderCard[] = [];
  let pageSizesOk = true;
  let lastPage = 1;
  for (let page = 1; page <= Math.min(lastPage, MAX_SEARCH_PAGES); page++) {
    if (control.stopped) return { cards, complete: false, pageSizesOk };
    const url = buildSearchUrl({ statuses, from, page });
    const fetched = await fetchAndRecord(
      db,
      httpFetcher,
      crawlRun.id,
      'INDEX',
      url,
      now(),
      control,
    );
    // A redirect here is the site's "out of range, back to page 1" answer:
    // never a page of this walk.
    if (fetched.outcome !== 'success' || fetched.result?.status !== 200) {
      return { cards, complete: false, pageSizesOk };
    }
    const parsed = parseSearchPage(fetched.result.body);
    if (page > 1 && parsed.activePage !== page) return { cards, complete: false, pageSizesOk };
    cards.push(...parsed.cards);
    lastPage = Math.max(lastPage, parsed.lastPage);
    if (page < lastPage && parsed.cards.length !== SEARCH_PAGE_SIZE) pageSizesOk = false;
  }
  return { cards, complete: lastPage <= MAX_SEARCH_PAGES, pageSizesOk };
}

/** Open listings of this source that the live set no longer shows. */
async function loadOpenListingsOutside(
  db: Database,
  liveIds: ReadonlySet<string>,
): Promise<string[]> {
  const rows = await db
    .select({ sourceRecordId: sourceListings.sourceRecordId })
    .from(sourceListings)
    .where(
      and(
        eq(sourceListings.sourceId, etendersGeSource.id),
        inArray(sourceListings.status, [...OPEN_STATUSES]),
      ),
    );
  return rows
    .map((row) => row.sourceRecordId)
    .filter((id): id is string => id !== null && !liveIds.has(id));
}

/** The source says the tender is over (completed, terminated or failed): close it, once. */
async function closeOnSourceStatus(db: Database, sourceListingId: string): Promise<boolean> {
  const rows = await db
    .update(sourceListings)
    .set({ status: 'closed', missingStreak: 0 })
    .where(
      and(
        eq(sourceListings.id, sourceListingId),
        inArray(sourceListings.status, [...OPEN_STATUSES]),
      ),
    )
    .returning({ id: sourceListings.id });
  return rows.length > 0;
}

/**
 * The site answered "not found" for a listing we hold open. The first answer
 * makes it `missing_suspected`; a second, on a later run, closes it. Keyed on
 * `lastReconciledAt` so a re-run of the same crawl cannot advance it twice.
 */
async function recordNotFound(
  db: Database,
  sourceRecordId: string,
  runStartedAt: string,
): Promise<'suspected' | 'closed' | 'unchanged'> {
  const [row] = await db
    .select({
      id: sourceListings.id,
      streak: sourceListings.missingStreak,
    })
    .from(sourceListings)
    .where(
      and(
        eq(sourceListings.sourceId, etendersGeSource.id),
        eq(sourceListings.sourceRecordId, sourceRecordId),
        inArray(sourceListings.status, [...OPEN_STATUSES]),
        or(
          isNull(sourceListings.lastReconciledAt),
          lt(sourceListings.lastReconciledAt, runStartedAt),
        ),
      ),
    );
  if (row === undefined) return 'unchanged';
  const streak = row.streak + 1;
  const closed = streak >= NOT_FOUND_CLOSE_STREAK;
  await db
    .update(sourceListings)
    .set({
      missingStreak: streak,
      status: closed ? 'closed' : 'missing_suspected',
      lastReconciledAt: runStartedAt,
    })
    .where(eq(sourceListings.id, row.id));
  return closed ? 'closed' : 'suspected';
}

/**
 * When the source's last completed run started. Not `getLastCompletedCrawlRun`:
 * that one counts only full-coverage runs, the job boards' collapse baseline,
 * and an etenders.ge run never is one, so every run would walk the first-run
 * window.
 */
async function lastCompletedRunStartedAt(db: Database): Promise<string | null> {
  const [row] = await db
    .select({ startedAt: crawlRuns.startedAt })
    .from(crawlRuns)
    .where(and(eq(crawlRuns.sourceId, etendersGeSource.id), eq(crawlRuns.status, 'completed')))
    .orderBy(desc(crawlRuns.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

function windowFromDate(
  options: RunEtendersGeCrawlOptions,
  lastCompletedStartedAt: string | null,
  nowMs: number,
): string {
  const dayMs = 24 * 60 * 60 * 1000;
  let days: number;
  if (options.windowDays !== undefined) {
    days = options.windowDays;
  } else if (lastCompletedStartedAt === null) {
    days = DEFAULT_FIRST_RUN_WINDOW_DAYS;
  } else {
    const since = (nowMs - Date.parse(lastCompletedStartedAt)) / dayMs;
    days = Math.ceil(since) + WINDOW_OVERLAP_DAYS;
  }
  if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
    throw new Error(`windowDays must be an integer between 1 and ${MAX_WINDOW_DAYS}`);
  }
  return tbilisiSearchDate(nowMs - days * dayMs);
}

/**
 * One etenders.ge run (docs/addEtender.md §14.2). Discovery reads two
 * searches instead of walking the 11,000-tender archive: the live set
 * (`ts=_1_2_3_`, about 40 tenders) and a recent-announcements window, which
 * also catches tenders that opened and closed between runs. Locked cards
 * (invite-only, anonymous buyers) and asset sales are skipped without a
 * detail request; their details are not public.
 *
 * A detail page is fetched for a new tender, a changed card (status, end
 * date, amendment stamp, title, buyer), a live tender whose stored revision
 * is older than `liveRefreshHours`, and every open listing that has left the
 * live set, to read how it ended. Closure comes from that stated status
 * (completed, terminated, failed), never from absence, so the run records
 * `fullCoverage=false` and no missing streak advances on its account; the
 * only absence rule is the site's own not-found redirect, twice.
 */
export async function runEtendersGeCrawl(
  deps: RunEtendersGeCrawlDeps,
  options: RunEtendersGeCrawlOptions = {},
): Promise<RunEtendersGeCrawlResult> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const liveRefreshMs = (options.liveRefreshHours ?? DEFAULT_LIVE_REFRESH_HOURS) * 60 * 60 * 1000;
  const maxDetailFetches = options.maxDetailFetches ?? DEFAULT_MAX_DETAIL_FETCHES;
  const maxQuarantineRate = options.maxQuarantineRate ?? DEFAULT_MAX_QUARANTINE_RATE;
  const maxFetchFailureRate = options.maxFetchFailureRate ?? DEFAULT_MAX_FETCH_FAILURE_RATE;

  const policySync = await ensureEtendersGeSourceSeeded(db);
  if (policySync.outcome === 'refused-stale') {
    throw new Error(
      `runEtendersGeCrawl: refusing to crawl -- this deployment's etendersGePolicy was refused as stale against the database's current revision for source ${etendersGeSource.id}.`,
    );
  }
  const httpFetcher = withPolicyRevalidation(
    deps.httpFetcher,
    db,
    etendersGeSource.id,
    policySync.currentRevisionId,
  );

  const lastCompletedStartedAt = await lastCompletedRunStartedAt(db);
  const startedAt = now();
  const windowFrom = windowFromDate(options, lastCompletedStartedAt, Date.parse(startedAt));
  const crawlRun = await startCrawlRun(db, {
    sourceId: etendersGeSource.id,
    startedAt,
    // Never full coverage: closure is read from each tender's own page.
    fullCoverage: false,
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
  const stats: EtendersGeRunStats = {
    liveCards: 0,
    windowCards: 0,
    lockedSkipped: 0,
    otherSkipped: 0,
    detailFetches: 0,
    exitChecks: 0,
    closedBySource: 0,
    notFound: 0,
    windowFrom,
  };

  try {
    const backoffUntil = await getSourceBackoffUntil(db, etendersGeSource.id);
    const control: FetchControl = {
      stopped: backoffUntil !== null && Date.parse(backoffUntil) > Date.parse(startedAt),
    };

    const live = await walkSearch(db, httpFetcher, crawlRun, now, control, LIVE_STATUS_SET, null);
    const window = await walkSearch(
      db,
      httpFetcher,
      crawlRun,
      now,
      control,
      ALL_STATUSES,
      windowFrom,
    );
    stats.liveCards = live.cards.length;
    stats.windowCards = window.cards.length;

    // Live-set cards win: they are the fresher read of the same tender.
    const cards = new Map<string, TenderCard>();
    for (const card of [...window.cards, ...live.cards]) cards.set(card.sourceRecordId, card);
    const liveIds = new Set(live.cards.map((card) => card.sourceRecordId));
    const publicCards: TenderCard[] = [];
    for (const card of cards.values()) {
      if (card.restricted || card.anonymous) stats.lockedSkipped++;
      else if (card.kind !== 'tender' || card.url === null) stats.otherSkipped++;
      else publicCards.push(card);
    }
    counts.discoveredCount = publicCards.length;
    counts.standardCount = publicCards.length;

    const known = await loadKnownListings(
      db,
      etendersGeSource.id,
      publicCards.map((card) => card.sourceRecordId),
    );
    const startedAtMs = Date.parse(startedAt);
    const decide = (
      card: TenderCard,
      entry: KnownListing | undefined,
    ): 'fetch' | 'adopt' | 'skip' => {
      if (options.refetch === 'all') return 'fetch';
      const cardLive = card.statusCode !== null && LIVE_STATUS_CODES.has(card.statusCode);
      // A finished tender already stored as finished, with an unchanged card,
      // has nothing new to say (needsDetailFetch would refetch every 'closed'
      // listing on every run, which here means every window card).
      if (
        !cardLive &&
        entry !== undefined &&
        entry.currentRevisionId !== null &&
        (entry.status === 'closed' || entry.status === 'expired') &&
        entry.discoveryFingerprint === card.fingerprint
      ) {
        return 'skip';
      }
      const decision = needsDetailFetch(entry, card.fingerprint, startedAt);
      // Documents and Q&A can change without the card's amendment stamp, so a
      // live tender is reread once its stored revision is old enough.
      const fetchedAt = entry?.revisionFetchedAt ?? null;
      if (
        decision === 'skip' &&
        cardLive &&
        (fetchedAt === null || startedAtMs - Date.parse(fetchedAt) >= liveRefreshMs)
      ) {
        return 'fetch';
      }
      return decision;
    };

    interface DetailJob {
      sourceRecordId: string;
      card: TenderCard | null;
    }
    const jobs: DetailJob[] = [];
    for (const card of publicCards) {
      const entry = known.get(card.sourceRecordId);
      const decision = decide(card, entry);
      if (decision === 'fetch') {
        jobs.push({ sourceRecordId: card.sourceRecordId, card });
        continue;
      }
      await touchSourceListingSeen(
        db,
        {
          sourceId: etendersGeSource.id,
          sourceRecordId: card.sourceRecordId,
          canonicalSourceUrl: detailUrl(card.sourceRecordId),
        },
        now(),
      );
      if (decision === 'adopt') {
        await setDiscoveryFingerprint(
          db,
          etendersGeSource.id,
          card.sourceRecordId,
          card.fingerprint,
        );
      }
      counts.skippedCount++;
    }
    // Open tenders that left the live set: their own page says how they ended.
    // Only after a complete live walk, or a broken one would send every open
    // tender here.
    if (live.complete && live.cards.length > 0) {
      const queued = new Set(jobs.map((job) => job.sourceRecordId));
      for (const id of await loadOpenListingsOutside(db, liveIds)) {
        if (queued.has(id)) continue;
        jobs.push({ sourceRecordId: id, card: null });
        stats.exitChecks++;
      }
    }

    for (const job of jobs) {
      if (control.stopped || stats.detailFetches >= maxDetailFetches) break;
      const url = detailUrl(job.sourceRecordId);
      const identity = {
        sourceId: etendersGeSource.id,
        sourceRecordId: job.sourceRecordId,
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
      if (fetched.outcome !== 'success' || result === null) {
        counts.failedCount++;
        if (job.card !== null) await touchSourceListingSeen(db, identity, attemptedAt);
        continue;
      }
      if (result.status !== 200) {
        const location = header(result, 'location') ?? '';
        if (/TenderNotFound/i.test(location)) {
          stats.notFound++;
          const outcome = await recordNotFound(db, job.sourceRecordId, startedAt);
          if (outcome !== 'unchanged') counts.missingCount++;
        } else {
          // A sale under a tender URL, or any other redirect: not a tender page.
          stats.otherSkipped++;
        }
        continue;
      }

      let content: ReturnType<typeof parseEtendersGeDetailPage>;
      try {
        content = parseEtendersGeDetailPage({
          html: result.body,
          expectedSourceRecordId: job.sourceRecordId,
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
          sourceId: etendersGeSource.id,
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
          sourceId: etendersGeSource.id,
          crawlRunId: crawlRun.id,
          detectedAt: attemptedAt,
          kind: 'field_missing',
          severity: 'warning',
          evidence: {
            sourceRecordId: job.sourceRecordId,
            url,
            resourceId: fetched.resourceId,
            parserVersion: ETENDERS_GE_DETAIL_PARSER_VERSION,
            error: parseError instanceof Error ? parseError.message : String(parseError),
          },
        });
        continue;
      }

      const status = (content.structuredAttributes as unknown as TenderAttributes).status.code;
      const stillLive = LIVE_STATUS_CODES.has(status);
      // Only a tender the source shows as open again may reopen a closed listing.
      const written = await writeSourceListingRevision(db, identity, content, attemptedAt, {
        allowReopen: stillLive,
      });
      if (written.outcome === 'new') counts.newCount++;
      else if (written.outcome === 'changed') counts.changedCount++;
      else if (written.outcome === 'unchanged') counts.unchangedCount++;
      if (written.reopened) counts.reopenedCount++;
      if (!stillLive && (await closeOnSourceStatus(db, written.sourceListing.id))) {
        stats.closedBySource++;
      }
      if (job.card !== null && written.outcome !== 'stale') {
        await setDiscoveryFingerprint(
          db,
          etendersGeSource.id,
          job.sourceRecordId,
          job.card.fingerprint,
        );
      }
    }

    const fetchedPages = stats.detailFetches;
    const quarantineOk =
      fetchedPages === 0 || counts.quarantinedCount / fetchedPages <= maxQuarantineRate;
    const fetchFailureOk =
      fetchedPages === 0 || counts.failedCount / fetchedPages <= maxFetchFailureRate;
    const liveNonEmpty = live.cards.length > 0;
    const capOk = jobs.length <= maxDetailFetches;
    const runOk =
      live.complete &&
      window.complete &&
      live.pageSizesOk &&
      window.pageSizesOk &&
      liveNonEmpty &&
      quarantineOk &&
      fetchFailureOk &&
      capOk &&
      !control.stopped;

    if (!control.stopped) {
      await recordRunAnomalies(db, {
        sourceId: etendersGeSource.id,
        crawlRunId: crawlRun.id,
        detectedAt: now(),
        guards: [
          { name: 'liveSetComplete', ok: live.complete, countGuard: true },
          { name: 'liveSetNonEmpty', ok: liveNonEmpty, countGuard: true },
          { name: 'windowComplete', ok: window.complete, countGuard: true },
          { name: 'pageSize', ok: live.pageSizesOk && window.pageSizesOk, countGuard: true },
          { name: 'quarantineRate', ok: quarantineOk, countGuard: false },
          { name: 'fetchFailureRate', ok: fetchFailureOk, countGuard: false },
        ],
        discoveredCount: publicCards.length,
        baselineDiscoveredCount: null,
        measurements: { ...stats, maxQuarantineRate, maxFetchFailureRate, maxDetailFetches },
      });
    }

    const finishedAt = now();
    const runStatus: CrawlRunStatus = runOk ? 'completed' : 'partial';
    const finalRun = await db.transaction(async (tx) => {
      await finishCrawlRun(tx, crawlRun.id, { finishedAt, status: runStatus, counts });
      // Past its bid deadline with no closing status read yet: expired.
      const expired = await expireOverdueListings(tx, {
        sourceId: etendersGeSource.id,
        asOf: finishedAt,
      });
      return finishCrawlRun(tx, crawlRun.id, {
        finishedAt,
        status: runStatus,
        counts: { ...counts, expiredCount: expired.expiredCount },
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
