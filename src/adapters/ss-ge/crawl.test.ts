import { desc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/client.js';
import { getSourceBackoffUntil } from '../../db/ingest.js';
import {
  realEstateCrawlRuns,
  realEstateListings,
  realEstatePlaces,
} from '../../db/schema/index.js';
import { cleanupTestSource } from '../../db/test-support.js';
import type { HttpFetcher, HttpFetchResult } from '../../net/http-fetcher.js';
import { ProxyUnreachableError, withProxyRecovery } from '../../net/proxy-recovery.js';
import { isSsGeUrlAllowed, ssGeSource } from '../../policies/ss-ge.js';
import { loadListingsDueForCheck } from '../../realestate/expiry.js';
import { syncPlaces } from '../../realestate/places.js';
import {
  buildDetailUrl,
  buildResultsUrl,
  DEEP_PAGE_BUDGET,
  DEFAULT_STOP_AFTER_MS,
  ensureSsGeSourceSeeded,
  listsDueForFullRead,
  MAX_REQUESTS_PER_RUN,
  RESUME_OVERLAP_PAGES,
  runSsGeCrawl,
  SS_GE_LISTS,
  type SsGeList,
  type SsGeListProgress,
  type SsGeRunProgress,
  UNKNOWN_LIST_PAGES,
} from './crawl.js';

// Every write goes to a disposable source (see the same isolation in
// src/adapters/etenders-ge/crawl.test.ts): only the ids and slug change, so
// URLs and the allow-list behave exactly as in production.
// A listing key whose row reaches the database with a value no column can
// hold, as a poster's typo once did; every other row is stored as usual.
const refusedRow = vi.hoisted(() => ({ key: null as string | null }));

vi.mock('../../realestate/ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../realestate/ingest.js')>();
  return {
    ...actual,
    upsertListing: (...args: Parameters<typeof actual.upsertListing>) => {
      const [database, input] = args;
      if (input.card.sourceListingKey !== refusedRow.key) return actual.upsertListing(...args);
      return actual.upsertListing(database, { ...input, card: { ...input.card, areaM2: 1e9 } });
    },
  };
});

// A listing key whose page reads with a kitchen area no column can hold:
// the database refuses what the page said, and the run must carry on.
const refusedPage = vi.hoisted(() => ({ key: null as string | null }));

vi.mock('./detail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./detail.js')>();
  return {
    ...actual,
    parseDetailPage: (...args: Parameters<typeof actual.parseDetailPage>) => {
      const result = actual.parseDetailPage(...args);
      if (args[1] !== refusedPage.key || result.status !== 'active') return result;
      return { ...result, details: { ...result.details, kitchenAreaM2: 1e9 } };
    },
  };
});

const testIds = vi.hoisted(() => ({
  sourceId: crypto.randomUUID(),
  policyId: crypto.randomUUID(),
}));

vi.mock('../../policies/ss-ge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../policies/ss-ge.js')>();
  return {
    ...actual,
    ssGeSource: {
      ...actual.ssGeSource,
      id: testIds.sourceId,
      slug: `crawl-test-${testIds.sourceId}`,
    },
    ssGePolicy: { ...actual.ssGePolicy, id: testIds.policyId, sourceId: testIds.sourceId },
  };
});

