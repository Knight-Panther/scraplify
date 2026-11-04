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
  markMissedListings,
  recordListingCheck,
} from '../../realestate/expiry.js';
import { type ListingCard, type UpsertOutcome, upsertListing } from '../../realestate/ingest.js';
import type { DealType, PropertyType } from '../../realestate/kinds.js';
import { PolicyRevisionSupersededError, withPolicyRevalidation } from '../policy-revalidation.js';
import { type DetailResult, parseDetailPage } from './detail.js';
import { parseResultsPage, RESULTS_PAGE_SIZE, type ResultsPage } from './list.js';
import { SsGePageShapeError } from './page.js';

/** The site's own words for each kind and deal, as its addresses spell them. */
export const KIND_SLUGS: Readonly<Record<PropertyType, string>> = {
  flat: 'bina',
  house: 'kerdzo-saxli',
  cottage: 'agaraki',
  commercial: 'komerciuli',
  land: 'mitsis-nakveti',
  hotel: 'sastumro',
};
export const DEAL_SLUGS: Readonly<Record<DealType, string>> = {
  sale: 'iyideba',
  rent: 'qiravdeba',
  daily: 'qiravdeba-dghiurad',
  pledge: 'giravdeba',
};

export interface SsGeList {
  /** `flat-sale` and the other keys of before Phase 12A keep their spelling, so stored progress still reads. */
  key: `${PropertyType}-${DealType}`;
  propertyType: ListingCard['propertyType'];
  dealType: ListingCard['dealType'];
  kindSlug: string;
  dealSlug: string;
}

function ssGeList(propertyType: PropertyType, dealType: DealType): SsGeList {
  return {
    key: `${propertyType}-${dealType}`,
    propertyType,
    dealType,
    kindSlug: KIND_SLUGS[propertyType],
    dealSlug: DEAL_SLUGS[dealType],
  };
}

/**
 * All six kinds for all four deals (owner, 2026-11-03), smallest first
 * (guideline §4.4): the end of a list is where this site is treacherous, and
 * walking a list of a few pages shows a fault there in minutes, where 2,800
 * pages of flats would take most of a day to reach it. The order is the
 * readable listings per list in the recon of 2026-11-03, from 1 (land for
 * daily rent) to 45,923 (flats for rent).
 */
export const SS_GE_LISTS: readonly SsGeList[] = (
  [
    ['land', 'daily'],
    ['hotel', 'pledge'],
    ['cottage', 'pledge'],
    ['commercial', 'pledge'],
    ['commercial', 'daily'],
    ['land', 'pledge'],
    ['hotel', 'daily'],
    ['house', 'pledge'],
    ['land', 'rent'],
    ['cottage', 'rent'],
    ['cottage', 'daily'],
    ['flat', 'pledge'],
    ['cottage', 'sale'],
    ['hotel', 'sale'],
    ['flat', 'daily'],
    ['house', 'daily'],
    ['hotel', 'rent'],
    ['commercial', 'sale'],
    ['house', 'sale'],
    ['land', 'sale'],
    ['house', 'rent'],
    ['commercial', 'rent'],
    ['flat', 'sale'],
    ['flat', 'rent'],
  ] as const
).map(([propertyType, dealType]) => ssGeList(propertyType, dealType));

/** A resumed walk restarts this many pages before the last one it stored. */
export const RESUME_OVERLAP_PAGES = 5;
/** How far a resumed walk steps back, doubling each time, when the list has moved up past it. */
const RESUME_STEP_PAGES = 20;
const MAX_RESUME_STEPS = 6;
/** Runs looked through for each list's last full read, which decides tonight's full reads. */
const FULL_READ_HISTORY_RUNS = 60;
/**
 * Results pages a nightly run plans to read whole lists for: about four
 * hours at the policy's spacing (3.5 s a page). The 24 lists come to about
 * 12,900 pages (2026-11-03), so each is read whole every three or four nights.
 */
export const DEEP_PAGE_BUDGET = 4_000;
/** What a list counts against that budget before its size is known. */
export const UNKNOWN_LIST_PAGES = 1_000;
/** An interrupted walk older than this is not resumed: the lists have moved on too far. */
const MAX_RESUME_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Requests for one page before the run gives up on it. */
const MAX_PAGE_ATTEMPTS = 3;
/**
 * A nightly run reads back to the last completed run's start and this much
 * further: listings renewed while that run was still walking sit just behind
 * where it began.
 */
