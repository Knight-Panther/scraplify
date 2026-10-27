import { and, desc, eq, ne } from 'drizzle-orm';
import { extendSourceBackoff, getSourceBackoffUntil } from '../../db/ingest.js';
import { type RealEstateCrawlRunRow, realEstateCrawlRuns, sources } from '../../db/schema/index.js';
import { type SyncSourcePolicyResult, syncSourcePolicy } from '../../db/source-policies.js';
import type { Database } from '../../db/types.js';
import { logger } from '../../logger.js';
import { responseBackoffUntil } from '../../net/fetch-control.js';
import type { HttpFetcher, HttpFetchResult } from '../../net/http-fetcher.js';
import { ProxyUnreachableError } from '../../net/proxy-recovery.js';
import { ssGePolicy, ssGeSource } from '../../policies/ss-ge.js';
import {
  deleteLongGoneListings,
  loadListingsDueForCheck,
  markLapsedListingsGone,
  recordListingCheck,
} from '../../realestate/expiry.js';
import { type ListingCard, type UpsertOutcome, upsertListing } from '../../realestate/ingest.js';
import { PolicyRevisionSupersededError, withPolicyRevalidation } from '../policy-revalidation.js';
import { type DetailResult, parseDetailPage } from './detail.js';
import { parseResultsPage, RESULTS_PAGE_SIZE, type ResultsPage } from './list.js';
import { SsGePageShapeError } from './page.js';

export interface SsGeList {
  key: 'flat-sale' | 'flat-rent' | 'house-sale' | 'house-rent' | 'cottage-sale' | 'cottage-rent';
  propertyType: ListingCard['propertyType'];
  dealType: ListingCard['dealType'];
  /** The site's own words for the kind and the deal, as its addresses spell them. */
  kindSlug: string;
  dealSlug: string;
}

/**
 * Smallest first (guideline §4.4): the end of a list is where this site is
 * treacherous, and walking 21 pages of cottages shows a fault there in
 * minutes, where 2,800 pages of flats would take most of a day to reach it.
 */
export const SS_GE_LISTS: readonly SsGeList[] = [
  {
    key: 'cottage-rent',
    propertyType: 'cottage',
    dealType: 'rent',
    kindSlug: 'agaraki',
    dealSlug: 'qiravdeba',
  },
  {
    key: 'cottage-sale',
    propertyType: 'cottage',
    dealType: 'sale',
    kindSlug: 'agaraki',
    dealSlug: 'iyideba',
  },
  {
    key: 'house-sale',
    propertyType: 'house',
    dealType: 'sale',
    kindSlug: 'kerdzo-saxli',
    dealSlug: 'iyideba',
  },
  {
    key: 'house-rent',
    propertyType: 'house',
    dealType: 'rent',
    kindSlug: 'kerdzo-saxli',
    dealSlug: 'qiravdeba',
  },
  {
    key: 'flat-sale',
    propertyType: 'flat',
    dealType: 'sale',
    kindSlug: 'bina',
    dealSlug: 'iyideba',
  },
  {
    key: 'flat-rent',
    propertyType: 'flat',
    dealType: 'rent',
    kindSlug: 'bina',
    dealSlug: 'qiravdeba',
  },
];

/** A resumed sweep restarts this many pages before the last one it stored. */
export const RESUME_OVERLAP_PAGES = 5;
/** An interrupted sweep older than this is not resumed: the lists have moved on too far. */
const MAX_RESUME_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Requests for one page before the run gives up on it. */
const MAX_PAGE_ATTEMPTS = 3;
/**
 * A nightly run reads back to the last completed run's start and this much
 * further: listings renewed while that run was still walking sit just behind
 * where it began.
 */
const NIGHTLY_OVERLAP_MS = 6 * 60 * 60 * 1000;
/** Listing pages a run checks at most: about 70 minutes at the policy's spacing (guideline §9.3). */
export const DEFAULT_MAX_DETAIL_CHECKS = 1_000;
/** Listing pages failing one after another before the run stops asking. */
const MAX_DETAIL_FAILURES_IN_A_ROW = 5;