const NOW = Date.parse('2026-10-12T18:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TBILISI_OFFSET_MS = 4 * HOUR_MS;
const KIND_CODE = { flat: 5, house: 4, cottage: 1, commercial: 6, land: 3, hotel: 2 } as const;
const DEAL_CODE = { sale: 4, rent: 1, daily: 3, pledge: 2 } as const;

type ListKey = SsGeList['key'];
/** Every list but the one a test fills holds one listing on one page (`FakeSite`). */
const OTHER_LISTS = SS_GE_LISTS.length - 1;

interface SiteRow {
  id: number;
  /** When the listing was last ordered, as an instant. */
  orderedAt: number;
  priceUsd?: number;
}

/** The site writes Tbilisi wall-clock; some rows carry a false "Z" (guideline trap 4). */
function wallClock(instant: number): string {
  return new Date(instant + TBILISI_OFFSET_MS).toISOString();
}

function rowJson(list: SsGeList, row: SiteRow): unknown {
  return {
    applicationId: row.id,
    type: KIND_CODE[list.propertyType],
    dealType: DEAL_CODE[list.dealType],
    title: 'იყიდება 2 ოთახიანი ბინა საბურთალოზე',
    totalArea: 60,
    floorNumber: '3',
    totalAmountOfFloor: 9,
    numberOfBedrooms: 1,
    price: {
      priceGeo: 270000,
      priceUsd: row.priceUsd ?? 100000,
      unitPriceUsd: 1600,
      currencyType: 2,
    },
    address: { cityId: 95, cityTitle: 'თბილისი', subdistrictId: 3, subdistrictTitle: 'საბურთალო' },
    orderDate: wallClock(row.orderedAt),
    createDate: wallClock(row.orderedAt),
    vipStatus: 0,
    similarityGroup: null,
    description: null,
  };
}

function page(body: Record<string, unknown>): string {
  const data = JSON.stringify({ props: { pageProps: body } });
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${data}</script></body></html>`;
}

function ok(url: string, body: string): HttpFetchResult {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body,
    finalUrl: url,
    redirectCount: 0,
  };
}

function status(
  url: string,
  code: number,
  headers: HttpFetchResult['headers'] = {},
): HttpFetchResult {
  return { status: code, headers, body: '', finalUrl: url, redirectCount: 0 };
}

/** `count` rows, newest first, one minute apart, starting `newestAgoMs` before NOW. */
function rows(firstId: number, count: number, newestAgoMs = HOUR_MS): SiteRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: firstId + index,
    orderedAt: NOW - newestAgoMs - index * 60_000,
  }));
}

type DetailState =
  /** `fields` are what else its page says (Phase 12B details), in ss.ge's own names. */
  | { status: 'Active'; endsAt: number; fields?: Record<string, unknown> }
  | { status: 'Expired' }
  | { status: 'Missing' };

/**
 * ss.ge as the walker sees it: 24 lists of 16 rows a page, page 1 served
 * for any page past the end, and a detail page for every id.
 */
class FakeSite implements HttpFetcher {
  readonly requested: string[] = [];
  /** Answers given before the site's own, one per request to that URL. */
  readonly scripted = new Map<string, (HttpFetchResult | Error)[]>();
  readonly details = new Map<string, DetailState>();
  readonly lists: Record<ListKey, SiteRow[]>;

  constructor(lists: Partial<Record<ListKey, SiteRow[]>> = {}) {
    // A list a test does not fill holds one listing. An empty one is real
    // too (land for daily rent has had one listing, and none).
    this.lists = Object.fromEntries(
      SS_GE_LISTS.map((list, index) => [list.key, lists[list.key] ?? rows(9_000 + index, 1)]),
    ) as Record<ListKey, SiteRow[]>;
  }

  script(url: string, ...answers: (HttpFetchResult | Error)[]): void {
    this.scripted.set(url, answers);
  }

  resultsRequests(list: SsGeList): number[] {
    const path = new URL(buildResultsUrl(list, 1)).pathname;
    return this.requested
      .map((url) => new URL(url))
      .filter((url) => url.pathname === path)
      .map((url) => Number(url.searchParams.get('page')));
  }

  async fetch(url: string): Promise<HttpFetchResult> {
    this.requested.push(url);
    const scripted = this.scripted.get(url)?.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted !== undefined) return scripted;

    const parsed = new URL(url);
    const list = SS_GE_LISTS.find(
      (candidate) => new URL(buildResultsUrl(candidate, 1)).pathname === parsed.pathname,
    );
    if (list === undefined)
      return ok(url, this.detailPage(parsed.pathname.split('/').at(-1) ?? ''));

    const all = this.lists[list.key];
    const asked = Number(parsed.searchParams.get('page'));
    const slice = all.slice((asked - 1) * 16, asked * 16);
    const served = slice.length === 0 && asked > 1 ? 1 : asked;
    const shown = served === asked ? slice : all.slice(0, 16);
    return ok(
      url,
      page({
        initialPage: served,
        initialTotalApplicationCount: all.length,
        applicationList: { realStateItemModel: shown.map((row) => rowJson(list, row)) },
      }),
    );
  }

  private detailPage(id: string): string {
    const state = this.details.get(id) ?? { status: 'Missing' };
    if (state.status === 'Missing') return page({});
    return page({
      applicationData: {
        applicationId: Number(id),
        status: state.status,
        isInactiveApplication: state.status !== 'Active',
        endDate: state.status === 'Active' ? wallClock(state.endsAt) : wallClock(NOW - DAY_MS),
        ...(state.status === 'Active' ? state.fields : {}),
      },
    });
  }

  async close(): Promise<void> {}
}

/** A clock that moves one second per reading, so every write has its own time. */
function clock(startMs = NOW): () => string {
  let tick = 0;
  return () => new Date(startMs + tick++ * 1000).toISOString();
}

/** The run's waits between tries of a page, taken at once (`PAGE_RETRY_WAITS_MS`). */
const noWait = async (_ms: number): Promise<void> => {};

/** A sleep that only records how long the run asked to wait. */
function recordedWaits(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { sleep: async (ms) => void waits.push(ms), waits };
}

const list = (key: ListKey): SsGeList => {
  const found = SS_GE_LISTS.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`no list ${key}`);
  return found;
};

async function storedListings() {
  return db.select().from(realEstateListings).where(eq(realEstateListings.sourceId, ssGeSource.id));
}

async function storedRuns() {
  return db
    .select()
    .from(realEstateCrawlRuns)
    .where(eq(realEstateCrawlRuns.sourceId, ssGeSource.id))
    .orderBy(desc(realEstateCrawlRuns.startedAt));
}

const progressOf = (run: { progress: unknown }) => run.progress as SsGeRunProgress;

/** Timestamps come back in Postgres's own text form; compare the instants. */
const instant = (value: string | null | undefined) => new Date(value ?? Number.NaN).getTime();

afterEach(async () => {
  await cleanupTestSource(ssGeSource.id);
});

describe('the lists', () => {
  it('are all six kinds for all four deals, 24 lists, each at an address the policy allows', () => {
    const kinds = ['flat', 'house', 'cottage', 'commercial', 'land', 'hotel'];
    const deals = ['sale', 'rent', 'daily', 'pledge'];
    expect(SS_GE_LISTS.map((entry) => entry.key).sort()).toEqual(
      kinds.flatMap((kind) => deals.map((deal) => `${kind}-${deal}`)).sort(),
    );
    // Smallest first (recon of 2026-11-03), so a fault at a list's end shows in minutes.
    expect(SS_GE_LISTS.slice(0, 3).map((entry) => entry.key)).toEqual([
      'land-daily',
      'hotel-pledge',
      'cottage-pledge',
    ]);
    expect(SS_GE_LISTS.at(-1)?.key).toBe('flat-rent');
    expect(buildResultsUrl(list('land-daily'), 1)).toBe(
      'https://home.ss.ge/ka/udzravi-qoneba/l/mitsis-nakveti/qiravdeba-dghiurad?order=1&page=1',
    );
    expect(buildResultsUrl(list('commercial-pledge'), 2)).toBe(
      'https://home.ss.ge/ka/udzravi-qoneba/l/komerciuli/giravdeba?order=1&page=2',
    );
    for (const entry of SS_GE_LISTS) {
      const url = buildResultsUrl(entry, 7);
      expect(isSsGeUrlAllowed(url), url).toBe(true);
      // Without order=1 the list is promoted-first and a walk stops in the wrong place.
      expect(new URL(url).searchParams.get('order')).toBe('1');
    }
    expect(buildResultsUrl(list('flat-sale'), 3)).toBe(
      'https://home.ss.ge/ka/udzravi-qoneba/l/bina/iyideba?order=1&page=3',
    );
    expect(buildDetailUrl('35653707')).toBe('https://home.ss.ge/ka/udzravi-qoneba/35653707');
    expect(isSsGeUrlAllowed(buildDetailUrl('35653707'))).toBe(true);
  });
});

describe('runSsGeCrawl, sweep', () => {
  it('walks every list to its end and stores each row once', async () => {
    const site = new FakeSite({
      'flat-sale': rows(1_000, 40), // 16, 16, then a short page of 8
      'house-rent': rows(2_000, 5),
    });

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ mode: 'sweep', status: 'completed', failedRequestCount: 0 });
    const stored = await storedListings();
    expect(stored).toHaveLength(40 + 5 + (OTHER_LISTS - 1));
    expect(
      stored.filter((row) => row.propertyType === 'flat' && row.dealType === 'sale'),
    ).toHaveLength(40);
    expect(
      stored.filter((row) => row.propertyType === 'house' && row.dealType === 'rent'),
    ).toHaveLength(5);
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 3]);
    expect(crawlRun).toMatchObject({
      pageCount: 3 + OTHER_LISTS,
      rowCount: 40 + 5 + (OTHER_LISTS - 1),
      newCount: 40 + 5 + (OTHER_LISTS - 1),
      requestCount: 3 + OTHER_LISTS,
    });
    expect(crawlRun.finishedAt).not.toBeNull();
    expect(progressOf(crawlRun).lists['flat-sale']).toMatchObject({ lastPage: 3, finished: 'end' });
    for (const url of site.requested) expect(isSsGeUrlAllowed(url), url).toBe(true);
  });

  it('throws away the rows of a page past the end, after asking for it twice', async () => {
    // Exactly two full pages: page 3 is past the end, and the site answers it
    // with page 1 and HTTP 200 (guideline §15, trap 1).
    const site = new FakeSite({ 'flat-sale': rows(1_000, 32) });

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun.status).toBe('completed');
    // One answer of "page 1" could be a hiccup in the middle of a list, and
    // believing it would end a sweep thousands of pages early.
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 3, 3]);
    expect(crawlRun.rowCount).toBe(32 + OTHER_LISTS);
    expect(crawlRun.unchangedCount).toBe(0);
    expect(progressOf(crawlRun).lists['flat-sale']).toMatchObject({ lastPage: 2, finished: 'end' });
  });

  it('carries on when a page past the end turns out to be a hiccup', async () => {
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    const first = site.lists['flat-sale']
      .slice(0, 16)
      .map((row) => rowJson(list('flat-sale'), row));
    const secondPage = buildResultsUrl(list('flat-sale'), 2);
    site.script(
      secondPage,
      ok(secondPage, page({ initialPage: 1, applicationList: { realStateItemModel: first } })),
    );

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun.status).toBe('completed');
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 2, 3]);
    expect(await storedListings()).toHaveLength(40 + OTHER_LISTS);
  });

  it('stops at the page limit, and the next sweep picks up a few pages before', async () => {
    const first = SS_GE_LISTS[0] as SsGeList;
    const site = new FakeSite({ [first.key]: rows(1_000, 16 * 12 + 3) }); // 13 pages

    const trial = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxPages: 9, maxDetailChecks: 0 },
    );

    expect(trial.crawlRun).toMatchObject({ status: 'partial', pageCount: 9 });
    expect(trial.crawlRun.notes).toMatch(/page limit/i);
    expect(progressOf(trial.crawlRun).lists[first.key]).toMatchObject({
      lastPage: 9,
      finished: null,
    });
    expect(await storedListings()).toHaveLength(9 * 16);

    site.requested.length = 0;
    const resumed = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW + HOUR_MS) },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(resumed.crawlRun.status).toBe('completed');
    // Renewed listings jump to the front and push the rest deeper, so the
    // walk restarts a little before where it stopped.
    const from = 9 - RESUME_OVERLAP_PAGES + 1;
    expect(site.resultsRequests(first)).toEqual(
      Array.from({ length: 13 - from + 1 }, (_, index) => from + index),
    );
    expect(await storedListings()).toHaveLength(16 * 12 + 3 + OTHER_LISTS);
    // The walk began when the first instalment did: the next nightly run
    // measures from there, not from the resumption.
    expect(instant(progressOf(resumed.crawlRun).walkStartedAt)).toBe(
      instant(trial.crawlRun.startedAt),
    );
    expect(instant(resumed.crawlRun.startedAt)).toBe(NOW + HOUR_MS);
  });

  it('does not walk again a list an interrupted sweep had finished', async () => {
    const [first, second] = SS_GE_LISTS as [SsGeList, SsGeList];
    const site = new FakeSite({ [first.key]: rows(1_000, 20), [second.key]: rows(2_000, 40) });

    await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxPages: 3, maxDetailChecks: 0 },
    );
    site.requested.length = 0;
    const resumed = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW + HOUR_MS) },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(resumed.crawlRun.status).toBe('completed');
    expect(site.resultsRequests(first)).toEqual([]);
    expect(site.resultsRequests(second)).toEqual([1, 2, 3]);
  });

  it('starts from page 1 when told to, even with an interrupted sweep to resume', async () => {
    const first = SS_GE_LISTS[0] as SsGeList;
    const site = new FakeSite({ [first.key]: rows(1_000, 16 * 8) });

    await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxPages: 7, maxDetailChecks: 0 },
    );
    site.requested.length = 0;
    const fresh = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW + HOUR_MS) },
      { mode: 'sweep', fresh: true, maxDetailChecks: 0 },
    );

    expect(site.resultsRequests(first).slice(0, 2)).toEqual([1, 2]);
    expect(instant(progressOf(fresh.crawlRun).walkStartedAt)).toBe(
      instant(fresh.crawlRun.startedAt),
    );
  });

  it('settles a run a dead process left running, and resumes from what it had recorded', async () => {
    const first = SS_GE_LISTS[0] as SsGeList;
    const site = new FakeSite({ [first.key]: rows(1_000, 16 * 10) });
    await ensureSsGeSourceSeeded(db);
    const diedAt = new Date(NOW - 2 * HOUR_MS).toISOString();
    const [orphan] = await db
      .insert(realEstateCrawlRuns)
      .values({
        sourceId: ssGeSource.id,
        mode: 'sweep',
        startedAt: diedAt,
        status: 'running',
        progress: {
          walkStartedAt: diedAt,
          lists: { [first.key]: { lastPage: 8, finished: null } },
        } satisfies SsGeRunProgress,
      })
      .returning();

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    const runs = await storedRuns();
    expect(runs.find((run) => run.id === orphan?.id)).toMatchObject({ status: 'failed' });
    expect(runs.find((run) => run.id === orphan?.id)?.finishedAt).not.toBeNull();
    expect(crawlRun.status).toBe('completed');
    expect(site.resultsRequests(first)[0]).toBe(8 - RESUME_OVERLAP_PAGES + 1);
    expect(instant(progressOf(crawlRun).walkStartedAt)).toBe(instant(diedAt));
  });

  it('asks again for a page that failed, and counts the failure', async () => {
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    const second = buildResultsUrl(list('flat-sale'), 2);
    site.script(second, new Error('socket hang up'), status(second, 502));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ status: 'completed', failedRequestCount: 2 });
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 2, 2, 3]);
    expect(await storedListings()).toHaveLength(40 + OTHER_LISTS);
  });

  /** Four failed answers for one page: all the tries it gets. */
  function unloadable(site: FakeSite, url: string): void {
    site.script(url, status(url, 500), status(url, 500), status(url, 500), status(url, 500));
  }

  it('skips a page that fails four times, after waiting a minute and then five, and reads the rest of its list', async () => {
    // ss.ge, 2026-11-09 and 11-10: one page of flats for daily rent came back
    // without its list on every try (page 9, then page 39 as newer listings
    // pushed it down) while the pages around it loaded: one listing breaks
    // whichever page holds it, night after night. The first time it ended the
    // whole night. Now that page alone is passed over.
    const broken = SS_GE_LISTS[1] as SsGeList;
    const site = new FakeSite({ [broken.key]: rows(1_000, 40) });
    const second = buildResultsUrl(broken, 2);
    unloadable(site, second);
    const { sleep, waits } = recordedWaits();

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(waits).toEqual([60_000, 5 * 60_000]);
    // Every list was read to its end, so the run completes and the next one starts a walk of its own.
    expect(crawlRun).toMatchObject({ status: 'completed', failedRequestCount: 4 });
    expect(crawlRun.notes).toBe(
      `${broken.key} page 2 skipped: it would not load after 4 tries (HTTP 500)`,
    );
    expect(site.resultsRequests(broken)).toEqual([1, 2, 2, 2, 2, 3]);
    expect(progressOf(crawlRun).lists[broken.key]).toMatchObject({ lastPage: 3, finished: 'end' });
    // Pages 1 and 3 of it, and every other list's one listing.
    expect(await storedListings()).toHaveLength(16 + 8 + OTHER_LISTS);
  });

  it('gives up on a list when two pages in a row will not load, keeps what it had and reads the other lists', async () => {
    const faulted = SS_GE_LISTS[1] as SsGeList;
    const site = new FakeSite({ [faulted.key]: rows(1_000, 60) });
    unloadable(site, buildResultsUrl(faulted, 2));
    unloadable(site, buildResultsUrl(faulted, 3));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ status: 'partial', failedRequestCount: 8 });
    // The list given up comes first: it is what Hermes reads as `pages_failed`.
    expect(crawlRun.notes).toBe(
      [
        `${faulted.key} page 3 would not load after 4 tries (HTTP 500)`,
        `${faulted.key} page 2 skipped: it would not load after 4 tries (HTTP 500)`,
      ].join('; '),
    );
    // A resumed walk starts before the pages that would not load.
    expect(progressOf(crawlRun).lists[faulted.key]).toMatchObject({ lastPage: 1, finished: null });
    expect(site.resultsRequests(faulted)).toEqual([1, 2, 2, 2, 2, 3, 3, 3, 3]);
    // Every other list was still read, to the last.
    for (const other of SS_GE_LISTS) {
      if (other.key === faulted.key) continue;
      expect(progressOf(crawlRun).lists[other.key]?.finished, other.key).toBe('end');
    }
    expect(await storedListings()).toHaveLength(16 + OTHER_LISTS);
  });

  it('never passes over page 1, and ends the walk once three lists were given up', async () => {
    // Page 1 holds a list's newest rows, and a site answering with its empty
    // default answers page 1 that way: its list waits for the next run.
    const site = new FakeSite();
    const faulted = SS_GE_LISTS.slice(1, 4) as SsGeList[];
    for (const list of faulted) unloadable(site, buildResultsUrl(list, 1));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ status: 'partial', failedRequestCount: 12 });
    expect(crawlRun.notes).toBe(
      faulted
        .map((list) => `${list.key} page 1 would not load after 4 tries (HTTP 500)`)
        .concat('3 lists would not load')
        .join('; '),
    );
    for (const list of faulted) {
      expect(site.resultsRequests(list)).toEqual([1, 1, 1, 1]);
      expect(progressOf(crawlRun).lists[list.key]).toMatchObject({ lastPage: 0, finished: null });
    }
    expect(progressOf(crawlRun).lists[SS_GE_LISTS[0]!.key]).toMatchObject({ finished: 'end' });
    expect(site.resultsRequests(SS_GE_LISTS[4] as SsGeList)).toEqual([]);
  });

  it('gives up on a list after five skipped pages in one run, however far apart', async () => {
    // A site answering every other page without its list would otherwise cost six minutes a page all night.
    const first = SS_GE_LISTS[0] as SsGeList;
    const site = new FakeSite({ [first.key]: rows(1_000, 16 * 14) });
    for (const page of [2, 4, 6, 8, 10, 12]) unloadable(site, buildResultsUrl(first, page));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun.status).toBe('partial');
    expect(crawlRun.notes).toMatch(
      new RegExp(`^${first.key} page 12 would not load after 4 tries \\(HTTP 500\\); `),
    );
    expect(progressOf(crawlRun).lists[first.key]).toMatchObject({ lastPage: 11, finished: null });
    expect(site.resultsRequests(first).at(-1)).toBe(12);
  });

  it('resumes a list past a page that will not load, without asking that page twice', async () => {
    const first = SS_GE_LISTS[0] as SsGeList;
    const site = new FakeSite({ [first.key]: rows(1_000, 16 * 12 + 3) }); // 13 pages
    await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxPages: 9, maxDetailChecks: 0 },
    );
    site.requested.length = 0;
    // The page a resumed walk checks itself against (9 - 5 + 1) is the broken one.
    unloadable(site, buildResultsUrl(first, 5));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW + HOUR_MS) },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun.status).toBe('completed');
    expect(site.resultsRequests(first)).toEqual([5, 5, 5, 5, 4, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(crawlRun.notes).toBe(
      `${first.key} page 5 skipped: it would not load after 4 tries (HTTP 500)`,
    );
    expect(progressOf(crawlRun).lists[first.key]).toMatchObject({ lastPage: 13, finished: 'end' });
  });

  it('waits a minute before the third try of a page that came back without its list, and carries on when it loads', async () => {
    // ss.ge, 2026-11-05: a deep page now and then answers without its list for a moment.
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    const second = buildResultsUrl(list('flat-sale'), 2);
    const blank = ok(second, '<html><head><title>SS.GE</title></head><body></body></html>');
    site.script(second, blank, blank);
    const { sleep, waits } = recordedWaits();

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(waits).toEqual([60_000]);
    expect(crawlRun).toMatchObject({ status: 'completed', failedRequestCount: 2 });
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 2, 2, 3]);
    expect(await storedListings()).toHaveLength(40 + OTHER_LISTS);
  });

  it('stops waiting when the time box runs out, and ends partial without site trouble', async () => {
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    const second = buildResultsUrl(list('flat-sale'), 2);
    site.script(second, status(second, 500), status(second, 500), status(second, 500));
    let nowMs = NOW;
    const now = () => new Date(nowMs).toISOString();
    // Each wait moves the clock; the box ends during the five-minute one.
    const sleep = async (ms: number) => {
      nowMs += ms;
    };

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep, now },
      { mode: 'sweep', maxDetailChecks: 0, stopAfterMs: 3 * 60_000 },
    );

    expect(crawlRun.status).toBe('partial');
    expect(crawlRun.notes).toBe('time limit reached');
    expect(site.requested.filter((url) => url === second)).toHaveLength(3);
  });

  it('treats a page with no data as a failure, never as an empty list', async () => {
    // A challenge or error page answered with HTTP 200.
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    const second = buildResultsUrl(list('flat-sale'), 2);
    const challenge = ok(second, '<html><body>Just a moment...</body></html>');
    site.script(second, challenge, challenge, challenge, challenge);

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    // Not the list's end: the page is passed over and the one after it read.
    expect(crawlRun).toMatchObject({ status: 'completed', failedRequestCount: 4 });
    expect(crawlRun.notes).toMatch(/^flat-sale page 2 skipped: it would not load after 4 tries/);
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 2, 2, 2, 3]);
    expect(progressOf(crawlRun).lists['flat-sale']).toMatchObject({ lastPage: 3, finished: 'end' });
  });

  it('treats a page with no rows as a failure too', async () => {
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    const second = buildResultsUrl(list('flat-sale'), 2);
    const empty = ok(second, page({ initialPage: 2, applicationList: { realStateItemModel: [] } }));
    site.script(second, empty, empty, empty, empty);

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ status: 'completed', failedRequestCount: 4 });
    expect(crawlRun.notes).toBe(
      'flat-sale page 2 skipped: it would not load after 4 tries (a page with no rows)',
    );
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 2, 2, 2, 3]);
    expect(progressOf(crawlRun).lists['flat-sale']).toMatchObject({ lastPage: 3, finished: 'end' });
  });

  it('finishes an empty list and carries on with the next', async () => {
    // The site says so itself: page 1, no rows, and a total of 0.
    const site = new FakeSite({ 'land-daily': [] });

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ status: 'completed', failedRequestCount: 0 });
    expect(site.resultsRequests(list('land-daily'))).toEqual([1]);
    expect(progressOf(crawlRun).lists['land-daily']).toMatchObject({
      lastPage: 1,
      finished: 'end',
    });
    expect(progressOf(crawlRun).lists['hotel-pledge']?.finished).toBe('end');
    expect(await storedListings()).toHaveLength(OTHER_LISTS);
  });

  it('still treats page 1 with no rows as a fault when the site says the list holds some', async () => {
    const site = new FakeSite();
    const first = buildResultsUrl(list('land-daily'), 1);
    const empty = ok(
      first,
      page({
        initialPage: 1,
        initialTotalApplicationCount: 5,
        applicationList: { realStateItemModel: [] },
      }),
    );
    site.script(first, empty, empty, empty, empty);

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ status: 'partial', failedRequestCount: 4 });
    expect(progressOf(crawlRun).lists['land-daily']?.finished).toBeNull();
  });

  it('does not believe "no listings" from a list known to hold more than a page', async () => {
    // A site answering every list with its empty default would otherwise end
    // a run as complete and move the nightly baseline past unread renewals.
    const site = new FakeSite({ 'land-daily': rows(1_000, 40) });
    await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW - DAY_MS) },
      { mode: 'sweep', maxDetailChecks: 0 },
    );
    const first = buildResultsUrl(list('land-daily'), 1);
    const empty = ok(
      first,
      page({
        initialPage: 1,
        initialTotalApplicationCount: 0,
        initialCardCount: 0,
        applicationList: { realStateItemModel: [] },
      }),
    );
    site.script(first, empty, empty, empty, empty);

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ status: 'partial', failedRequestCount: 4 });
    expect(progressOf(crawlRun).lists['land-daily']?.finished).toBeNull();
    expect((await storedListings()).filter((row) => row.missedAt !== null)).toEqual([]);
  });

  it('marks for a check the listings of a list that has emptied', async () => {
    const site = new FakeSite({ 'land-daily': rows(1_000, 1) });
    await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW - DAY_MS) },
      { mode: 'sweep', maxDetailChecks: 0 },
    );
    site.lists['land-daily'] = [];

    await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    const stored = (await storedListings()).find((row) => row.sourceListingKey === '1000');
    expect(stored?.missedAt).not.toBeNull();
    expect(stored?.status).toBe('active');
  });

  it('stops at once when the site says to slow down, and stays away until then', async () => {
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    const second = buildResultsUrl(list('flat-sale'), 2);
    site.script(second, status(second, 429, { 'retry-after': '3600' }));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun.status).toBe('partial');
    // Asked once: a refusal is not something to try again.
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2]);
    expect(site.requested.at(-1)).toBe(second);
    expect(crawlRun.notes).toMatch(/429/);
    const until = await getSourceBackoffUntil(db, ssGeSource.id);
    expect(Date.parse(until ?? '')).toBeGreaterThan(NOW + 59 * 60_000);

    site.requested.length = 0;
    const tooSoon = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW + 10 * 60_000) },
      { mode: 'sweep', maxDetailChecks: 0 },
    );
    expect(tooSoon.crawlRun).toMatchObject({ status: 'partial', requestCount: 0 });
    expect(site.requested).toEqual([]);
  });

  it('stops at once on a refusal', async () => {
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    const second = buildResultsUrl(list('flat-sale'), 2);
    site.script(second, status(second, 403, { 'cf-mitigated': 'challenge' }));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun.status).toBe('partial');
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2]);
    expect(site.requested.at(-1)).toBe(second);
    expect(crawlRun.notes).toMatch(/403/);
  });

  it('waits out a proxy that drops mid-run, and carries on from the same page', async () => {
    // The laptop reboots while page 2 is asked for: every request fails until
    // it is back, and the run neither gives up on the page nor ends.
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    const second = buildResultsUrl(list('flat-sale'), 2);
    let down = false;
    let probes = 0;
    const proxied: HttpFetcher = {
      fetch: async (url) => {
        if (url === second && probes === 0) down = true;
        if (down) throw new TypeError('fetch failed');
        return site.fetch(url);
      },
      close: async () => {},
    };
    const httpFetcher = withProxyRecovery(proxied, {
      label: 'http://127.0.0.1:18888',
      probe: async () => {
        if (++probes >= 4) down = false;
        return !down;
      },
      maxWaitMs: 10 * HOUR_MS,
      pollMs: 60_000,
      sleep: async () => {},
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ status: 'completed', failedRequestCount: 0 });
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 3]);
    expect(await storedListings()).toHaveLength(40 + OTHER_LISTS);
  });

  it('stops at once when the proxy stayed away past its wait, and says so', async () => {
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    const second = buildResultsUrl(list('flat-sale'), 2);
    site.script(second, new ProxyUnreachableError('http://127.0.0.1:18888', 10 * HOUR_MS));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ status: 'partial', failedRequestCount: 1 });
    // Not asked three times: the wait for the proxy is already spent.
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2]);
    expect(crawlRun.notes).toBe(
      'flat-sale page 2: the proxy http://127.0.0.1:18888 stayed unreachable (waited 600 min in this run)',
    );
    expect(progressOf(crawlRun).lists['flat-sale']).toMatchObject({ lastPage: 1, finished: null });
    // Nothing remembered: the next run asks as usual.
    expect(await getSourceBackoffUntil(db, ssGeSource.id)).toBeNull();
  });

  it('skips a listing the database refuses, and carries on with the rest', async () => {
    // Postgres itself refuses the row (numeric field overflow): one listing's
    // typo ended the 2026-10-26 run after 106 pages.
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    refusedRow.key = '1020';
    try {
      const { crawlRun } = await runSsGeCrawl(
        { db, httpFetcher: site, sleep: noWait, now: clock() },
        { mode: 'sweep', maxDetailChecks: 0 },
      );

      expect(crawlRun.status).toBe('completed');
      const stored = await storedListings();
      expect(stored.map((row) => row.sourceListingKey)).not.toContain('1020');
      expect(stored).toHaveLength(40 - 1 + OTHER_LISTS);
      expect(progressOf(crawlRun).lists['flat-sale']).toMatchObject({ finished: 'end' });
    } finally {
      refusedRow.key = null;
    }
  });

  it('records a seen listing again as unchanged, and a new price as a change', async () => {
    const site = new FakeSite({ 'flat-sale': rows(1_000, 3) });
    await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );
    (site.lists['flat-sale'][0] as SiteRow).priceUsd = 95000;

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW + DAY_MS) },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({
      newCount: 0,
      changedCount: 1,
      unchangedCount: 2 + OTHER_LISTS,
    });
  });
});
describe('runSsGeCrawl, nightly', () => {
  it('refuses to run before any run has completed', async () => {
    const site = new FakeSite();

    // With nothing to measure from it could only read everything, and a
    // timer must not start a day-long sweep by itself.
    await expect(
      runSsGeCrawl({ db, httpFetcher: site, sleep: noWait, now: clock() }, { mode: 'nightly' }),
    ).rejects.toThrow(/sweep/);

    expect(site.requested).toEqual([]);
    expect(await storedRuns()).toEqual([]);
  });

  it('stops each list at the first page holding only rows the last run had already seen', async () => {
    const lastRunAt = NOW - DAY_MS;
    const seenBefore = DAY_MS + 7 * HOUR_MS; // older than the last run's start less six hours
    const site = new FakeSite({
      'flat-sale': rows(1_000, 60, seenBefore),
      'flat-rent': rows(2_000, 48, seenBefore),
    });
    await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(lastRunAt) },
      { mode: 'sweep', maxDetailChecks: 0 },
    );
    site.requested.length = 0;
    // Twenty listings posted or renewed since: a page and a quarter.
    site.lists['flat-sale'] = [...rows(5_000, 20), ...site.lists['flat-sale']];

    // A page budget of one: only the first list, of one page, is read whole.
    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'nightly', maxDetailChecks: 0, deepPageBudget: 1 },
    );

    expect(crawlRun).toMatchObject({ mode: 'nightly', status: 'completed', newCount: 20 });
    // Page 2 still holds four new rows; page 3 is the first with none. Then
    // each list's last page, which holds nothing past its 30 days: its end
    // needs no more (`readListTail`).
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 3, 5]);
    expect(site.resultsRequests(list('flat-rent'))).toEqual([1, 3]);
    expect(progressOf(crawlRun).lists['flat-sale']).toMatchObject({
      lastPage: 3,
      finished: 'caught-up',
    });
    expect(progressOf(crawlRun).lists['flat-rent']).toMatchObject({
      lastPage: 1,
      finished: 'caught-up',
    });
  });

  it('measures from the start of the whole walk when the last sweep ran in instalments', async () => {
    const walkStartedAt = NOW - DAY_MS;
    const site = new FakeSite();
    await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(walkStartedAt) },
      { mode: 'sweep', maxPages: 1, maxDetailChecks: 0 },
    );
    const second = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(walkStartedAt + 2 * HOUR_MS) },
      { mode: 'sweep', maxDetailChecks: 0 },
    );
    expect(second.crawlRun.status).toBe('completed');
    site.requested.length = 0;
    // Two pages renewed five hours before the walk began: inside the six-hour
    // overlap of the walk's start, outside that of its second instalment.
    site.lists['flat-sale'] = [
      ...rows(5_000, 32, DAY_MS + 5 * HOUR_MS),
      ...rows(6_000, 16, DAY_MS + 8 * HOUR_MS),
    ];

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'nightly', maxDetailChecks: 0, deepPageBudget: 1 },
    );

    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 3]);
    expect(crawlRun.newCount).toBe(48);
  });
});

describe('runSsGeCrawl, the ends of the lists', () => {
  // A list is in date order to its very end (three lists probed 2026-11-10),
  // so its last pages hold every listing that outlived its 30 days. Here:
  // 40 rows two to three days old, then 36 ordered 31 days ago and more.
  // Pages 1 and 2 are young, page 3 is half and half, pages 4 and 5 (a short one) are old.
  const YOUNG = 2 * DAY_MS;
  const OLD = 31 * DAY_MS;
  const flatSale = list('flat-sale');
  const agedList = () => [...rows(1_000, 40, YOUNG), ...rows(2_000, 36, OLD)];

  async function baseline(site: FakeSite) {
    await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW - DAY_MS) },
      { mode: 'sweep', maxDetailChecks: 0 },
    );
    site.requested.length = 0;
  }
  /** A nightly run that reads only its first list whole, of one page. */
  const nightly = (site: FakeSite, options: { maxPages?: number } = {}) =>
    runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'nightly', maxDetailChecks: 0, deepPageBudget: 1, ...options },
    );
  const endOf = async (id: number) =>
    instant(
      (await storedListings()).find((row) => row.sourceListingKey === String(id))?.expectedEndAt,
    );

  it('reads a list it stopped early from its last page back to the first page with nothing past its 30 days', async () => {
    const site = new FakeSite({ 'flat-sale': agedList() });
    await baseline(site);

    const { crawlRun } = await nightly(site);

    // Page 1 is the nightly walk; then the end, backwards; page 2 holds only young rows.
    expect(site.resultsRequests(flatSale)).toEqual([1, 5, 4, 3, 2]);
    expect(crawlRun.status).toBe('completed');
    expect(crawlRun.notes).toBeNull();
    expect(crawlRun.pageCount).toBe(SS_GE_LISTS.length + 4);
    expect(progressOf(crawlRun).lists['flat-sale']).toMatchObject({
      lastPage: 1,
      finished: 'caught-up',
      tailPages: 4,
    });
    // Seen tonight past its 30 days: on show for sixty hours from now, where
    // the sweep of the day before had left it a day less.
    expect(await endOf(2_035)).toBeGreaterThan(NOW + 59 * HOUR_MS);
    expect(await endOf(2_035)).toBeLessThan(NOW + 61 * HOUR_MS);
  });

  it('does not read the end of a list it read whole that night, nor of one that fits its first page', async () => {
    const first = SS_GE_LISTS[0] as SsGeList;
    const site = new FakeSite({ [first.key]: agedList() });
    await baseline(site);

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'nightly', maxDetailChecks: 0, deepPageBudget: 5 },
    );

    expect(site.resultsRequests(first)).toEqual([1, 2, 3, 4, 5]);
    expect(site.resultsRequests(flatSale)).toEqual([1]);
    expect(progressOf(crawlRun).lists[first.key]?.tailPages).toBeUndefined();
    expect(progressOf(crawlRun).lists['flat-sale']?.tailPages).toBeUndefined();
  });

  it('reads no end in a sweep, which reads every list whole', async () => {
    const site = new FakeSite({ 'flat-sale': agedList() });

    await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(site.resultsRequests(flatSale)).toEqual([1, 2, 3, 4, 5]);
  });

  it('steps back when the page it took for the last is past the end', async () => {
    const site = new FakeSite({ 'flat-sale': agedList() });
    await baseline(site);
    // Sixteen listings ended since the walk read page 1: page 5 is no more.
    const gone = buildResultsUrl(flatSale, 5);
    site.script(
      gone,
      ok(
        gone,
        page({
          initialPage: 1,
          initialTotalApplicationCount: 64,
          applicationList: {
            realStateItemModel: agedList()
              .slice(0, 16)
              .map((row) => rowJson(flatSale, row)),
          },
        }),
      ),
    );

    const { crawlRun } = await nightly(site);

    expect(site.resultsRequests(flatSale)).toEqual([1, 5, 4, 3, 2]);
    expect(crawlRun.status).toBe('completed');
    expect(progressOf(crawlRun).lists['flat-sale']?.tailPages).toBe(3);
  });

  it('passes over a page of the end that will not load, and says so', async () => {
    const site = new FakeSite({ 'flat-sale': agedList() });
    await baseline(site);
    const broken = buildResultsUrl(flatSale, 4);
    site.script(
      broken,
      status(broken, 500),
      status(broken, 500),
      status(broken, 500),
      status(broken, 500),
    );

    const { crawlRun } = await nightly(site);

    expect(site.resultsRequests(flatSale)).toEqual([1, 5, 4, 4, 4, 4, 3, 2]);
    expect(crawlRun.status).toBe('completed');
    expect(crawlRun.notes).toMatch(/flat-sale page 4 skipped/);
  });

  it('gives the end up for the night when two of its pages in a row will not load, and the run is partial', async () => {
    const site = new FakeSite({ 'flat-sale': agedList() });
    await baseline(site);
    for (const broken of [buildResultsUrl(flatSale, 5), buildResultsUrl(flatSale, 4)]) {
      site.script(
        broken,
        status(broken, 500),
        status(broken, 500),
        status(broken, 500),
        status(broken, 500),
      );
    }

    const { crawlRun } = await nightly(site);

    expect(site.resultsRequests(flatSale)).toEqual([1, 5, 5, 5, 5, 4, 4, 4, 4]);
    expect(crawlRun.status).toBe('partial');
    // The wording Hermes reads as `pages_failed`.
    expect(crawlRun.notes).toMatch(/flat-sale page 4 would not load after 4 tries/);
    // The lists themselves were all read: the next night measures from this run.
    expect(progressOf(crawlRun).lists['flat-sale']?.finished).toBe('caught-up');
  });

  it("counts the ends' pages against a trial's page limit", async () => {
    const site = new FakeSite({ 'flat-sale': agedList() });
    await baseline(site);

    const { crawlRun } = await nightly(site, { maxPages: SS_GE_LISTS.length + 2 });

    expect(site.resultsRequests(flatSale)).toEqual([1, 5, 4]);
    expect(crawlRun).toMatchObject({ status: 'partial', notes: 'page limit reached' });
  });

  it('stops after a quarter of the list, twenty pages at least, when its rows never turn young, and says so', async () => {
    // Thirty pages, all past their 30 days: not a list as ss.ge orders one.
    const site = new FakeSite({ 'flat-sale': rows(3_000, 30 * 16, OLD) });
    await baseline(site);
    // One row renewed, so the nightly walk has a page to stop at.
    site.lists['flat-sale'] = [...rows(5_000, 16, 8 * HOUR_MS), ...site.lists['flat-sale']];

    const { crawlRun } = await nightly(site);

    const asked = site.resultsRequests(flatSale);
    expect(asked.slice(0, 2)).toEqual([1, 2]);
    expect(asked.slice(2)).toEqual(Array.from({ length: 20 }, (_, index) => 31 - index));
    expect(crawlRun.status).toBe('completed');
    expect(crawlRun.notes).toMatch(/flat-sale: its end was still past its 30 days after 20 pages/);
  });
});

describe('runSsGeCrawl, resuming and full reads', () => {
  // The lists these tests look at hold forty listings (three pages) older than
  // the baseline's cutoff, so a nightly run stops each at page 1 unless it
  // reads that list whole. The rest hold one, which keeps 24 lists quick.
  const OLD = 3 * DAY_MS;
  const WATCHED = new Set<ListKey>([
    'land-daily',
    'hotel-pledge',
    'cottage-pledge',
    'commercial-pledge',
    'cottage-rent',
    'cottage-sale',
    'house-sale',
  ]);
  function oldLists(): Partial<Record<ListKey, SiteRow[]>> {
    return Object.fromEntries(
      SS_GE_LISTS.map((candidate, index) => [
        candidate.key,
        rows(10_000 * (index + 1), WATCHED.has(candidate.key) ? 40 : 1, OLD),
      ]),
    );
  }
  async function baseline(site: FakeSite, atMs: number) {
    await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(atMs) },
      { mode: 'sweep', maxDetailChecks: 0 },
    );
    site.requested.length = 0;
  }

  it('reads whole the lists read longest ago, as many as its page budget fits', async () => {
    const site = new FakeSite(oldLists());
    await baseline(site, NOW - 2 * DAY_MS);

    // The sweep read every list whole, three pages each: six pages fit two lists.
    const first = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW - DAY_MS) },
      { mode: 'nightly', maxDetailChecks: 0, deepPageBudget: 6 },
    );
    expect(progressOf(first.crawlRun).deep).toEqual(['land-daily', 'hotel-pledge']);
    // Read past the rows the last run saw, to its short last page.
    expect(site.resultsRequests(list('land-daily'))).toEqual([1, 2, 3]);
    expect(site.resultsRequests(list('hotel-pledge'))).toEqual([1, 2, 3]);
    // Stopped at page 1, then its last page: nothing there is past its 30 days.
    expect(site.resultsRequests(list('cottage-pledge'))).toEqual([1, 3]);
    expect(progressOf(first.crawlRun).lists['hotel-pledge']?.finished).toBe('end');

    site.requested.length = 0;
    const second = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW) },
      { mode: 'nightly', maxDetailChecks: 0, deepPageBudget: 6 },
    );
    expect(progressOf(second.crawlRun).deep).toEqual(['cottage-pledge', 'commercial-pledge']);
    expect(site.resultsRequests(list('cottage-pledge'))).toEqual([1, 2, 3]);
    expect(site.resultsRequests(list('land-daily'))).toEqual([1, 3]);
  });

  it('resumes a run whose progress names its one deep list the old way', async () => {
    // Runs before Phase 12A stored one list key, not a list of them.
    const site = new FakeSite(oldLists());
    await baseline(site, NOW - 2 * DAY_MS);
    const iso = (ms: number) => new Date(ms).toISOString();
    await db.insert(realEstateCrawlRuns).values({
      sourceId: ssGeSource.id,
      mode: 'nightly',
      status: 'partial',
      startedAt: iso(NOW - 2 * HOUR_MS),
      finishedAt: iso(NOW - HOUR_MS),
      progress: { walkStartedAt: iso(NOW - 2 * HOUR_MS), deep: 'cottage-rent', lists: {} },
    });

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'nightly', maxDetailChecks: 0 },
    );

    expect(crawlRun.status).toBe('completed');
    expect(progressOf(crawlRun).deep).toEqual(['cottage-rent']);
    expect(site.resultsRequests(list('cottage-rent'))).toEqual([1, 2, 3]);
    expect(site.resultsRequests(list('cottage-sale'))).toEqual([1, 3]);
  });

  it('asks the page of a listing a full read no longer finds, in the same run', async () => {
    const site = new FakeSite(oldLists());
    await baseline(site, NOW - 2 * DAY_MS);
    // Sold and taken down early: gone from its list long before its end.
    const removed = site.lists['land-daily'].splice(7, 1)[0];
    const removedKey = String(removed?.id);

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW - DAY_MS) },
      { mode: 'nightly', maxDetailChecks: 1, deepPageBudget: 3 },
    );

    expect(site.requested.filter((url) => !url.includes('/l/'))).toEqual([
      buildDetailUrl(removedKey),
    ]);
    expect(crawlRun).toMatchObject({ status: 'completed', goneCount: 1 });
    const stored = (await storedListings()).find((row) => row.sourceListingKey === removedKey);
    expect(stored).toMatchObject({ status: 'gone', goneReason: 'missing', missedAt: null });
    // Every other listing of the list was seen, so none is marked.
    expect((await storedListings()).filter((row) => row.missedAt !== null)).toEqual([]);
  });

  it('reads every list again the night after a run that read them all but was refused a listing page, measuring from that run', async () => {
    const site = new FakeSite(oldLists());
    await baseline(site, NOW - 2 * DAY_MS);
    // Night one reads every list, then ss.ge refuses the first listing page.
    for (const listRows of Object.values(site.lists)) {
      for (const row of listRows) {
        const url = buildDetailUrl(String(row.id));
        site.script(url, status(url, 403));
      }
    }
    const refused = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW - DAY_MS) },
      { mode: 'nightly', deepPageBudget: 1 },
    );
    expect(refused.crawlRun.status).toBe('partial');
    for (const entry of SS_GE_LISTS) {
      expect(progressOf(refused.crawlRun).lists[entry.key]?.finished, entry.key).not.toBeNull();
    }
    site.requested.length = 0;
    site.scripted.clear();
    // Ordered after the baseline began and before night one did: only a run
    // measuring from the baseline would read on past page 1 for them.
    site.lists['flat-sale'].unshift(...rows(1, 2, 40 * HOUR_MS));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW) },
      { mode: 'nightly', maxDetailChecks: 0, deepPageBudget: 1 },
    );

    expect(crawlRun.status).toBe('completed');
    // A walk of its own, not night one's finished walk resumed with nothing to read.
    expect(progressOf(crawlRun).walkStartedAt).toBe(new Date(NOW).toISOString());
    for (const entry of SS_GE_LISTS) {
      expect(site.resultsRequests(entry).length, entry.key).toBeGreaterThan(0);
    }
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1]);
  });

  it('carries on from an interrupted nightly run, keeping its start and the lists it finished', async () => {
    const site = new FakeSite(oldLists());
    await baseline(site, NOW - 2 * DAY_MS);
    const houses = buildResultsUrl(list('house-sale'), 1);
    site.script(
      houses,
      status(houses, 500),
      status(houses, 500),
      status(houses, 500),
      status(houses, 500),
    );
    const interrupted = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW - 3 * HOUR_MS) },
      { mode: 'nightly', maxDetailChecks: 0, deepPageBudget: 3 },
    );
    expect(interrupted.crawlRun.status).toBe('partial');
    site.requested.length = 0;

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW) },
      { mode: 'nightly', maxDetailChecks: 0 },
    );

    expect(crawlRun.status).toBe('completed');
    expect(progressOf(crawlRun).walkStartedAt).toBe(progressOf(interrupted.crawlRun).walkStartedAt);
    // A list the interrupted run had finished is not walked again; only its
    // end is read, as every run does for a list it has not read whole.
    expect(site.resultsRequests(list('cottage-rent'))).toEqual([3]);
    expect(site.resultsRequests(list('cottage-sale'))).toEqual([3]);
    expect(site.resultsRequests(list('house-sale'))).toEqual([1, 3]);
  });

  it('steps back when the list moved up past where an interrupted walk stopped', async () => {
    // The walk had read 160 rows (ten pages) when it stopped. Since then a
    // hundred listings above that point were renewed away or deleted, so
    // what it read is now the first 60 rows, and five pages back from page
    // ten is already past twenty rows it never read.
    const flats = rows(1_000, 200);
    const site = new FakeSite({ 'flat-sale': flats });
    await ensureSsGeSourceSeeded(db);
    const iso = (ms: number) => new Date(ms).toISOString();
    await db.insert(realEstateCrawlRuns).values([
      {
        sourceId: ssGeSource.id,
        mode: 'nightly',
        status: 'completed',
        startedAt: iso(NOW - DAY_MS),
        finishedAt: iso(NOW - DAY_MS + HOUR_MS),
        progress: { walkStartedAt: iso(NOW - DAY_MS), lists: {} },
      },
      {
        sourceId: ssGeSource.id,
        mode: 'nightly',
        status: 'partial',
        startedAt: iso(NOW - 2 * HOUR_MS),
        finishedAt: iso(NOW - HOUR_MS),
        progress: {
          walkStartedAt: iso(NOW - 2 * HOUR_MS),
          deep: 'cottage-rent',
          lists: {
            'cottage-rent': { lastPage: 1, finished: 'end' },
            'cottage-sale': { lastPage: 1, finished: 'end' },
            'house-sale': { lastPage: 1, finished: 'end' },
            'house-rent': { lastPage: 1, finished: 'end' },
            'flat-sale': {
              lastPage: 10,
              finished: null,
              oldestSeenAt: iso(flats[59]?.orderedAt ?? 0),
            },
          },
        },
      },
    ]);

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'nightly', maxDetailChecks: 0 },
    );

    expect(crawlRun.status).toBe('completed');
    // Page 6 was all older than what the walk had read; page 1 overlaps it.
    const asked = site.resultsRequests(list('flat-sale'));
    expect(asked.slice(0, 3)).toEqual([6, 1, 2]);
    const keys = new Set((await storedListings()).map((row) => row.sourceListingKey));
    for (let id = 1_060; id < 1_080; id++) expect(keys.has(String(id)), String(id)).toBe(true);
  });
});

describe('listsDueForFullRead', () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const end = (lastPage: number): SsGeListProgress => ({ lastPage, finished: 'end' });

  async function seedRuns(runs: { daysAgo: number; lists: SsGeRunProgress['lists'] }[]) {
    await ensureSsGeSourceSeeded(db);
    for (const run of runs) {
      const at = iso(NOW - run.daysAgo * DAY_MS);
      await db.insert(realEstateCrawlRuns).values({
        sourceId: ssGeSource.id,
        mode: 'nightly',
        status: 'completed',
        startedAt: at,
        finishedAt: at,
        progress: { walkStartedAt: at, lists: run.lists } satisfies SsGeRunProgress,
      });
    }
  }

  /**
   * Two nights ago every list but flat-rent and house-pledge was read whole,
   * 100 pages each except land-sale (1,400) and flat-sale (2,800). Last night
   * every list was read whole again except those and cottage-rent.
   */
  async function seedHistory(lastNight: SsGeRunProgress['lists'] = {}) {
    const all = Object.fromEntries(SS_GE_LISTS.map((entry) => [entry.key, end(100)])) as Record<
      ListKey,
      SsGeListProgress
    >;
    const {
      'flat-rent': _a,
      'house-pledge': _b,
      ...older
    } = {
      ...all,
      'land-sale': end(1_400),
      'flat-sale': end(2_800),
    };
    const {
      'flat-rent': _c,
      'house-pledge': _d,
      'cottage-rent': _e,
      'land-sale': _f,
      'flat-sale': _g,
      ...newer
    } = all;
    await seedRuns([
      { daysAgo: 2, lists: older },
      { daysAgo: 1, lists: { ...newer, ...lastNight } },
    ]);
  }

  it('reads whole in one night as many of the least recently read lists as fit 4,000 pages, never-read lists first', async () => {
    expect(DEEP_PAGE_BUDGET).toBe(4_000);
    expect(UNKNOWN_LIST_PAGES).toBe(1_000);
    await seedHistory();

    // 1,000 + 1,000 for the two never read whole, then 100 and 1,400 for the
    // oldest reads: the 2,800 pages of flat-sale would pass 4,000 and wait a night.
    expect(await listsDueForFullRead(db)).toEqual([
      'house-pledge',
      'flat-rent',
      'cottage-rent',
      'land-sale',
    ]);
  });

  it('sizes a list never read whole from the total its list last showed', async () => {
    // 45,923 listings is 2,871 pages: with 1,000 for house-pledge and 100 for
    // cottage-rent that is 3,971, and land-sale no longer fits.
    await seedHistory({ 'flat-rent': { lastPage: 1, finished: 'caught-up', total: 45_923 } });

    expect(await listsDueForFullRead(db)).toEqual(['house-pledge', 'flat-rent', 'cottage-rent']);
  });

  it('always reads at least one list, however large', async () => {
    await seedHistory();

    expect(await listsDueForFullRead(db, 50)).toEqual(['house-pledge']);
  });

  it('reads the four smallest first when no list has been read whole', async () => {
    expect(await listsDueForFullRead(db)).toEqual(
      SS_GE_LISTS.slice(0, 4).map((entry) => entry.key),
    );
  });
});

describe('runSsGeCrawl, listings past their expected end', () => {
  // Well past the 30 days a listing is expected to live.
  const PAST_ITS_LIFE = 46 * DAY_MS;
  const first = SS_GE_LISTS[0] as SsGeList;
  const detailRequests = (site: FakeSite) =>
    site.requested.filter((url) => !url.includes('/l/')).map((url) => url.split('/').at(-1));

  async function stored(id: number) {
    return (await storedListings()).find((row) => row.sourceListingKey === String(id));
  }

  /**
   * Listings a list showed a day after their expected end, that no list shows
   * any more: only their own pages can say what became of them.
   */
  async function pastTheirEnd(ids: number[], lastSeenAgoMs = 3 * DAY_MS) {
    await ensureSsGeSourceSeeded(db);
    const ago = (ms: number) => new Date(NOW - ms).toISOString();
    await db.insert(realEstateListings).values(
      ids.map((id) => ({
        sourceId: ssGeSource.id,
        sourceListingKey: String(id),
        canonicalUrl: buildDetailUrl(String(id)),
        dealType: 'sale' as const,
        propertyType: 'flat' as const,
        sourceUpdatedAt: ago(31 * DAY_MS),
        expectedEndAt: ago(lastSeenAgoMs + DAY_MS),
        firstSeenAt: ago(31 * DAY_MS),
        lastSeenAt: ago(lastSeenAgoMs),
        contentHash: 'h',
      })),
    );
  }

  it('asks the page of each, extends the live, marks the expired gone and rechecks a blank page soon', async () => {
    // Their expected life has passed and no list shows them: only the
    // listing's page says what happens next.
    const site = new FakeSite({ [first.key]: rows(1_100, 1) });
    await pastTheirEnd([1000, 1001]);
    site.details.set('1000', { status: 'Active', endsAt: NOW + 200 * DAY_MS });
    site.details.set('1001', { status: 'Expired' });
    // 1002's page has no listing in it, though a list showed it half a day
    // ago: ss.ge does that to live listings now and then (Phase 12B).
    await pastTheirEnd([1002], 12 * HOUR_MS);

    // Three pages: the checks, not the pages its new listings want read.
    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 3 },
    );

    expect(detailRequests(site).sort()).toEqual(['1000', '1001', '1002']);
    for (const url of site.requested) expect(isSsGeUrlAllowed(url), url).toBe(true);
    expect(crawlRun).toMatchObject({ status: 'completed', verifiedCount: 1, goneCount: 1 });

    const live = await stored(1000);
    expect(live?.status).toBe('active');
    expect(live?.verifiedAt).not.toBeNull();
    // A far-off end is believed for thirty days, then looked at again.
    expect(instant(live?.expectedEndAt)).toBeGreaterThan(NOW + 29 * DAY_MS);
    expect(instant(live?.expectedEndAt)).toBeLessThan(NOW + 31 * DAY_MS);
    expect(await stored(1001)).toMatchObject({ status: 'gone', goneReason: 'expired' });
    const blank = await stored(1002);
    expect(blank).toMatchObject({ status: 'active', goneAt: null });
    expect(instant(blank?.expectedEndAt)).toBeLessThan(NOW + 4 * DAY_MS);
    expect(await stored(1100)).toMatchObject({ status: 'active', verifiedAt: null });
  });

  it('asks no page of a listing its list still shows past its end: the sighting keeps it on show', async () => {
    // Ordered 46 days ago and still listed. Until 2026-11-10 that put it first
    // among the night's checks; the list showing it is the evidence now.
    const site = new FakeSite({ [first.key]: rows(1_000, 3, PAST_ITS_LIFE) });

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun.status).toBe('completed');
    const listed = await stored(1000);
    expect(instant(listed?.expectedEndAt)).toBeGreaterThan(NOW + 59 * HOUR_MS);
    expect(instant(listed?.expectedEndAt)).toBeLessThan(NOW + 61 * HOUR_MS);
    const due = await loadListingsDueForCheck(db, {
      sourceId: ssGeSource.id,
      asOf: new Date(NOW + HOUR_MS).toISOString(),
      limit: 10,
    });
    expect(due).toEqual([]);
  });

  it('asks no page of a listing past its end that no list has shown since: it lapses', async () => {
    // Every list's end is read each night (2026-11-11): one alive past its 30
    // days is seen there. Its page goes to a listing the run reads for its
    // details or its place instead.
    const site = new FakeSite({ [first.key]: rows(1_100, 1) });
    await ensureSsGeSourceSeeded(db);
    const ago = (ms: number) => new Date(NOW - ms).toISOString();
    await db.insert(realEstateListings).values({
      sourceId: ssGeSource.id,
      sourceListingKey: '1000',
      canonicalUrl: buildDetailUrl('1000'),
      dealType: 'sale',
      propertyType: 'flat',
      sourceUpdatedAt: ago(31 * DAY_MS),
      expectedEndAt: ago(DAY_MS),
      firstSeenAt: ago(31 * DAY_MS),
      lastSeenAt: ago(3 * DAY_MS),
      contentHash: 'h',
    });

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 1 },
    );

    expect(detailRequests(site)).toHaveLength(1);
    expect(detailRequests(site)).not.toContain('1000');
    expect(crawlRun).toMatchObject({ status: 'completed', verifiedCount: 0, goneCount: 0 });
    expect(await stored(1000)).toMatchObject({ status: 'active', verifiedAt: null });
  });

  it('checks no more listings than its budget', async () => {
    const site = new FakeSite();
    await pastTheirEnd([1000, 1001, 1002]);
    for (const id of ['1000', '1001', '1002']) site.details.set(id, { status: 'Expired' });

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 2 },
    );

    expect(detailRequests(site)).toHaveLength(2);
    // Running out of budget is not a fault: the rest wait for the next night.
    expect(crawlRun).toMatchObject({ status: 'completed', goneCount: 2 });
    expect((await storedListings()).filter((row) => row.status === 'active')).toHaveLength(
      1 + SS_GE_LISTS.length,
    );
  });

  it('still checks them when a trial stops at its page limit', async () => {
    const site = new FakeSite();
    await pastTheirEnd([1000, 1001]);

    // Two listing pages: the checks, before the page the one new listing wants read.
    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxPages: 1, maxDetailChecks: 2 },
    );

    expect(crawlRun.status).toBe('partial');
    expect(detailRequests(site).sort()).toEqual(['1000', '1001']);
  });

  it('still checks them, and deletes the long gone, after a list that would not load', async () => {
    // 2026-11-09: one such page cost the night its checks and 13A's first deletions.
    const site = new FakeSite();
    await pastTheirEnd([1000, 1001]);
    const faulted = buildResultsUrl(SS_GE_LISTS[1] as SsGeList, 1);
    site.script(
      faulted,
      status(faulted, 500),
      status(faulted, 500),
      status(faulted, 500),
      status(faulted, 500),
    );
    await ensureSsGeSourceSeeded(db);
    await db.insert(realEstateListings).values({
      sourceId: ssGeSource.id,
      sourceListingKey: '7002',
      canonicalUrl: buildDetailUrl('7002'),
      dealType: 'sale',
      propertyType: 'flat',
      sourceUpdatedAt: new Date(NOW - 60 * DAY_MS).toISOString(),
      expectedEndAt: new Date(NOW - 30 * DAY_MS).toISOString(),
      firstSeenAt: new Date(NOW - 60 * DAY_MS).toISOString(),
      lastSeenAt: new Date(NOW - 30 * DAY_MS).toISOString(),
      contentHash: 'h',
      status: 'gone',
      goneAt: new Date(NOW - 15 * DAY_MS).toISOString(),
      goneReason: 'expired',
    });

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep' },
    );

    expect(crawlRun.status).toBe('partial');
    expect(crawlRun.notes).toMatch(/page 1 would not load after 4 tries/);
    // Both past their life were checked (the other lists' new listings had their pages read too).
    expect(detailRequests(site)).toEqual(expect.arrayContaining(['1000', '1001']));
    expect(await stored(7002)).toBeUndefined();
  });

  it('checks none when the site refused the walk', async () => {
    const site = new FakeSite();
    await pastTheirEnd([1000, 1001, 1002]);
    const refused = buildResultsUrl(SS_GE_LISTS[1] as SsGeList, 1);
    site.script(refused, status(refused, 403));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep' },
    );

    expect(crawlRun.status).toBe('partial');
    expect(detailRequests(site)).toEqual([]);
  });

  it('gives up on no listing in a run the site refused', async () => {
    const site = new FakeSite();
    await ensureSsGeSourceSeeded(db);
    await db.insert(realEstateListings).values({
      sourceId: ssGeSource.id,
      sourceListingKey: '7001',
      canonicalUrl: buildDetailUrl('7001'),
      dealType: 'sale',
      propertyType: 'flat',
      sourceUpdatedAt: new Date(NOW - 40 * DAY_MS).toISOString(),
      expectedEndAt: new Date(NOW - 8 * DAY_MS).toISOString(),
      firstSeenAt: new Date(NOW - 40 * DAY_MS).toISOString(),
      lastSeenAt: new Date(NOW - 20 * DAY_MS).toISOString(),
      contentHash: 'h',
    });
    const refused = buildResultsUrl(first, 1);
    site.script(refused, status(refused, 403));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep' },
    );

    // The run never had the chance to see it again.
    expect(crawlRun).toMatchObject({ status: 'partial', goneCount: 0 });
    expect(await stored(7001)).toMatchObject({ status: 'active' });
  });

  it('gives up on no listing in a run whose proxy stayed away', async () => {
    const site = new FakeSite();
    await ensureSsGeSourceSeeded(db);
    await db.insert(realEstateListings).values({
      sourceId: ssGeSource.id,
      sourceListingKey: '7001',
      canonicalUrl: buildDetailUrl('7001'),
      dealType: 'sale',
      propertyType: 'flat',
      sourceUpdatedAt: new Date(NOW - 40 * DAY_MS).toISOString(),
      expectedEndAt: new Date(NOW - 8 * DAY_MS).toISOString(),
      firstSeenAt: new Date(NOW - 40 * DAY_MS).toISOString(),
      lastSeenAt: new Date(NOW - 20 * DAY_MS).toISOString(),
      contentHash: 'h',
    });
    const firstPage = buildResultsUrl(first, 1);
    site.script(firstPage, new ProxyUnreachableError('http://127.0.0.1:18888', 10 * HOUR_MS));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep' },
    );

    expect(crawlRun).toMatchObject({ status: 'partial', goneCount: 0, verifiedCount: 0 });
    expect(detailRequests(site)).toEqual([]);
    expect(await stored(7001)).toMatchObject({ status: 'active' });
  });

  it('stops checking when the site refuses a listing page', async () => {
    const site = new FakeSite();
    await pastTheirEnd([1000, 1001, 1002]);
    for (const id of ['1000', '1001', '1002']) {
      site.script(buildDetailUrl(id), status(buildDetailUrl(id), 429, { 'retry-after': '600' }));
    }

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep' },
    );

    expect(detailRequests(site)).toHaveLength(1);
    expect(crawlRun).toMatchObject({ status: 'partial', goneCount: 0, verifiedCount: 0 });
    expect(crawlRun.notes).toMatch(/429/);
  });

  it('leaves alone a listing whose page fails, and carries on with the next', async () => {
    const site = new FakeSite();
    await pastTheirEnd([1000, 1001, 1002]);
    site.details.set('1000', { status: 'Expired' });
    site.script(buildDetailUrl('1001'), status(buildDetailUrl('1001'), 500));
    const challenge = ok(buildDetailUrl('1002'), '<html><body>Just a moment...</body></html>');
    site.script(buildDetailUrl('1002'), challenge);

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 3 },
    );

    expect(detailRequests(site)).toHaveLength(3);
    // A page that did not load says nothing: not "gone", and above all not
    // "missing", which is what a page with no listing in it would mean.
    expect(crawlRun).toMatchObject({ status: 'completed', goneCount: 1, failedRequestCount: 2 });
    expect(await stored(1000)).toMatchObject({ status: 'gone', goneReason: 'expired' });
    expect(await stored(1001)).toMatchObject({ status: 'active', verifiedAt: null });
    expect(await stored(1002)).toMatchObject({ status: 'active', verifiedAt: null });
  });

  it('gives up checking after five listing pages in a row fail', async () => {
    const site = new FakeSite();
    await pastTheirEnd([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007]);
    for (let id = 1_000; id < 1_008; id++) {
      site.script(buildDetailUrl(String(id)), status(buildDetailUrl(String(id)), 503));
    }

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep' },
    );

    expect(detailRequests(site)).toHaveLength(5);
    expect(crawlRun).toMatchObject({ status: 'partial', goneCount: 0 });
    expect(crawlRun.notes).toMatch(/listing pages/);
  });

  it('gives up on listings nobody has seen for a week past their end, and deletes those long gone', async () => {
    const site = new FakeSite();
    await ensureSsGeSourceSeeded(db);
    const daysAgo = (days: number) => new Date(NOW - days * DAY_MS).toISOString();
    const base = {
      sourceId: ssGeSource.id,
      dealType: 'sale',
      propertyType: 'flat',
      sourceUpdatedAt: daysAgo(40),
      firstSeenAt: daysAgo(40),
      contentHash: 'h',
    } as const;
    await db.insert(realEstateListings).values([
      {
        ...base,
        sourceListingKey: '7001',
        canonicalUrl: buildDetailUrl('7001'),
        expectedEndAt: daysAgo(8),
        lastSeenAt: daysAgo(20),
      },
      {
        ...base,
        sourceListingKey: '7002',
        canonicalUrl: buildDetailUrl('7002'),
        expectedEndAt: daysAgo(40),
        lastSeenAt: daysAgo(40),
        status: 'gone',
        goneAt: daysAgo(15),
        goneReason: 'expired',
      },
    ]);

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ status: 'completed', goneCount: 1 });
    expect(await stored(7001)).toMatchObject({ status: 'gone', goneReason: 'lapsed' });
    expect(await stored(7002)).toBeUndefined();
  });
});

describe('runSsGeCrawl, listing pages wanted for their details (Phase 12B)', () => {
  const LIVE = { status: 'Active', endsAt: NOW + 20 * DAY_MS } as const;
  const detailRequests = (site: FakeSite) =>
    site.requested.filter((url) => !url.includes('/l/')).map((url) => url.split('/').at(-1));

  /** Every listing on the site live, so each page read saves details. */
  function allLive(site: FakeSite): void {
    for (const listRows of Object.values(site.lists)) {
      for (const row of listRows) site.details.set(String(row.id), LIVE);
    }
  }

  async function stored(id: number) {
    return (await storedListings()).find((row) => row.sourceListingKey === String(id));
  }

  it('reads the page of each new listing after the lists, newest first, and saves its details', async () => {
    // Ordered 10 to 29 minutes ago: newer than every other list's one listing (an hour ago).
    const site = new FakeSite({ 'flat-sale': rows(1_000, 20, 10 * 60_000) });
    allLive(site);
    site.details.set('1000', { ...LIVE, fields: { state: 'გარემონტებული', toilet: '2' } });

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep' },
    );

    const firstListingPage = site.requested.findIndex((url) => !url.includes('/l/'));
    expect(firstListingPage).toBeGreaterThan(0);
    expect(site.requested.slice(firstListingPage).every((url) => !url.includes('/l/'))).toBe(true);
    const asked = detailRequests(site);
    expect(asked.slice(0, 20)).toEqual(
      Array.from({ length: 20 }, (_, index) => String(1_000 + index)),
    );
    expect(asked).toHaveLength(20 + OTHER_LISTS);
    expect(new Set(asked).size).toBe(asked.length);
    for (const url of site.requested) expect(isSsGeUrlAllowed(url), url).toBe(true);
    expect(crawlRun).toMatchObject({
      status: 'completed',
      detailsCount: 20 + OTHER_LISTS,
      // Not checks: none of these was past its expected end.
      verifiedCount: 0,
      failedRequestCount: 0,
      notes: null,
    });

    const read = await stored(1000);
    expect(read).toMatchObject({ condition: 'renovated', bathrooms: 2, detailsWantedAt: null });
    expect(read?.detailsReadAt).not.toBeNull();
    expect((await storedListings()).filter((row) => row.detailsReadAt === null)).toEqual([]);
  });

  it('stops reading listing pages at the time limit and still completes; the next night reads the rest, newest first', async () => {
    expect(DEFAULT_STOP_AFTER_MS).toBe(16 * HOUR_MS);
    const site = new FakeSite({ 'flat-sale': rows(1_000, 5, 10 * 60_000) });
    allLive(site);
    // Seventeen hours pass while the second listing page loads.
    let lateMs = 0;
    const ticks = clock();
    const now = () => new Date(Date.parse(ticks()) + lateMs).toISOString();
    const slow: HttpFetcher = {
      fetch: async (url) => {
        const answer = await site.fetch(url);
        if (detailRequests(site).length === 2) lateMs = 17 * HOUR_MS;
        return answer;
      },
      close: async () => {},
    };

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: slow, sleep: noWait, now },
      { mode: 'sweep' },
    );

    expect(detailRequests(site)).toEqual(['1000', '1001']);
    // Out of time is no fault: every list was read, and the nightly baseline moves on.
    expect(crawlRun).toMatchObject({
      status: 'completed',
      detailsCount: 2,
      notes: 'time limit reached',
    });
    const waiting = (await storedListings()).filter((row) => row.detailsWantedAt !== null);
    expect(waiting).toHaveLength(3 + OTHER_LISTS);

    site.requested.length = 0;
    const next = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock(NOW + DAY_MS) },
      { mode: 'nightly' },
    );

    expect(next.crawlRun).toMatchObject({
      status: 'completed',
      detailsCount: 3 + OTHER_LISTS,
      notes: null,
    });
    expect(detailRequests(site).slice(0, 3)).toEqual(['1002', '1003', '1004']);
    expect((await storedListings()).filter((row) => row.detailsReadAt === null)).toEqual([]);
  });

  it('stops the run at its request ceiling, 20,000, partial while lists are unread', async () => {
    expect(MAX_REQUESTS_PER_RUN).toBe(20_000);
    const site = new FakeSite();

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxRequests: 10 },
    );

    expect(site.requested).toHaveLength(10);
    expect(detailRequests(site)).toEqual([]);
    expect(crawlRun).toMatchObject({
      status: 'partial',
      requestCount: 10,
      notes: 'request ceiling reached',
    });
  });

  it('skips a listing page whose details the database refuses, keeping nothing of it, and carries on', async () => {
    const site = new FakeSite({ 'flat-sale': rows(1_000, 3, 10 * 60_000) });
    allLive(site);
    refusedPage.key = '1001';
    try {
      const { crawlRun } = await runSsGeCrawl(
        { db, httpFetcher: site, sleep: noWait, now: clock() },
        { mode: 'sweep' },
      );

      expect(crawlRun).toMatchObject({ status: 'completed', detailsCount: 2 + OTHER_LISTS });
      expect(detailRequests(site)).toHaveLength(3 + OTHER_LISTS);
      // Still wanted, and untouched: its page is asked again next run.
      const refused = await stored(1001);
      expect(refused).toMatchObject({ detailsReadAt: null, verifiedAt: null });
      expect(refused?.detailsWantedAt).not.toBeNull();
    } finally {
      refusedPage.key = null;
    }
  });

  it('stops at once on a refusal while reading listing pages', async () => {
    const site = new FakeSite();
    for (const listRows of Object.values(site.lists)) {
      for (const row of listRows) {
        const url = buildDetailUrl(String(row.id));
        site.script(url, status(url, 429, { 'retry-after': '600' }));
      }
    }

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep' },
    );

    expect(detailRequests(site)).toHaveLength(1);
    expect(crawlRun).toMatchObject({ status: 'partial', detailsCount: 0 });
    expect(crawlRun.notes).toMatch(/429/);
    expect(await getSourceBackoffUntil(db, ssGeSource.id)).not.toBeNull();
  });
});

describe('runSsGeCrawl, listing pages read for the place tree (Phase 14A)', () => {
  const LIVE = { status: 'Active', endsAt: NOW + 20 * DAY_MS } as const;

  /** A listing stored and read long ago on `streetRef`, seen since the run's walk began. */
  async function readListingOn(key: string, streetRef: number, streetName: string) {
    await db.insert(realEstateListings).values({
      sourceId: ssGeSource.id,
      sourceListingKey: key,
      canonicalUrl: `https://home.ss.ge/ka/udzravi-qoneba/${key}`,
      dealType: 'sale',
      propertyType: 'flat',
      cityRef: 95,
      subdistrictRef: 3,
      streetRef,
      streetName,
      sourceUpdatedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
      expectedEndAt: new Date(NOW + 20 * DAY_MS).toISOString(),
      firstSeenAt: new Date(NOW - 30 * DAY_MS).toISOString(),
      // Seen since the walk began, so no full read takes it for missing.
      lastSeenAt: new Date(NOW + DAY_MS).toISOString(),
      detailsReadAt: new Date(NOW - 30 * DAY_MS).toISOString(),
      contentHash: 'h',
    });
  }

  function onStreet(streetId: number, streetTitle: string, lat: number, lng: number) {
    return {
      ...LIVE,
      fields: {
        address: { cityId: 95, subdistrictId: 3, streetId, streetTitle },
        streetLocationLatitude: lat,
        streetLocationLongitude: lng,
      },
    };
  }

  async function streetsOfTree() {
    return db
      .select()
      .from(realEstatePlaces)
      .where(eq(realEstatePlaces.sourceId, ssGeSource.id))
      .then((rows) => rows.filter((row) => row.level === 'street'));
  }

  async function setUp() {
    await ensureSsGeSourceSeeded(db);
    await readListingOn('500', 116, 'შარტავას ქ.');
    await readListingOn('501', 116, 'შარტავას ქ.');
    await readListingOn('502', 52, 'წყნეთის გზატკეცილი');
    await syncPlaces(db, { sourceId: ssGeSource.id, at: new Date(NOW).toISOString() });
    const site = new FakeSite();
    for (const listRows of Object.values(site.lists)) {
      for (const row of listRows) site.details.set(String(row.id), LIVE);
    }
    site.details.set('500', onStreet(116, 'შარტავას ქ.', 41.73067, 44.769665));
    site.details.set('501', onStreet(116, 'შარტავას ქ.', 41.73067, 44.769665));
    site.details.set('502', onStreet(52, 'წყნეთის გზატკეცილი', 0, 0));
    return site;
  }

  it('reads one page per street with no point before the pages wanted, and keeps the points', async () => {
    const site = await setUp();

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep' },
    );

    const listingPages = site.requested
      .filter((url) => !url.includes('/l/'))
      .map((url) => url.split('/').at(-1));
    // The busier street first, one of its two listings (either); then the quieter one.
    expect(['500', '501']).toContain(listingPages[0]);
    expect(listingPages[1]).toBe('502');
    expect(listingPages.filter((key) => key === '500' || key === '501')).toHaveLength(1);
    expect(listingPages).toHaveLength(2 + SS_GE_LISTS.length);
    // Counted with the pages read for their details: Hermes' event is unchanged.
    expect(crawlRun).toMatchObject({
      status: 'completed',
      detailsCount: 2 + SS_GE_LISTS.length,
      verifiedCount: 0,
    });
    const streets = new Map((await streetsOfTree()).map((row) => [row.ref, row]));
    expect(streets.get(116)).toMatchObject({ pointStatus: 'known', latitude: '41.730670' });
    expect(streets.get(52)).toMatchObject({ pointStatus: 'none', latitude: null });
  });

  it('reads no more of them than its cap', async () => {
    const site = await setUp();

    await runSsGeCrawl(
      { db, httpFetcher: site, sleep: noWait, now: clock() },
      { mode: 'sweep', maxPlacePointReads: 1 },
    );

    const listingPages = site.requested
      .filter((url) => !url.includes('/l/'))
      .map((url) => url.split('/').at(-1));
    expect(listingPages.filter((key) => key === '500' || key === '501')).toHaveLength(1);
    expect(listingPages).not.toContain('502');
  });
});