const NIGHTLY_OVERLAP_MS = 6 * 60 * 60 * 1000;
/**
 * Listing pages a run checks at most (guideline §9.3): about two hours at the
 * policy's spacing through the Georgian exit. Raised from 1,000 when full
 * reads began marking missed listings for checks.
 */
export const DEFAULT_MAX_DETAIL_CHECKS = 1_500;
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
  /** The oldest order time on the last page stored, which a resumed walk must not skip past. */
  oldestSeenAt?: string;
  /** How many listings the site said the list could show, on the last page read. */
  total?: number;
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
  /**
   * The lists a nightly run reads to their end instead of stopping at rows
   * the last run saw: each night those whose last full read is oldest, as
   * many as fit `DEEP_PAGE_BUDGET` (`listsDueForFullRead`). A full read
   * refreshes every listing in it, catches price edits made without a
   * renewal, and marks for checking the listings it no longer finds
   * (`markMissedListings`). Runs before Phase 12A stored one key here.
   */
  deep?: SsGeList['key'][];
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
  /** Start at page 1 even when an interrupted walk could be resumed. */
  fresh?: boolean;
  /** Pages a nightly run plans for whole-list reads; `DEEP_PAGE_BUDGET` unless a test says otherwise. */
  deepPageBudget?: number;
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
  /** Each list's size as last known before this run (`knownListings`); absent when never sized. */
  knownListings: ReadonlyMap<SsGeList['key'], number>;
  /** Why the run stopped short; null while it has not. */
  stopReason: string | null;
  /** The site refused or would not answer: no further request is made in this run. */
  siteTrouble: boolean;
}

/**
 * Records why the run stops short. `siteTrouble` also ends its requests.
 * The reasons' wording is read back as fixed words for Hermes
 * (`realEstateStopReason` in src/hermes/event.ts): change one there too.
 */
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
 * A page that carries no data, or no rows, counts as not loaded: the site
 * answers a page past the end with page 1, never with nothing, so an empty
 * page is a fault in the answer and must not read as "the list ends here".
 * The one exception is an empty list, which the site states itself: page 1,
 * no rows, and a total of 0 (land for daily rent has had one listing, and
 * none, 2026-11-03). It is believed only of a list never sized or last known
 * to fit on one page: from a larger one it is a fault like any other, since a
 * site answering every list with its empty default would otherwise end the
 * run as complete and move the nightly baseline past rows it never read.
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
      const known = run.knownListings.get(list.key);
      const mayBeEmpty = known === undefined || known <= RESULTS_PAGE_SIZE;
      if (page === 1 && parsed.listTotal === 0 && mayBeEmpty) {
        return { parsed, fetchedAt: fetched.fetchedAt };
      }
      reason =
        page === 1 && parsed.listTotal === 0
          ? `no listings, from a list that last held ${known}`
          : 'a page with no rows';
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

/**
 * Where a resumed walk starts. New and renewed listings push the rows below
 * them deeper, which only means some are read twice. But a listing renewed,
 * deleted or expired above where the walk stopped moves every row below it up
 * one, and after a long pause enough of that can carry unread rows past "a
 * few pages back". So the page is checked against the oldest order time the
 * walk had stored: if every row on it is older, the walk steps back (20
 * pages, then 40, and so on) until it overlaps what it read. In the unordered
 * tail of a sale list the check passes at once, which is safe. Returns the
 * page to start from, with its read when that page was the one accepted, or
 * null when the run stopped.
 */
async function resumePoint(
  run: RunState,
  list: SsGeList,
  page: number,
  oldestSeenMs: number,
): Promise<{ page: number; read: PageRead | null } | null> {
  let at = page;
  let step = RESUME_STEP_PAGES;
  for (let attempt = 0; attempt < MAX_RESUME_STEPS; attempt++) {
    const read = await readResultsPage(run, list, at);
    if (read === null) return null;
    const newestMs = Math.max(
      Number.NEGATIVE_INFINITY,
      ...read.parsed.cards.map((card) => Date.parse(card.sourceUpdatedAt)),
    );
    if (newestMs >= oldestSeenMs || at === 1) return { page: at, read };
    at = Math.max(1, at - step);
    step *= 2;
  }
  return { page: at, read: null };
}