/** A nightly run has no completed run to measure from. */
export class SsGeNoBaselineError extends Error {
  constructor() {
    super(
      'ss.ge nightly run: no completed run to measure from. Run a sweep first (--mode=sweep); it reads every list to its end and takes most of a day.',
    );
    this.name = 'SsGeNoBaselineError';
  }
}

export interface SsGeListProgress {
  /** The last page whose rows were stored. */
  lastPage: number;
  /** How the walk of this list ended: it ran out, or (nightly) reached rows already seen. Null while it has not. */
  finished: 'end' | 'caught-up' | null;
}

export interface SsGeRunProgress {
  /**
   * When the walk this run belongs to began: its own start, or the start of
   * the interrupted sweep it resumed. The next nightly run measures from
   * here, so a list finished in the first instalment is not left unread for
   * the time the later instalments took.
   */
  walkStartedAt: string;
  lists: Partial<Record<SsGeList['key'], SsGeListProgress>>;
}

export interface RunSsGeCrawlDeps {
  db: Database;
  httpFetcher: HttpFetcher;
  now?: () => string;
}

export interface RunSsGeCrawlOptions {
  /** `sweep` reads every list to its end; `nightly` stops each list at rows the last run already saw. */
  mode: 'sweep' | 'nightly';
  /** Stop after storing this many results pages, leaving the run partial: a trial, or a sweep in instalments. */
  maxPages?: number;
  /** Upper bound on detail-page checks. */
  maxDetailChecks?: number;
  /** Start a sweep at page 1 even when an interrupted one could be resumed. */
  fresh?: boolean;
}

export interface RunSsGeCrawlResult {
  crawlRun: RealEstateCrawlRunRow;
}

/** Seeds the source row and syncs the policy, exactly like the job-board adapters do. */
export async function ensureSsGeSourceSeeded(db: Database): Promise<SyncSourcePolicyResult> {
  await db
    .insert(sources)
    .values({
      id: ssGeSource.id,
      slug: ssGeSource.slug,
      displayName: ssGeSource.displayName,
      baseUrl: ssGeSource.baseUrl,
    })
    .onConflictDoNothing();
  return await syncSourcePolicy(db, ssGePolicy);
}

export function buildResultsUrl(list: SsGeList, page: number): string {
  const url = new URL(`/ka/udzravi-qoneba/l/${list.kindSlug}/${list.dealSlug}`, ssGeSource.baseUrl);
  // order=1 is newest first. Without it the list is promoted-first.
  url.search = new URLSearchParams([
    ['order', '1'],
    ['page', String(page)],
  ]).toString();
  return url.toString();
}

/** By id alone: the site ignores any slug, and a slug would only be one more thing to get wrong. */
export function buildDetailUrl(sourceListingKey: string): string {
  return new URL(`/ka/udzravi-qoneba/${sourceListingKey}`, ssGeSource.baseUrl).toString();
}

type Counters = Pick<
  RealEstateCrawlRunRow,
  | 'requestCount'
  | 'failedRequestCount'
  | 'pageCount'
  | 'rowCount'
  | 'newCount'
  | 'changedCount'
  | 'bumpedCount'
  | 'unchangedCount'
  | 'reopenedCount'
  | 'goneCount'
  | 'verifiedCount'
>;

const OUTCOME_COUNTER: Readonly<Record<UpsertOutcome, keyof Counters>> = {
  new: 'newCount',
  changed: 'changedCount',
  bumped: 'bumpedCount',
  unchanged: 'unchangedCount',
  reopened: 'reopenedCount',
};

/** Everything one run carries from request to request. */
interface RunState {
  db: Database;
  httpFetcher: HttpFetcher;
  now: () => string;
  runId: string;
  counters: Counters;
  progress: SsGeRunProgress;
  /** Results pages this run may still store. */
  pagesLeft: number;
  /** Why the run stopped short; null while it has not. */
  stopReason: string | null;
  /** The site refused or would not answer: no further request is made in this run. */
  siteTrouble: boolean;
}

