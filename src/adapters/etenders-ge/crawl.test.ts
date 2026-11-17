import { readFileSync } from 'node:fs';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/client.js';
import {
  parserIncidents,
  sourceListingRevisions,
  sourceListingStatusEvents,
  sourceListings,
} from '../../db/schema/index.js';
import { cleanupTestSource, createTestSourceListing } from '../../db/test-support.js';
import type { HttpFetcher, HttpFetchResult } from '../../net/http-fetcher.js';
import { etendersGeSource } from '../../policies/etenders-ge.js';
import {
  buildSearchUrl,
  DEFAULT_FIRST_RUN_WINDOW_DAYS,
  ensureEtendersGeSourceSeeded,
  loadOutcomeRereads,
  runEtendersGeCrawl,
  tbilisiSearchDate,
} from './crawl.js';

// Every write goes to a disposable source (see the same isolation in
// src/adapters/jobs-ge/crawl.test.ts): only the ids and slug change, so URLs
// and the allow-list behave exactly as in production.
const testIds = vi.hoisted(() => ({
  sourceId: crypto.randomUUID(),
  policyId: crypto.randomUUID(),
}));

vi.mock('../../policies/etenders-ge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../policies/etenders-ge.js')>();
  return {
    ...actual,
    etendersGeSource: {
      ...actual.etendersGeSource,
      id: testIds.sourceId,
      slug: `crawl-test-${testIds.sourceId}`,
    },
    etendersGePolicy: {
      ...actual.etendersGePolicy,
      id: testIds.policyId,
      sourceId: testIds.sourceId,
    },
  };
});

const NOW = Date.parse('2026-10-07T06:00:00.000Z');
const WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_FROM = tbilisiSearchDate(NOW - WINDOW_DAYS * DAY_MS);
const windowFromAt = (at: number) => tbilisiSearchDate(at - WINDOW_DAYS * DAY_MS);

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');
}

const DETAILS: Record<string, string> = {
  '69679': 'detail-69679-reverse-auction-open-usd.html',
  '69617': 'detail-69617-prequalification-usd-excl-vat.html',
  '69674': 'detail-69674-notice-off-platform-english.html',
  '69619': 'detail-69619-one-envelope-completed-qa.html',
  '69607': 'detail-69607-failed-no-bidders.html',
  '69534': 'detail-69534-terminated-notice.html',
};

interface CardSpec {
  id: string;
  status: number;
  restricted?: boolean;
  amended?: string;
}

const STATUS_TEXT: Record<number, string> = {
  1: 'გამოცხადებულია',
  2: 'წინადადების მიღება დაწყებულია',
  4: 'შეწყვეტილი',
  5: 'ტენდერი არ შედგა',
  99: 'დასრულებული',
};

function cardHtml(card: CardSpec): string {
  const lock = card.restricted
    ? `<a href="JavaScript:alert('x');"><img src="/assets/images/lock.jpg" /></a>`
    : '';
  const amended = card.amended
    ? `<a href="JavaScript:alert('ცვლილება: ${card.amended}');"><img src="/assets/images/changed2.png" /></a>`
    : '';
  const link = card.restricted
    ? ''
    : `<a class="detail-btn dtl-" href="/view/${card.id}/buyer-title">დეტალურად</a>`;
  return `<table style="width:100%"><tr><td>
    <table class="RightNAndStarAndDetails" id="RightNAndStarAndDetails">
      <tr><td><span>Buyer ${card.id}</span></td></tr>
      <tr><td><span>Title ${card.id}</span></td></tr>
      <tr><td class="BottomCornerOfIcons"><span>#</span><span>${card.id}</span>${lock}${amended}</td></tr>
      <tr><td><span>გამოცხადების თარიღი: 01/10/2026<br/>დასრულების თარიღი: 20/10/2026<br/>
        <span class="stst status_${card.status}">სტატუსი: ${STATUS_TEXT[card.status]}<br/></span></span></td></tr>
    </table></td><td class="TopCornerOfIcons"><table><tr class="desktop-only"><td>${link}</td></tr></table></td></tr></table>`;
}