/** Walks one list from where its progress says, storing every row, until it ends or the run stops. */
async function walkList(run: RunState, list: SsGeList, olderThanMs: number | null): Promise<void> {
  let state = run.progress.lists[list.key];
  if (state === undefined) {
    state = { lastPage: 0, finished: null };
    run.progress.lists[list.key] = state;
  }
  if (state.finished !== null) return;

  // A resumed walk restarts a little before where it stopped (`resumePoint`).
  // A fresh walk has stored no page, and this is page 1.
  let page = Math.max(1, state.lastPage - RESUME_OVERLAP_PAGES + 1);
  let pending: PageRead | null = null;
  if (state.lastPage > 0 && state.oldestSeenAt !== undefined) {
    const resumed = await resumePoint(run, list, page, Date.parse(state.oldestSeenAt));
    if (resumed === null) return;
    page = resumed.page;
    pending = resumed.read;
  }
  let pastEndSeen = false;
  while (run.stopReason === null) {
    if (run.pagesLeft <= 0) {
      stop(run, 'page limit reached', false);
      return;
    }
    const read = pending ?? (await readResultsPage(run, list, page));
    pending = null;
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
    if (read.parsed.listTotal !== null) state.total = read.parsed.listTotal;
    const oldestMs = Math.min(
      Number.POSITIVE_INFINITY,
      ...read.parsed.cards.map((card) => Date.parse(card.sourceUpdatedAt)),
    );
    if (Number.isFinite(oldestMs)) state.oldestSeenAt = new Date(oldestMs).toISOString();

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
    else if (outcome === 'verified') run.counters.verifiedCount++;
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
    const state: SsGeListProgress = { lastPage: entry.lastPage, finished };
    if (typeof entry.oldestSeenAt === 'string' && !Number.isNaN(Date.parse(entry.oldestSeenAt))) {
      state.oldestSeenAt = entry.oldestSeenAt;
    }
    if (typeof entry.total === 'number' && Number.isInteger(entry.total) && entry.total >= 0) {
      state.total = entry.total;
    }
    lists[list.key] = state;
  }
  // One key before Phase 12A, a list of them since.
  const named: unknown[] = Array.isArray(candidate.deep) ? candidate.deep : [candidate.deep];
  const deep = SS_GE_LISTS.filter((list) => named.includes(list.key)).map((list) => list.key);
  return {
    walkStartedAt: candidate.walkStartedAt,
    lists,
    ...(candidate.deep === undefined ? {} : { deep }),
  };
}

/**
 * The progress of the latest run of this mode, when it stopped short recently
 * enough to carry on from. A nightly run resumes too: each one reads back to
 * the last completed run, so without this a run that kept failing part-way
 * redid the same pages every night, and after a long enough outage its
 * catch-up could outgrow the unit's 20-hour limit and never complete.
 */
async function interruptedWalk(
  db: Database,
  mode: RunSsGeCrawlOptions['mode'],
  nowMs: number,
): Promise<SsGeRunProgress | null> {
  const [latest] = await db
    .select({ status: realEstateCrawlRuns.status, progress: realEstateCrawlRuns.progress })
    .from(realEstateCrawlRuns)
    .where(and(eq(realEstateCrawlRuns.sourceId, ssGeSource.id), eq(realEstateCrawlRuns.mode, mode)))
    .orderBy(desc(realEstateCrawlRuns.startedAt))
    .limit(1);
  if (latest === undefined || latest.status === 'completed') return null;
  const progress = readProgress(latest.progress);
  if (progress === null || nowMs - Date.parse(progress.walkStartedAt) > MAX_RESUME_AGE_MS)
    return null;
  return progress;
}

/** What past runs say about each list: its latest full read, and the latest size the site stated. */
interface ListHistory {
  lastFullRead: Map<SsGeList['key'], { walkMs: number; pages: number }>;
  lastTotal: Map<SsGeList['key'], number>;
}

async function readListHistory(db: Database): Promise<ListHistory> {
  const recent = await db
    .select({ progress: realEstateCrawlRuns.progress })
    .from(realEstateCrawlRuns)
    .where(eq(realEstateCrawlRuns.sourceId, ssGeSource.id))
    .orderBy(desc(realEstateCrawlRuns.startedAt))
    .limit(FULL_READ_HISTORY_RUNS);
  const history: ListHistory = { lastFullRead: new Map(), lastTotal: new Map() };
  for (const row of recent) {
    const progress = readProgress(row.progress);
    if (progress === null) continue;
    const walkMs = Date.parse(progress.walkStartedAt);
    for (const list of SS_GE_LISTS) {
      const state = progress.lists[list.key];
      // Newest run first: the first total seen is the latest.
      if (state?.total !== undefined && !history.lastTotal.has(list.key)) {
        history.lastTotal.set(list.key, state.total);
      }
      if (state?.finished !== 'end') continue;
      const known = history.lastFullRead.get(list.key);
      if (known === undefined || walkMs > known.walkMs) {
        history.lastFullRead.set(list.key, { walkMs, pages: state.lastPage });
      }
    }
  }
  return history;
}