/** Records why the run stops short. `siteTrouble` also ends its requests. */
function stop(run: RunState, reason: string, siteTrouble: boolean): void {
  run.stopReason = run.stopReason === null ? reason : `${run.stopReason}; ${reason}`;
  if (siteTrouble) run.siteTrouble = true;
}

type Fetched =
  | { kind: 'ok'; body: string; fetchedAt: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'refused'; reason: string };

function describeRefusal(result: HttpFetchResult): string {
  return `the site answered HTTP ${result.status}`;
}

/**
 * One request. A refusal (403, 429, any "slow down" header) ends the run and
 * is remembered for the next one. A proxy that stayed away past the run's
 * wait for it (src/net/proxy-recovery.ts) ends the run too, and is not
 * remembered. Anything else that is not a page is a failure the caller may
 * try again.
 */
async function request(run: RunState, url: string): Promise<Fetched> {
  const fetchedAt = run.now();
  run.counters.requestCount++;
  let result: HttpFetchResult;
  try {
    result = await run.httpFetcher.fetch(url);
  } catch (err) {
    if (err instanceof PolicyRevisionSupersededError) throw err;
    run.counters.failedRequestCount++;
    if (err instanceof ProxyUnreachableError) return { kind: 'refused', reason: err.message };
    return { kind: 'failed', reason: err instanceof Error ? err.name : 'unknown error' };
  }

  const backoffUntil = responseBackoffUntil(result, fetchedAt);
  if (backoffUntil !== null)
    await extendSourceBackoff(run.db, ssGeSource.id, backoffUntil, fetchedAt);
  if (backoffUntil !== null || result.status === 403 || result.status === 202) {
    run.counters.failedRequestCount++;
    return { kind: 'refused', reason: describeRefusal(result) };
  }
  if (result.status !== 200) {
    run.counters.failedRequestCount++;
    return { kind: 'failed', reason: `HTTP ${result.status}` };
  }
  return { kind: 'ok', body: result.body, fetchedAt };
}

async function saveRun(run: RunState, extra: Partial<RealEstateCrawlRunRow> = {}): Promise<void> {
  await run.db
    .update(realEstateCrawlRuns)
    .set({ ...run.counters, progress: run.progress, ...extra })
    .where(eq(realEstateCrawlRuns.id, run.runId));
}

interface PageRead {
  parsed: ResultsPage;
  fetchedAt: string;
}

/**
 * One results page, asked for up to three times. Null means the run has
 * stopped: the page would not load, or the site refused.
 *
 * A page that carries no data, or no rows, counts as not loaded. Every list
 * here holds thousands of listings, and the site answers a page past the end
 * with page 1, never with nothing, so an empty page is a fault in the answer
 * and must not read as "the list ends here".
 */
async function readResultsPage(
  run: RunState,
  list: SsGeList,
  page: number,
): Promise<PageRead | null> {
  const url = buildResultsUrl(list, page);
  let reason = '';
  for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt++) {
    const fetched = await request(run, url);
    if (fetched.kind === 'refused') {
      stop(run, `${list.key} page ${page}: ${fetched.reason}`, true);
      return null;
    }
    if (fetched.kind === 'failed') {
      reason = fetched.reason;
      continue;
    }
    try {
      const parsed = parseResultsPage(fetched.body, {
        propertyType: list.propertyType,
        dealType: list.dealType,
        page,
      });
      if (parsed.pastEnd || parsed.rowCount > 0) return { parsed, fetchedAt: fetched.fetchedAt };
      reason = 'a page with no rows';
    } catch (err) {
      if (!(err instanceof SsGePageShapeError)) throw err;
      reason = err.message;
    }
    run.counters.failedRequestCount++;
  }
  stop(
    run,
    `${list.key} page ${page} would not load after ${MAX_PAGE_ATTEMPTS} tries (${reason})`,
    true,
  );
  return null;
}

/**
 * Postgres refused a value in the row itself (SQLSTATE class 22: a number out
 * of range, a string too long, a character it cannot store). Drizzle wraps the
 * driver's error, so the code is on its cause.
 */