function searchHtml(cards: CardSpec[], page: number, lastPage: number): string {
  const cells: string[] = [];
  for (let p = 1; p <= lastPage; p++) {
    cells.push(
      p === page
        ? `<td class="page-numbers active">${p}</td>`
        : `<td class="page-numbers"><a href="/search/?ss=-1&pg=${p}">${p}</a></td>`,
    );
  }
  const paging = cards.length === 0 ? '' : cells.join('');
  return `<html><body>${cards.map(cardHtml).join('')}<table class="paging-tbl"><tr>${paging}</tr></table></body></html>`;
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

function redirect(url: string, location: string): HttpFetchResult {
  return { status: 302, headers: { location }, body: '', finalUrl: url, redirectCount: 0 };
}

const detailUrl = (id: string) => `https://etenders.ge/view/${id}/x`;
const liveUrl = (page = 1) => buildSearchUrl({ statuses: '_1_2_3_', from: null, page });

class FakeFetcher implements HttpFetcher {
  readonly requested: string[] = [];
  constructor(readonly responses: Map<string, HttpFetchResult>) {}
  async fetch(url: string): Promise<HttpFetchResult> {
    this.requested.push(url);
    const response = this.responses.get(url);
    if (response === undefined) throw new Error(`FakeFetcher: no canned response for ${url}`);
    return response;
  }
  async close(): Promise<void> {}
}

function siteResponses(input: {
  live: CardSpec[];
  window: CardSpec[];
  /** The run's window start; defaults to WINDOW_DAYS before NOW. */
  windowFrom?: string;
  details?: Record<string, HttpFetchResult>;
}): Map<string, HttpFetchResult> {
  const responses = new Map<string, HttpFetchResult>();
  const window = buildSearchUrl({ statuses: '__', from: input.windowFrom ?? WINDOW_FROM, page: 1 });
  responses.set(liveUrl(), ok(liveUrl(), searchHtml(input.live, 1, 1)));
  responses.set(window, ok(window, searchHtml(input.window, 1, 1)));
  for (const [id, file] of Object.entries(DETAILS)) {
    responses.set(detailUrl(id), ok(detailUrl(id), fixture(file)));
  }
  for (const [url, response] of Object.entries(input.details ?? {})) responses.set(url, response);
  return responses;
}

/** Status events of these listings, oldest first (Phase 17C). */
async function eventsOf(...listingIds: string[]) {
  const rows = await db
    .select()
    .from(sourceListingStatusEvents)
    .where(inArray(sourceListingStatusEvents.sourceListingId, listingIds))
    .orderBy(asc(sourceListingStatusEvents.id));
  return rows.map((row) => ({
    listing: row.sourceListingId,
    from: row.fromStatus,
    to: row.toStatus,
    reason: row.reason,
    run: row.crawlRunId,
  }));
}

async function listing(sourceRecordId: string) {
  const [row] = await db
    .select()
    .from(sourceListings)
    .where(
      and(
        eq(sourceListings.sourceId, etendersGeSource.id),
        eq(sourceListings.sourceRecordId, sourceRecordId),
      ),
    );
  return row;
}

function clock(start: number): () => string {
  let t = start;
  return () => new Date(t++).toISOString();
}

const LIVE: CardSpec[] = [
  { id: '69679', status: 1, amended: '05/10/2026 11:22:13' },
  { id: '69617', status: 1 },
  { id: '69674', status: 1 },
];
const WINDOW: CardSpec[] = [
  ...LIVE,
  { id: '69619', status: 99 },
  { id: '69607', status: 5 },
  { id: '69589', status: 2, restricted: true },
];

describe('runEtendersGeCrawl', () => {
  afterEach(async () => {
    await cleanupTestSource(etendersGeSource.id);
  });

  it('ingests public tenders from the live set and the window, closes finished ones, skips locked cards', async () => {
    const fetcher = new FakeFetcher(siteResponses({ live: LIVE, window: WINDOW }));
    const { crawlRun, stats } = await runEtendersGeCrawl(
      { db, httpFetcher: fetcher, now: clock(NOW) },
      { windowDays: WINDOW_DAYS },
    );

    expect(crawlRun).toMatchObject({
      status: 'completed',
      fullCoverage: false,
      discoveredCount: 5,
      newCount: 5,
      quarantinedCount: 0,
      failedCount: 0,
    });
    expect(stats).toMatchObject({
      liveCards: 3,
      windowCards: 6,
      lockedSkipped: 1,
      detailFetches: 5,
      closedBySource: 2,
      exitChecks: 0,
    });
    expect(fetcher.requested).not.toContain(detailUrl('69589'));
    expect((await listing('69679'))?.status).toBe('active');
    expect((await listing('69619'))?.status).toBe('closed');
    expect((await listing('69607'))?.status).toBe('closed');
    expect(await listing('69589')).toBeUndefined();

    const [revision] = await db
      .select()
      .from(sourceListingRevisions)
      .where(eq(sourceListingRevisions.id, (await listing('69679'))?.currentRevisionId ?? ''));
    expect(revision?.structuredAttributes).toMatchObject({
      kind: 'tender',
      method: { code: 2 },
      buyer: { registryId: '204854595' },
    });
    expect((await listing('69679'))?.sourceDeadlineAt).toBeTruthy();
  });

  it('skips unchanged cards on the next run, and rereads live tenders once their revision is old', async () => {
    const run = (at: number) =>
      runEtendersGeCrawl(
        {
          db,
          httpFetcher: new FakeFetcher(
            siteResponses({ live: LIVE, window: WINDOW, windowFrom: windowFromAt(at) }),
          ),
          now: clock(at),
        },
        { windowDays: WINDOW_DAYS },
      );
    await run(NOW);

    const second = await run(NOW + 60 * 60 * 1000);
    expect(second.stats.detailFetches).toBe(0);
    expect(second.crawlRun.skippedCount).toBe(5);

    // Past the 20-hour refresh age only the three live tenders are reread;
    // the finished ones, already stored as closed, stay skipped.
    const third = await run(NOW + 21 * 60 * 60 * 1000);
    expect(third.stats.detailFetches).toBe(3);
    expect(third.crawlRun.skippedCount).toBe(2);
  });

  it('walks the first-run window once, then only back to the last completed run', async () => {
    const run = (at: number, windowFrom: string) =>
      runEtendersGeCrawl({
        db,
        httpFetcher: new FakeFetcher(siteResponses({ live: LIVE, window: WINDOW, windowFrom })),
        now: clock(at),
      });

    const firstFrom = tbilisiSearchDate(NOW - DEFAULT_FIRST_RUN_WINDOW_DAYS * DAY_MS);
    const first = await run(NOW, firstFrom);
    expect(first.crawlRun.status).toBe('completed');
    expect(first.stats.windowFrom).toBe(firstFrom);

    // A day later: one day since the last run, plus the two-day overlap.
    const next = NOW + DAY_MS;
    const nextFrom = tbilisiSearchDate(next - 3 * DAY_MS);
    const second = await run(next, nextFrom);
    expect(second.crawlRun.status).toBe('completed');
    expect(second.stats.windowFrom).toBe(nextFrom);
  });

  it('reads how an open tender that left the live set ended, and treats not-found as missing twice before closing', async () => {
    await ensureEtendersGeSourceSeeded(db);
    const gone = await createTestSourceListing(etendersGeSource.id, {
      sourceRecordId: '69534',
      canonicalSourceUrl: detailUrl('69534'),
    });
    const vanished = await createTestSourceListing(etendersGeSource.id, {
      sourceRecordId: '70001',
      canonicalSourceUrl: detailUrl('70001'),
    });
    const notFound = {
      [detailUrl('70001')]: redirect(
        detailUrl('70001'),
        '/Pages/Tender/TenderSearch/TenderNotFound.aspx',
      ),
    };

    const run1 = await runEtendersGeCrawl(
      {
        db,
        httpFetcher: new FakeFetcher(
          siteResponses({ live: LIVE, window: LIVE, details: notFound }),
        ),
        now: clock(NOW),
      },
      { windowDays: WINDOW_DAYS },
    );
    expect(run1.stats).toMatchObject({ exitChecks: 2, closedBySource: 1, notFound: 1 });
    expect((await listing('69534'))?.status).toBe('closed');
    expect((await listing('69534'))?.id).toBe(gone.id);
    expect((await listing('70001'))?.status).toBe('missing_suspected');
    expect(await eventsOf(gone.id, vanished.id)).toEqual([
      {
        listing: gone.id,
        from: 'active',
        to: 'closed',
        reason: 'source_status',
        run: run1.crawlRun.id,
      },
      {
        listing: vanished.id,
        from: 'active',
        to: 'missing_suspected',
        reason: 'not_found',
        run: run1.crawlRun.id,
      },
    ]);

    // A retry of the same run's clock cannot advance the streak twice.
    await runEtendersGeCrawl(
      {
        db,
        httpFetcher: new FakeFetcher(
          siteResponses({ live: LIVE, window: LIVE, details: notFound }),
        ),
        now: clock(NOW - 1000),
      },
      { windowDays: WINDOW_DAYS },
    );
    expect((await listing('70001'))?.status).toBe('missing_suspected');

    const next = NOW + DAY_MS;
    await runEtendersGeCrawl(
      {
        db,
        httpFetcher: new FakeFetcher(
          siteResponses({
            live: LIVE,
            window: LIVE,
            windowFrom: windowFromAt(next),
            details: notFound,
          }),
        ),
        now: clock(next),
      },
      { windowDays: WINDOW_DAYS },
    );
    expect((await listing('70001'))?.status).toBe('closed');
    expect((await listing('70001'))?.id).toBe(vanished.id);
    // The retry changed nothing, so it recorded nothing; the next day's run closed it.
    expect((await eventsOf(vanished.id)).map((event) => [event.from, event.to])).toEqual([
      ['active', 'missing_suspected'],
      ['missing_suspected', 'closed'],
    ]);
  });

  describe('a search page that fails to load', () => {
    /** Throws a timeout for the first `times` requests to one URL, then passes through. */
    class TimesOutFirst implements HttpFetcher {
      readonly asked: string[] = [];
      constructor(
        private inner: HttpFetcher,
        private url: string,
        private times: number,
      ) {}
      async fetch(url: string): Promise<HttpFetchResult> {
        this.asked.push(url);
        if (url === this.url && this.times > 0) {
          this.times--;
          throw Object.assign(new Error('The operation was aborted due to timeout'), {
            name: 'TimeoutError',
          });
        }
        return this.inner.fetch(url);
      }
      async close(): Promise<void> {}
    }

    it('is asked again after a timeout, and the run completes', async () => {
      const fetcher = new TimesOutFirst(
        new FakeFetcher(siteResponses({ live: LIVE, window: WINDOW })),
        liveUrl(),
        2,
      );
      const { crawlRun } = await runEtendersGeCrawl(
        { db, httpFetcher: fetcher, now: clock(NOW) },
        { windowDays: WINDOW_DAYS },
      );
      expect(fetcher.asked.filter((url) => url === liveUrl())).toHaveLength(3);
      expect(crawlRun.status).toBe('completed');
    });

    it('gets three tries, then the run is partial', async () => {
      const fetcher = new TimesOutFirst(
        new FakeFetcher(siteResponses({ live: LIVE, window: WINDOW })),
        liveUrl(),
        99,
      );
      const { crawlRun } = await runEtendersGeCrawl(
        { db, httpFetcher: fetcher, now: clock(NOW) },
        { windowDays: WINDOW_DAYS },
      );
      expect(fetcher.asked.filter((url) => url === liveUrl())).toHaveLength(3);
      expect(crawlRun.status).toBe('partial');
    });
  });

  it('runs partial and checks no exits when the live set comes back empty', async () => {
    await ensureEtendersGeSourceSeeded(db);
    await createTestSourceListing(etendersGeSource.id, {
      sourceRecordId: '69534',
      canonicalSourceUrl: detailUrl('69534'),
    });
    const fetcher = new FakeFetcher(siteResponses({ live: [], window: [] }));
    const { crawlRun, stats } = await runEtendersGeCrawl(
      { db, httpFetcher: fetcher, now: clock(NOW) },
      { windowDays: WINDOW_DAYS },
    );
    expect(crawlRun.status).toBe('partial');
    expect(stats.exitChecks).toBe(0);
    expect(fetcher.requested).not.toContain(detailUrl('69534'));
    expect((await listing('69534'))?.status).toBe('active');
  });

  it('quarantines a page that is not the requested tender and records an incident', async () => {
    const responses = siteResponses({ live: LIVE, window: LIVE });
    responses.set(detailUrl('69617'), ok(detailUrl('69617'), fixture(DETAILS['69679'] ?? '')));
    const { crawlRun } = await runEtendersGeCrawl(
      { db, httpFetcher: new FakeFetcher(responses), now: clock(NOW) },
      { windowDays: WINDOW_DAYS },
    );
    expect(crawlRun.quarantinedCount).toBe(1);
    expect((await listing('69617'))?.status).toBe('quarantined');
    const incidents = await db
      .select()
      .from(parserIncidents)
      .where(eq(parserIncidents.sourceId, etendersGeSource.id));
    expect(incidents.some((incident) => incident.kind === 'field_missing')).toBe(true);
  });

  it('flags a short middle page as a page-size anomaly', async () => {
    const responses = siteResponses({ live: LIVE, window: [] });
    responses.set(liveUrl(1), ok(liveUrl(1), searchHtml(LIVE.slice(0, 2), 1, 2)));
    responses.set(liveUrl(2), ok(liveUrl(2), searchHtml(LIVE.slice(2), 2, 2)));
    const { crawlRun } = await runEtendersGeCrawl(
      { db, httpFetcher: new FakeFetcher(responses), now: clock(NOW) },
      { windowDays: WINDOW_DAYS },
    );
    expect(crawlRun.status).toBe('partial');
  });

  it('records each status change of a run as an event, with the run', async () => {
    const { crawlRun } = await runEtendersGeCrawl(
      {
        db,
        httpFetcher: new FakeFetcher(siteResponses({ live: LIVE, window: WINDOW })),
        now: clock(NOW),
      },
      { windowDays: WINDOW_DAYS },
    );
    const open = await listing('69679');
    const completed = await listing('69619');
    expect(await eventsOf(open?.id ?? '', completed?.id ?? '')).toEqual([
      { listing: open?.id, from: null, to: 'active', reason: 'first_seen', run: crawlRun.id },
      { listing: completed?.id, from: null, to: 'active', reason: 'first_seen', run: crawlRun.id },
      {
        listing: completed?.id,
        from: 'active',
        to: 'closed',
        reason: 'source_status',
        run: crawlRun.id,
      },
    ]);
  });

  describe('the outcome re-read (Phase 17C)', () => {
    const at = (days: number, hours = 0) => NOW + days * DAY_MS + hours * 60 * 60 * 1000;
    const iso = (ms: number) => new Date(ms).toISOString();

    /** A terminal page for tender `id`: another fixture's page with its number swapped in. */
    function terminalPage(id: string, fixtureId: '69619' | '69534'): HttpFetchResult {
      return ok(detailUrl(id), fixture(DETAILS[fixtureId] ?? '').replaceAll(fixtureId, id));
    }

    async function setExpired(sourceRecordId: string, deadline: number) {
      await db
        .update(sourceListings)
        .set({ status: 'expired', sourceDeadlineAt: iso(deadline) })
        .where(
          and(
            eq(sourceListings.sourceId, etendersGeSource.id),
            eq(sourceListings.sourceRecordId, sourceRecordId),
          ),
        );
    }

    async function currentAttributes(sourceRecordId: string) {
      const [revision] = await db
        .select()
        .from(sourceListingRevisions)
        .where(
          eq(sourceListingRevisions.id, (await listing(sourceRecordId))?.currentRevisionId ?? ''),
        );
      return revision?.structuredAttributes as {
        status: { code: number };
        biddersCount: number | null;
      };
    }

    function firstRun() {
      return runEtendersGeCrawl(
        {
          db,
          httpFetcher: new FakeFetcher(siteResponses({ live: LIVE, window: WINDOW })),
          now: clock(NOW),
        },
        { windowDays: WINDOW_DAYS },
      );
    }

    it('picks only expired tenders still waiting for an outcome, oldest deadline first, within the cap and the spacing', async () => {
      // 69679, 69617 and 69674 are open (status 1); 69619 completed, 69607 failed.
      await firstRun();
      await setExpired('69679', at(-10));
      await setExpired('69674', at(-20));
      await setExpired('69617', at(-100)); // past the 90 days
      await setExpired('69619', at(-5)); // already terminal

      const due = (now: number, limit = 10) => loadOutcomeRereads(db, { now: iso(now), limit });
      expect(await due(at(4))).toEqual(['69674', '69679']);
      expect(await due(at(4), 1)).toEqual(['69674']);
      expect(await due(at(4), 0)).toEqual([]);
      // Every page was read at NOW: two days later is too soon.
      expect(await due(at(2))).toEqual([]);
      // Ninety days after its deadline a tender is no longer read.
      expect(await due(at(80))).toEqual(['69679']);

      // A tender not expired is never picked, whatever its deadline.
      await db
        .update(sourceListings)
        .set({ status: 'active', sourceDeadlineAt: iso(at(-30)) })
        .where(
          and(
            eq(sourceListings.sourceId, etendersGeSource.id),
            eq(sourceListings.sourceRecordId, '69617'),
          ),
        );
      expect(await due(at(4))).toEqual(['69674', '69679']);
    });

    it('stores a terminal status as a new revision without reopening, within the cap, and never rereads it', async () => {
      const first = await firstRun();
      await setExpired('69679', at(-10));
      await setExpired('69674', at(-20));

      const run = (when: number, maxOutcomeRereads?: number) => {
        const fetcher = new FakeFetcher(
          siteResponses({
            live: [{ id: '69617', status: 1 }],
            window: [],
            windowFrom: windowFromAt(when),
            details: {
              [detailUrl('69679')]: terminalPage('69679', '69619'),
              [detailUrl('69674')]: terminalPage('69674', '69534'),
            },
          }),
        );
        return {
          fetcher,
          result: runEtendersGeCrawl(
            { db, httpFetcher: fetcher, now: clock(when) },
            {
              windowDays: WINDOW_DAYS,
              ...(maxOutcomeRereads === undefined ? {} : { maxOutcomeRereads }),
            },
          ),
        };
      };

      // Capped at one: the oldest deadline goes first.
      const capped = run(at(4), 1);
      const second = await capped.result;
      expect(second.stats).toMatchObject({
        outcomeRereadsDue: 1,
        outcomeRereads: 1,
        outcomeTerminal: 1,
        outcomeChanged: 1,
        outcomeReopened: 0,
        outcomeFailed: 0,
      });
      expect(capped.fetcher.requested).toContain(detailUrl('69674'));
      expect(capped.fetcher.requested).not.toContain(detailUrl('69679'));
      expect((await listing('69674'))?.status).toBe('expired');
      expect((await currentAttributes('69674')).status.code).toBe(4);
      expect((await currentAttributes('69679')).status.code).toBe(1);

      // The next run takes the other; the terminated one is done.
      const next = run(at(4, 1));
      const third = await next.result;
      expect(third.stats).toMatchObject({
        outcomeRereadsDue: 1,
        outcomeRereads: 1,
        outcomeTerminal: 1,
        outcomeChanged: 1,
        outcomeReopened: 0,
      });
      expect(next.fetcher.requested).not.toContain(detailUrl('69674'));
      expect((await listing('69679'))?.status).toBe('expired');
      expect(await currentAttributes('69679')).toMatchObject({
        status: { code: 99 },
        biddersCount: 2,
      });

      // Neither re-read changed a status, so neither recorded an event.
      const reread = [(await listing('69679'))?.id ?? '', (await listing('69674'))?.id ?? ''];
      const events = await eventsOf(...reread);
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.run === first.crawlRun.id)).toBe(true);

      // Nothing is left to read.
      expect(await loadOutcomeRereads(db, { now: iso(at(10)), limit: 10 })).toEqual([]);
    });

    it('leaves an expired tender as it is when its page cannot be parsed', async () => {
      await firstRun();
      await setExpired('69679', at(-10));
      const when = at(4);
      const { stats } = await runEtendersGeCrawl(
        {
          db,
          httpFetcher: new FakeFetcher(
            siteResponses({
              live: [{ id: '69617', status: 1 }],
              window: [],
              windowFrom: windowFromAt(when),
              // Another tender's page: the parser refuses it.
              details: {
                [detailUrl('69679')]: ok(detailUrl('69679'), fixture(DETAILS['69674'] ?? '')),
              },
            }),
          ),
          now: clock(when),
        },
        { windowDays: WINDOW_DAYS },
      );
      expect(stats).toMatchObject({ outcomeRereads: 1, outcomeFailed: 1, outcomeTerminal: 0 });
      expect((await listing('69679'))?.status).toBe('expired');
      // Its page was read, so it waits out the spacing before the next try.
      expect(await loadOutcomeRereads(db, { now: iso(at(5)), limit: 10 })).toEqual([]);
      expect(await loadOutcomeRereads(db, { now: iso(at(7, 1)), limit: 10 })).toEqual(['69679']);
    });
  });
});
