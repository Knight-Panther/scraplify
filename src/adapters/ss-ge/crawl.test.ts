import { desc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/client.js';
import { getSourceBackoffUntil } from '../../db/ingest.js';
import { realEstateCrawlRuns, realEstateListings } from '../../db/schema/index.js';
import { cleanupTestSource } from '../../db/test-support.js';
import type { HttpFetcher, HttpFetchResult } from '../../net/http-fetcher.js';
import { ProxyUnreachableError, withProxyRecovery } from '../../net/proxy-recovery.js';
import { isSsGeUrlAllowed, ssGeSource } from '../../policies/ss-ge.js';
import {
  buildDetailUrl,
  buildResultsUrl,
  ensureSsGeSourceSeeded,
  RESUME_OVERLAP_PAGES,
  runSsGeCrawl,
  SS_GE_LISTS,
  type SsGeList,
  type SsGeRunProgress,
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
const KIND_CODE = { flat: 5, house: 4, cottage: 1 } as const;
const DEAL_CODE = { sale: 4, rent: 1 } as const;

type ListKey = SsGeList['key'];

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
  | { status: 'Active'; endsAt: number }
  | { status: 'Expired' }
  | { status: 'Missing' };

/**
 * ss.ge as the walker sees it: six lists of 16 rows a page, page 1 served
 * for any page past the end, and a detail page for every id.
 */
class FakeSite implements HttpFetcher {
  readonly requested: string[] = [];
  /** Answers given before the site's own, one per request to that URL. */
  readonly scripted = new Map<string, (HttpFetchResult | Error)[]>();
  readonly details = new Map<string, DetailState>();
  readonly lists: Record<ListKey, SiteRow[]>;

  constructor(lists: Partial<Record<ListKey, SiteRow[]>> = {}) {
    // Every list of the real site holds something; an empty one is a fault.
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

describe('the six lists', () => {
  it('are flats, houses and cottages, each for sale and for rent, at addresses the policy allows', () => {
    expect(SS_GE_LISTS.map((entry) => entry.key).sort()).toEqual([
      'cottage-rent',
      'cottage-sale',
      'flat-rent',
      'flat-sale',
      'house-rent',
      'house-sale',
    ]);
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
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ mode: 'sweep', status: 'completed', failedRequestCount: 0 });
    const stored = await storedListings();
    expect(stored).toHaveLength(40 + 5 + 4);
    expect(
      stored.filter((row) => row.propertyType === 'flat' && row.dealType === 'sale'),
    ).toHaveLength(40);
    expect(
      stored.filter((row) => row.propertyType === 'house' && row.dealType === 'rent'),
    ).toHaveLength(5);
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 3]);
    expect(crawlRun).toMatchObject({
      pageCount: 3 + 5,
      rowCount: 49,
      newCount: 49,
      requestCount: 8,
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
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun.status).toBe('completed');
    // One answer of "page 1" could be a hiccup in the middle of a list, and
    // believing it would end a sweep thousands of pages early.
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 3, 3]);
    expect(crawlRun.rowCount).toBe(32 + 5);
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
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun.status).toBe('completed');
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 2, 3]);
    expect(await storedListings()).toHaveLength(40 + 5);
  });

  it('stops at the page limit, and the next sweep picks up a few pages before', async () => {
    const first = SS_GE_LISTS[0] as SsGeList;
    const site = new FakeSite({ [first.key]: rows(1_000, 16 * 12 + 3) }); // 13 pages

    const trial = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock() },
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
      { db, httpFetcher: site, now: clock(NOW + HOUR_MS) },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(resumed.crawlRun.status).toBe('completed');
    // Renewed listings jump to the front and push the rest deeper, so the
    // walk restarts a little before where it stopped.
    const from = 9 - RESUME_OVERLAP_PAGES + 1;
    expect(site.resultsRequests(first)).toEqual(
      Array.from({ length: 13 - from + 1 }, (_, index) => from + index),
    );
    expect(await storedListings()).toHaveLength(16 * 12 + 3 + 5);
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
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep', maxPages: 3, maxDetailChecks: 0 },
    );
    site.requested.length = 0;
    const resumed = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock(NOW + HOUR_MS) },
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
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep', maxPages: 7, maxDetailChecks: 0 },
    );
    site.requested.length = 0;
    const fresh = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock(NOW + HOUR_MS) },
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
      { db, httpFetcher: site, now: clock() },
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
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ status: 'completed', failedRequestCount: 2 });
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 2, 2, 3]);
    expect(await storedListings()).toHaveLength(40 + 5);
  });

  it('gives up on a page that fails three times, and keeps what it had', async () => {
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    const second = buildResultsUrl(list('flat-sale'), 2);
    site.script(second, status(second, 500), status(second, 500), status(second, 500));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ status: 'partial', failedRequestCount: 3 });
    expect(crawlRun.notes).toMatch(/flat-sale.*page 2/);
    expect(progressOf(crawlRun).lists['flat-sale']).toMatchObject({ lastPage: 1, finished: null });
    // Nothing after the page that would not load: a resumed sweep starts there.
    expect(site.requested.at(-1)).toBe(second);
  });

  it('treats a page with no data as a failure, never as an empty list', async () => {
    // A challenge or error page answered with HTTP 200.
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    const second = buildResultsUrl(list('flat-sale'), 2);
    const challenge = ok(second, '<html><body>Just a moment...</body></html>');
    site.script(second, challenge, challenge, challenge);

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ status: 'partial', failedRequestCount: 3 });
    expect(progressOf(crawlRun).lists['flat-sale']).toMatchObject({ lastPage: 1, finished: null });
  });

  it('treats a page with no rows as a failure too', async () => {
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    const second = buildResultsUrl(list('flat-sale'), 2);
    const empty = ok(second, page({ initialPage: 2, applicationList: { realStateItemModel: [] } }));
    site.script(second, empty, empty, empty);

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun.status).toBe('partial');
    expect(progressOf(crawlRun).lists['flat-sale']?.finished).toBeNull();
  });

  it('stops at once when the site says to slow down, and stays away until then', async () => {
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    const second = buildResultsUrl(list('flat-sale'), 2);
    site.script(second, status(second, 429, { 'retry-after': '3600' }));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock() },
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
      { db, httpFetcher: site, now: clock(NOW + 10 * 60_000) },
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
      { db, httpFetcher: site, now: clock() },
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
      { db, httpFetcher, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ status: 'completed', failedRequestCount: 0 });
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 3]);
    expect(await storedListings()).toHaveLength(40 + 5);
  });

  it('stops at once when the proxy stayed away past its wait, and says so', async () => {
    const site = new FakeSite({ 'flat-sale': rows(1_000, 40) });
    const second = buildResultsUrl(list('flat-sale'), 2);
    site.script(second, new ProxyUnreachableError('http://127.0.0.1:18888', 10 * HOUR_MS));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock() },
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
        { db, httpFetcher: site, now: clock() },
        { mode: 'sweep', maxDetailChecks: 0 },
      );

      expect(crawlRun.status).toBe('completed');
      const stored = await storedListings();
      expect(stored.map((row) => row.sourceListingKey)).not.toContain('1020');
      expect(stored).toHaveLength(40 - 1 + 5);
      expect(progressOf(crawlRun).lists['flat-sale']).toMatchObject({ finished: 'end' });
    } finally {
      refusedRow.key = null;
    }
  });

  it('records a seen listing again as unchanged, and a new price as a change', async () => {
    const site = new FakeSite({ 'flat-sale': rows(1_000, 3) });
    await runSsGeCrawl(
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );
    (site.lists['flat-sale'][0] as SiteRow).priceUsd = 95000;

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock(NOW + DAY_MS) },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ newCount: 0, changedCount: 1, unchangedCount: 2 + 5 });
  });
});
describe('runSsGeCrawl, nightly', () => {
  it('refuses to run before any run has completed', async () => {
    const site = new FakeSite();

    // With nothing to measure from it could only read everything, and a
    // timer must not start a day-long sweep by itself.
    await expect(
      runSsGeCrawl({ db, httpFetcher: site, now: clock() }, { mode: 'nightly' }),
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
      { db, httpFetcher: site, now: clock(lastRunAt) },
      { mode: 'sweep', maxDetailChecks: 0 },
    );
    site.requested.length = 0;
    // Twenty listings posted or renewed since: a page and a quarter.
    site.lists['flat-sale'] = [...rows(5_000, 20), ...site.lists['flat-sale']];

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock() },
      { mode: 'nightly', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ mode: 'nightly', status: 'completed', newCount: 20 });
    // Page 2 still holds four new rows; page 3 is the first with none.
    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 3]);
    expect(site.resultsRequests(list('flat-rent'))).toEqual([1]);
    expect(progressOf(crawlRun).lists['flat-sale']).toEqual({ lastPage: 3, finished: 'caught-up' });
    expect(progressOf(crawlRun).lists['flat-rent']).toEqual({ lastPage: 1, finished: 'caught-up' });
  });

  it('measures from the start of the whole walk when the last sweep ran in instalments', async () => {
    const walkStartedAt = NOW - DAY_MS;
    const site = new FakeSite();
    await runSsGeCrawl(
      { db, httpFetcher: site, now: clock(walkStartedAt) },
      { mode: 'sweep', maxPages: 1, maxDetailChecks: 0 },
    );
    const second = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock(walkStartedAt + 2 * HOUR_MS) },
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
      { db, httpFetcher: site, now: clock() },
      { mode: 'nightly', maxDetailChecks: 0 },
    );

    expect(site.resultsRequests(list('flat-sale'))).toEqual([1, 2, 3]);
    expect(crawlRun.newCount).toBe(48);
  });
});