function isRefusedRowValue(err: unknown): boolean {
  const cause = err instanceof Error && err.cause !== undefined ? err.cause : err;
  const code =
    typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : null;
  return typeof code === 'string' && code.startsWith('22');
}

/** Walks one list from where its progress says, storing every row, until it ends or the run stops. */
async function walkList(run: RunState, list: SsGeList, olderThanMs: number | null): Promise<void> {
  let state = run.progress.lists[list.key];
  if (state === undefined) {
    state = { lastPage: 0, finished: null };
    run.progress.lists[list.key] = state;
  }
  if (state.finished !== null) return;

  // Renewed listings jump to the front and push the rest deeper, so a
  // resumed walk restarts a little before where it stopped. A fresh walk has
  // stored no page, and this is page 1.
  let page = Math.max(1, state.lastPage - RESUME_OVERLAP_PAGES + 1);
  let pastEndSeen = false;
  while (run.stopReason === null) {
    if (run.pagesLeft <= 0) {
      stop(run, 'page limit reached', false);
      return;
    }
    const read = await readResultsPage(run, list, page);
    if (read === null) return;

    if (read.parsed.pastEnd) {
      // The site answered with page 1: past the end of the list, and these
      // rows are not this page's. Asked twice, because one such answer in
      // the middle of a list would end a sweep thousands of pages early.
      if (pastEndSeen) {
        state.finished = 'end';
        await saveRun(run);
        return;
      }
      pastEndSeen = true;
      continue;
    }
    pastEndSeen = false;

    for (const card of read.parsed.cards) {
      let outcome: UpsertOutcome;
      try {
        outcome = await upsertListing(run.db, {
          sourceId: ssGeSource.id,
          card,
          seenAt: read.fetchedAt,
        });
      } catch (err) {
        // One listing's bad value must not end the night: a hidden control
        // character (2026-10-12) and an area of 100,000,000 m² (2026-10-26)
        // each did. Each row has its own transaction, so nothing of it is
        // kept, and the parser is where such a value gets fixed.
        if (!isRefusedRowValue(err)) throw err;
        logger.warn(
          {
            listing: card.sourceListingKey,
            reason: err instanceof Error ? (err.cause ?? err).toString().slice(0, 200) : null,
          },
          'ss.ge crawl: the database refused a listing; skipped it',
        );
        continue;
      }
      run.counters[OUTCOME_COUNTER[outcome]]++;
    }
    run.counters.pageCount++;
    run.counters.rowCount += read.parsed.cards.length;
    run.pagesLeft--;
    state.lastPage = page;

    if (read.parsed.rowCount < RESULTS_PAGE_SIZE) {
      state.finished = 'end';
    } else if (
      olderThanMs !== null &&
      read.parsed.cards.length > 0 &&
      read.parsed.cards.every((card) => Date.parse(card.sourceUpdatedAt) < olderThanMs)
    ) {
      state.finished = 'caught-up';
    }
    await saveRun(run);
    if (state.finished !== null) return;
    page++;
  }
}

/**
 * Asks the own page of each listing past its expected end (guideline §9.3):
 * live ones are extended, the others marked gone. A page that does not load
 * says nothing about its listing, which waits for the next run.
 */
async function checkDueListings(run: RunState, limit: number): Promise<void> {
  const due = await loadListingsDueForCheck(run.db, {
    sourceId: ssGeSource.id,
    asOf: run.now(),
    limit,
  });
  let failuresInARow = 0;
  for (const [index, listing] of due.entries()) {
    const fetched = await request(run, buildDetailUrl(listing.sourceListingKey));
    if (fetched.kind === 'refused') {
      stop(run, `listing ${listing.sourceListingKey}: ${fetched.reason}`, true);
      break;
    }
    let check: DetailResult | null = null;
    if (fetched.kind === 'ok') {
      try {
        check = parseDetailPage(fetched.body, listing.sourceListingKey);
      } catch (err) {
        if (!(err instanceof SsGePageShapeError)) throw err;
        run.counters.failedRequestCount++;
      }
    }
    if (check === null || fetched.kind !== 'ok') {
      if (++failuresInARow >= MAX_DETAIL_FAILURES_IN_A_ROW) {
        stop(run, `${MAX_DETAIL_FAILURES_IN_A_ROW} listing pages in a row would not load`, true);
        break;
      }
      continue;
    }
    failuresInARow = 0;
    const outcome = await recordListingCheck(run.db, {
      listingId: listing.id,
      check,
      checkedAt: fetched.fetchedAt,
    });
    if (outcome === 'gone') run.counters.goneCount++;
    else run.counters.verifiedCount++;
    if (index % 25 === 24) await saveRun(run);
  }
  await saveRun(run);
}

