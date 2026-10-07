import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/client.js';
import { parserIncidents, sourceListingRevisions, sourceListings } from '../../db/schema/index.js';
import { cleanupTestSource, createTestSourceListing } from '../../db/test-support.js';
import type { HttpFetcher, HttpFetchResult } from '../../net/http-fetcher.js';
import { etendersGeSource } from '../../policies/etenders-ge.js';
import {
  buildSearchUrl,
  ensureEtendersGeSourceSeeded,
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
});