/**
 * How many listings each list last held: the size the site last stated, or,
 * for a list read before sizes were kept, the pages of its last full read at
 * a full page each. Lists never sized are absent.
 */
function knownListings(history: ListHistory): Map<SsGeList['key'], number> {
  const sizes = new Map<SsGeList['key'], number>();
  for (const list of SS_GE_LISTS) {
    const total = history.lastTotal.get(list.key);
    const read = history.lastFullRead.get(list.key);
    if (total !== undefined) sizes.set(list.key, total);
    else if (read !== undefined) sizes.set(list.key, read.pages * RESULTS_PAGE_SIZE);
  }
  return sizes;
}

/**
 * The lists tonight's run reads whole: never read whole first, then the
 * oldest full read, ties in the order of SS_GE_LISTS, for as long as their
 * pages fit `budget`. The first that does not fit ends the choice, which
 * keeps the choice simple and bounded; one list is always chosen.
 *
 * A list's size is the last page of its latest full read. One never read
 * whole counts as its last stated size in pages, or `UNKNOWN_LIST_PAGES`
 * when no run has seen it yet.
 */
function chooseFullReads(history: ListHistory, budget: number): SsGeList['key'][] {
  const { lastFullRead, lastTotal } = history;
  const sizeOf = (key: SsGeList['key']): number => {
    const read = lastFullRead.get(key);
    if (read !== undefined) return read.pages;
    const total = lastTotal.get(key);
    return total === undefined ? UNKNOWN_LIST_PAGES : Math.ceil(total / RESULTS_PAGE_SIZE);
  };
  const due = SS_GE_LISTS.map((list, index) => ({
    key: list.key,
    index,
    readMs: lastFullRead.get(list.key)?.walkMs ?? Number.NEGATIVE_INFINITY,
  })).sort((a, b) => a.readMs - b.readMs || a.index - b.index);

  const chosen: SsGeList['key'][] = [];
  let pages = 0;
  for (const list of due) {
    const size = sizeOf(list.key);
    if (chosen.length > 0 && pages + size > budget) break;
    chosen.push(list.key);
    pages += size;
  }
  return chosen;
}

/** `chooseFullReads` over this source's recent runs. */
export async function listsDueForFullRead(
  db: Database,
  budget: number = DEEP_PAGE_BUDGET,
): Promise<SsGeList['key'][]> {
  return chooseFullReads(await readListHistory(db), budget);
}

/**
 * One ss.ge run (docs/real-estate-implementation-guideline.md §9): walks the
 * 24 lists newest first and stores every row through `upsertListing`.
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
    options.fresh === true ? null : await interruptedWalk(db, options.mode, Date.parse(startedAt));
  const progress: SsGeRunProgress = resumed ?? { walkStartedAt: startedAt, lists: {} };
  const history = await readListHistory(db);
  if (options.mode === 'nightly' && progress.deep === undefined) {
    progress.deep = chooseFullReads(history, options.deepPageBudget ?? DEEP_PAGE_BUDGET);
  }
  const deep = progress.deep ?? [];
  const unfinishedAtStart = SS_GE_LISTS.filter(
    (list) => (progress.lists[list.key]?.finished ?? null) === null,
  );

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
    knownListings: knownListings(history),
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
      await walkList(run, list, deep.includes(list.key) ? null : olderThanMs);
    }

    // A list read to its end in this run, from page 1 since the walk began:
    // whatever of it was not seen since then is missing from it.
    for (const list of unfinishedAtStart) {
      if (progress.lists[list.key]?.finished !== 'end') continue;
      const missed = await markMissedListings(db, {
        sourceId: ssGeSource.id,
        dealType: list.dealType,
        propertyType: list.propertyType,
        readStartedAt: progress.walkStartedAt,
        at: now(),
      });
      logger.info({ list: list.key, missed }, 'ss.ge crawl: a full read of a list ended');
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