/**
 * Where a nightly run may stop reading a list: rows last ordered before the
 * last completed run began, less an overlap. Measured from the start of that
 * run's whole walk, which for a sweep run in instalments is the first one.
 */
async function nightlyCutoffMs(db: Database): Promise<number> {
  const [last] = await db
    .select({ startedAt: realEstateCrawlRuns.startedAt, progress: realEstateCrawlRuns.progress })
    .from(realEstateCrawlRuns)
    .where(
      and(
        eq(realEstateCrawlRuns.sourceId, ssGeSource.id),
        eq(realEstateCrawlRuns.status, 'completed'),
      ),
    )
    .orderBy(desc(realEstateCrawlRuns.startedAt))
    .limit(1);
  if (last === undefined) throw new SsGeNoBaselineError();
  const walkStartedAt = readProgress(last.progress)?.walkStartedAt ?? last.startedAt;
  return new Date(walkStartedAt).getTime() - NIGHTLY_OVERLAP_MS;
}

/**
 * The caller holds this source's crawl lock, so a run still marked running
 * belongs to a process that died. Its counters and progress were saved after
 * every page, and a later sweep resumes from them.
 */
async function settleOrphanRuns(db: Database, at: string): Promise<void> {
  await db
    .update(realEstateCrawlRuns)
    .set({ status: 'failed', finishedAt: at, notes: 'the process ended before the run did' })
    .where(
      and(
        eq(realEstateCrawlRuns.sourceId, ssGeSource.id),
        eq(realEstateCrawlRuns.status, 'running'),
      ),
    );
}

function readProgress(value: unknown): SsGeRunProgress | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<SsGeRunProgress>;
  if (
    typeof candidate.walkStartedAt !== 'string' ||
    Number.isNaN(Date.parse(candidate.walkStartedAt))
  ) {
    return null;
  }
  if (typeof candidate.lists !== 'object' || candidate.lists === null) return null;
  const lists: SsGeRunProgress['lists'] = {};
  for (const list of SS_GE_LISTS) {
    const entry = candidate.lists[list.key];
    if (entry === undefined || !Number.isInteger(entry.lastPage) || entry.lastPage < 0) continue;
    const finished =
      entry.finished === 'end' || entry.finished === 'caught-up' ? entry.finished : null;
    lists[list.key] = { lastPage: entry.lastPage, finished };
  }
  return { walkStartedAt: candidate.walkStartedAt, lists };
}

/** The progress of the latest sweep, when it stopped short recently enough to carry on from. */
async function interruptedSweep(db: Database, nowMs: number): Promise<SsGeRunProgress | null> {
  const [latest] = await db
    .select({ status: realEstateCrawlRuns.status, progress: realEstateCrawlRuns.progress })
    .from(realEstateCrawlRuns)
    .where(
      and(eq(realEstateCrawlRuns.sourceId, ssGeSource.id), eq(realEstateCrawlRuns.mode, 'sweep')),
    )
    .orderBy(desc(realEstateCrawlRuns.startedAt))
    .limit(1);
  if (latest === undefined || latest.status === 'completed') return null;
  const progress = readProgress(latest.progress);
  if (progress === null || nowMs - Date.parse(progress.walkStartedAt) > MAX_RESUME_AGE_MS)
    return null;
  return progress;
}