describe('runSsGeCrawl, listings past their expected end', () => {
  // Past the 45 days a listing no business posted lives (none of these rows names one).
  const PAST_ITS_LIFE = 46 * DAY_MS;
  const first = SS_GE_LISTS[0] as SsGeList;
  const detailRequests = (site: FakeSite) =>
    site.requested.filter((url) => !url.includes('/l/')).map((url) => url.split('/').at(-1));

  async function stored(id: number) {
    return (await storedListings()).find((row) => row.sourceListingKey === String(id));
  }

  it('asks the page of each, extends the live and marks the others gone', async () => {
    // Ordered 46 days ago and still listed: its 45 days of life have passed,
    // and only the listing's page says what happens next.
    const site = new FakeSite({
      [first.key]: [...rows(1_000, 3, PAST_ITS_LIFE), ...rows(1_100, 1)],
    });
    site.details.set('1000', { status: 'Active', endsAt: NOW + 200 * DAY_MS });
    site.details.set('1001', { status: 'Expired' });
    // 1002 has no page at all: the site answers 200 with no listing in it.

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep' },
    );

    expect(detailRequests(site).sort()).toEqual(['1000', '1001', '1002']);
    for (const url of site.requested) expect(isSsGeUrlAllowed(url), url).toBe(true);
    expect(crawlRun).toMatchObject({ status: 'completed', verifiedCount: 1, goneCount: 2 });

    const live = await stored(1000);
    expect(live?.status).toBe('active');
    expect(live?.verifiedAt).not.toBeNull();
    // A far-off end is believed for thirty days, then looked at again.
    expect(instant(live?.expectedEndAt)).toBeGreaterThan(NOW + 29 * DAY_MS);
    expect(instant(live?.expectedEndAt)).toBeLessThan(NOW + 31 * DAY_MS);
    expect(await stored(1001)).toMatchObject({ status: 'gone', goneReason: 'expired' });
    expect(await stored(1002)).toMatchObject({ status: 'gone', goneReason: 'missing' });
    expect(await stored(1100)).toMatchObject({ status: 'active', verifiedAt: null });
  });

  it('checks no more listings than its budget', async () => {
    const site = new FakeSite({ [first.key]: rows(1_000, 3, PAST_ITS_LIFE) });

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep', maxDetailChecks: 2 },
    );

    expect(detailRequests(site)).toHaveLength(2);
    // Running out of budget is not a fault: the rest wait for the next night.
    expect(crawlRun).toMatchObject({ status: 'completed', goneCount: 2 });
    expect((await storedListings()).filter((row) => row.status === 'active')).toHaveLength(1 + 5);
  });

  it('still checks them when a trial stops at its page limit', async () => {
    const site = new FakeSite({ [first.key]: rows(1_000, 2, PAST_ITS_LIFE) });

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep', maxPages: 1 },
    );

    expect(crawlRun.status).toBe('partial');
    expect(detailRequests(site).sort()).toEqual(['1000', '1001']);
  });

  it('checks none when the site refused the walk', async () => {
    const site = new FakeSite({ [first.key]: rows(1_000, 3, PAST_ITS_LIFE) });
    const refused = buildResultsUrl(SS_GE_LISTS[1] as SsGeList, 1);
    site.script(refused, status(refused, 403));

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock() },
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
      { db, httpFetcher: site, now: clock() },
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
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep' },
    );

    expect(crawlRun).toMatchObject({ status: 'partial', goneCount: 0, verifiedCount: 0 });
    expect(detailRequests(site)).toEqual([]);
    expect(await stored(7001)).toMatchObject({ status: 'active' });
  });

  it('stops checking when the site refuses a listing page', async () => {
    const site = new FakeSite({ [first.key]: rows(1_000, 3, PAST_ITS_LIFE) });
    for (const id of ['1000', '1001', '1002']) {
      site.script(buildDetailUrl(id), status(buildDetailUrl(id), 429, { 'retry-after': '600' }));
    }

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep' },
    );

    expect(detailRequests(site)).toHaveLength(1);
    expect(crawlRun).toMatchObject({ status: 'partial', goneCount: 0, verifiedCount: 0 });
    expect(crawlRun.notes).toMatch(/429/);
  });

  it('leaves alone a listing whose page fails, and carries on with the next', async () => {
    const site = new FakeSite({ [first.key]: rows(1_000, 3, PAST_ITS_LIFE) });
    site.script(buildDetailUrl('1001'), status(buildDetailUrl('1001'), 500));
    const challenge = ok(buildDetailUrl('1002'), '<html><body>Just a moment...</body></html>');
    site.script(buildDetailUrl('1002'), challenge);

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep' },
    );

    expect(detailRequests(site)).toHaveLength(3);
    // A page that did not load says nothing: not "gone", and above all not
    // "missing", which is what a page with no listing in it would mean.
    expect(crawlRun).toMatchObject({ status: 'completed', goneCount: 1, failedRequestCount: 2 });
    expect(await stored(1000)).toMatchObject({ status: 'gone', goneReason: 'missing' });
    expect(await stored(1001)).toMatchObject({ status: 'active', verifiedAt: null });
    expect(await stored(1002)).toMatchObject({ status: 'active', verifiedAt: null });
  });

  it('gives up checking after five listing pages in a row fail', async () => {
    const site = new FakeSite({ [first.key]: rows(1_000, 8, PAST_ITS_LIFE) });
    for (let id = 1_000; id < 1_008; id++) {
      site.script(buildDetailUrl(String(id)), status(buildDetailUrl(String(id)), 503));
    }

    const { crawlRun } = await runSsGeCrawl(
      { db, httpFetcher: site, now: clock() },
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
      { db, httpFetcher: site, now: clock() },
      { mode: 'sweep', maxDetailChecks: 0 },
    );

    expect(crawlRun).toMatchObject({ status: 'completed', goneCount: 1 });
    expect(await stored(7001)).toMatchObject({ status: 'gone', goneReason: 'lapsed' });
    expect(await stored(7002)).toBeUndefined();
  });
});