/**
 * One ss.ge run (docs/real-estate-implementation-guideline.md §9): walks the
 * six lists newest first and stores every row through `upsertListing`.
 *
 * The caller must hold this source's crawl-process lock.
 */
export async function runSsGeCrawl(
  deps: RunSsGeCrawlDeps,
  options: RunSsGeCrawlOptions,
): Promise<RunSsGeCrawlResult> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  const policySync = await ensureSsGeSourceSeeded(db);
  if (policySync.outcome === 'refused-stale') {
    throw new Error(
      `runSsGeCrawl: refusing to crawl -- this deployment's ssGePolicy was refused as stale against the database's current revision for source ${ssGeSource.id}.`,
    );
  }
  const httpFetcher = withPolicyRevalidation(
    deps.httpFetcher,
    db,
    ssGeSource.id,
    policySync.currentRevisionId,
  );

  const startedAt = now();
  await settleOrphanRuns(db, startedAt);
  const olderThanMs = options.mode === 'nightly' ? await nightlyCutoffMs(db) : null;
  const resumed =
    options.mode === 'sweep' && options.fresh !== true
      ? await interruptedSweep(db, Date.parse(startedAt))
      : null;
  const progress: SsGeRunProgress = resumed ?? { walkStartedAt: startedAt, lists: {} };

  const [inserted] = await db
    .insert(realEstateCrawlRuns)
    .values({ sourceId: ssGeSource.id, mode: options.mode, startedAt, progress })
    .returning({ id: realEstateCrawlRuns.id });
  if (inserted === undefined) throw new Error('runSsGeCrawl: the run row was not created');

  const run: RunState = {
    db,
    httpFetcher,
    now,
    runId: inserted.id,
    counters: {
      requestCount: 0,
      failedRequestCount: 0,
      pageCount: 0,
      rowCount: 0,
      newCount: 0,
      changedCount: 0,
      bumpedCount: 0,
      unchangedCount: 0,
      reopenedCount: 0,
      goneCount: 0,
      verifiedCount: 0,
    },
    progress,
    pagesLeft: options.maxPages ?? Number.POSITIVE_INFINITY,
    stopReason: null,
    siteTrouble: false,
  };
  const maxDetailChecks = options.maxDetailChecks ?? DEFAULT_MAX_DETAIL_CHECKS;

  try {
    const backoffUntil = await getSourceBackoffUntil(db, ssGeSource.id);
    if (backoffUntil !== null && Date.parse(backoffUntil) > Date.parse(startedAt)) {
      stop(
        run,
        `the site asked for no requests until ${new Date(backoffUntil).toISOString()}`,
        true,
      );
    }

    for (const list of SS_GE_LISTS) {
      if (run.stopReason !== null) break;
      await walkList(run, list, olderThanMs);
    }

    // A trial that stopped at its page limit still checks; a run the site
    // refused, or would not answer, asks for nothing more.
    if (!run.siteTrouble && maxDetailChecks > 0) await checkDueListings(run, maxDetailChecks);

    // Not after site trouble: listings this run never had the chance to see
    // again must not be given up on its account.
    if (!run.siteTrouble) {
      const asOf = now();
      run.counters.goneCount += await markLapsedListingsGone(db, {
        sourceId: ssGeSource.id,
        asOf,
      });
      await deleteLongGoneListings(db, { sourceId: ssGeSource.id, asOf });
    }

    await saveRun(run, {
      finishedAt: now(),
      status: run.stopReason === null ? 'completed' : 'partial',
      notes: run.stopReason,
    });
  } catch (err) {
    await saveRun(run, {
      finishedAt: now(),
      status: 'failed',
      notes: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 500) : 'unknown error',
    });
    throw err;
  }

  const [crawlRun] = await db
    .select()
    .from(realEstateCrawlRuns)
    .where(and(eq(realEstateCrawlRuns.id, run.runId), ne(realEstateCrawlRuns.status, 'running')));
  if (crawlRun === undefined) throw new Error('runSsGeCrawl: the run row is missing');
  return { crawlRun };
}
