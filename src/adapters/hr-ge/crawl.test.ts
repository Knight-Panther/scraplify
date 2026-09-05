import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/client.js';
import { sourceListingRevisions, sourceListings } from '../../db/schema/index.js';
import { cleanupTestSource } from '../../db/test-support.js';
import type { HttpFetcher, HttpFetchResult } from '../../net/http-fetcher.js';
import { hrGeSource } from '../../policies/hr-ge.js';
import { runHrGeCrawl } from './crawl.js';

// Isolates every DB write this file makes under a disposable, random source
// id — without this, afterEach's cleanupTestSource(hrGeSource.id) would
// delete every real hr.ge row a shared dev database might already hold.
// Mirrors src/adapters/jobs-ge/crawl.test.ts's own isolation exactly — see
// there for the full rationale (vi.hoisted, only id fields overridden,
// baseUrl/policy shape stay real).
const testIds = vi.hoisted(() => ({
  sourceId: crypto.randomUUID(),
  policyId: crypto.randomUUID(),
}));

vi.mock('../../policies/hr-ge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../policies/hr-ge.js')>();
  return {
    ...actual,
    hrGeSource: { ...actual.hrGeSource, id: testIds.sourceId },
    hrGePolicy: { ...actual.hrGePolicy, id: testIds.policyId, sourceId: testIds.sourceId },
  };
});

class FakeHttpFetcher implements HttpFetcher {
  constructor(private responses: Map<string, HttpFetchResult | Error>) {}

  async fetch(url: string): Promise<HttpFetchResult> {
    const entry = this.responses.get(url);
    if (entry === undefined) {
      throw new Error(`FakeHttpFetcher: no canned response for ${url}`);
    }
    if (entry instanceof Error) throw entry;
    return entry;
  }

  async close(): Promise<void> {}
}

function htmlResponse(
  url: string,
  body: string,
  extra: Partial<HttpFetchResult> = {},
): HttpFetchResult {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body,
    finalUrl: url,
    redirectCount: 0,
    ...extra,
  };
}

function notFoundResponse(url: string): HttpFetchResult {
  return {
    status: 404,
    headers: {},
    body: '<html><body>soft 404</body></html>',
    finalUrl: url,
    redirectCount: 0,
  };
}

function searchPostingUrl(page = 1): string {
  const url = new URL('/search-posting', hrGeSource.baseUrl);
  if (page > 1) url.searchParams.set('pg', String(page));
  return url.toString();
}

function detailUrl(id: string): string {
  return `https://www.hr.ge/announcement/${id}/slug-${id}`;
}

const SITEMAP_URL = 'https://api.p.hr.ge/public-portal/tenant/1/api/v3/seo/sitemap';

interface ItemSpec {
  id: string;
  title?: string;
  isPriority?: boolean;
  publishDate?: string;
}

function buildSearchPostingHtml(items: ItemSpec[], totalCount: number): string {
  const anchors = items
    .map(
      (item) => `<a href="/announcement/${item.id}/slug-${item.id}">${item.title ?? item.id}</a>`,
    )
    .join('');
  const ngItems = items.map((item) => ({
    announcementId: Number(item.id),
    title: item.title ?? `Listing ${item.id}`,
    isPriority: item.isPriority ?? false,
    listingSection: 0,
    publishDate: item.publishDate ?? '2026-09-01T00:00:00',
    renewalDate: null,
    deadlineDate: '2026-12-01T00:00:00',
  }));
  const ngState = JSON.stringify({
    1: {
      u: 'https://api.p.hr.ge/public-portal/tenant/1/api/v3/announcement-search',
      b: { data: { announcements: { items: ngItems, totalCount } } },
    },
  });
  return `<html><body>${anchors}<script id="ng-state" type="application/json">${ngState}</script></body></html>`;
}

interface DetailSpec {
  id: string;
  title?: string;
  applicationMethod?: number;
  email?: string | null;
  applicationUrl?: string | null;
  hideContactPerson?: boolean;
}

function buildDetailHtml(spec: DetailSpec): string {
  const announcement = {
    announcementId: Number(spec.id),
    title: spec.title ?? `Listing ${spec.id}`,
    customerName: 'Test Org',
    isAnonymous: false,
    description: `Description for ${spec.id}`,
    addresses: ['თბილისი'],
    publishDate: '2026-09-01T00:00:00',
    deadlineDate: '2026-12-01T00:00:00',
    renewalDate: null,
    salaryFrom: null,
    salaryTo: null,
    showSalary: false,
    applicationMethod: spec.applicationMethod ?? 1,
    applicationDetails: {
      email: spec.email ?? `test-${spec.id}@example.invalid`,
      applicationUrl: spec.applicationUrl ?? null,
    },
    hideContactPerson: spec.hideContactPerson ?? false,
    announcementRequirements: null,
    employerRequirements: null,
  };
  const ngState = JSON.stringify({
    1: {
      u: `https://api.p.hr.ge/public-portal/tenant/1/api/v3/announcement/${spec.id}`,
      b: { data: { announcement } },
    },
  });
  return `<html><body><script id="ng-state" type="application/json">${ngState}</script></body></html>`;
}

function sitemapXml(ids: string[]): string {
  const urls = ids
    .map((id) => `<url><loc>https://www.hr.ge/announcement/${id}/slug-${id}</loc></url>`)
    .join('');
  return `<?xml version="1.0"?><urlset>${urls}</urlset>`;
}

/** A fake clock that advances by 1ms per call — monotonic, deterministic, no real delay. */
function makeClock(startEpochMs: number): () => string {
  let t = startEpochMs;
  return () => new Date(t++).toISOString();
}

/**
 * `sourceRecordId` is only unique per-source (concept §12.1: uniqueness is
 * `(sourceId, sourceRecordId)`), not globally — a query filtering on it
 * alone can match a different source's row entirely. This bit in practice:
 * src/adapters/jobs-ge/crawl.test.ts's own tests also use the literal ids
 * '1001'/'1002', and running both files' tests concurrently against the
 * one shared dev database intermittently returned jobs.ge's row instead of
 * this file's, since an unfiltered query has no ORDER BY to make "the
 * first match" deterministic. Every lookup below is scoped to this file's
 * own disposable hrGeSource.id (see the vi.mock above) specifically to
 * avoid that.
 */
async function findListingByRecordId(sourceRecordId: string) {
  const [row] = await db
    .select()
    .from(sourceListings)
    .where(
      and(
        eq(sourceListings.sourceId, hrGeSource.id),
        eq(sourceListings.sourceRecordId, sourceRecordId),
      ),
    );
  return row;
}

const BASE_OPTIONS = { missingStreakThreshold: 3, skipSitemapCrossCheck: true } as const;

describe('runHrGeCrawl', () => {
  afterEach(async () => {
    await cleanupTestSource(hrGeSource.id);
  });

  it('uses a disposable test source id, never the real hrGeSource.id constant', () => {
    expect(hrGeSource.id).not.toBe('0c0495e8-0c3c-47a3-9f82-f8509aedf507');
  });

  it('discovers via the real 404 terminator, fetches, and writes new listings on a first, complete run', async () => {
    const ids = ['1001', '1002', '1003'];
    const responses = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(
          searchPostingUrl(1),
          buildSearchPostingHtml(
            ids.map((id) => ({ id })),
            3,
          ),
        ),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      ...ids.map(
        (id) => [detailUrl(id), htmlResponse(detailUrl(id), buildDetailHtml({ id }))] as const,
      ),
    ]);

    const result = await runHrGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 5, 12, 0, 0)),
      },
      BASE_OPTIONS,
    );

    expect(result.crawlRun.status).toBe('completed');
    expect(result.crawlRun.fullCoverage).toBe(true);
    expect(result.crawlRun.discoveredCount).toBe(3);
    expect(result.crawlRun.newCount).toBe(3);
    expect(result.crawlRun.failedCount).toBe(0);
    expect(result.crawlRun.quarantinedCount).toBe(0);
    expect(result.crawlRun.reconciledAt).not.toBeNull();

    const rows = await db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.sourceId, hrGeSource.id));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe('active');
      expect(row.currentRevisionId).not.toBeNull();
    }
  });

  it('reruns idempotently: an unchanged second run reports unchanged, not new, and creates no duplicate revisions', async () => {
    const ids = ['1001', '1002'];
    const responses = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(
          searchPostingUrl(1),
          buildSearchPostingHtml(
            ids.map((id) => ({ id })),
            2,
          ),
        ),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      ...ids.map(
        (id) => [detailUrl(id), htmlResponse(detailUrl(id), buildDetailHtml({ id }))] as const,
      ),
    ]);
    const httpFetcher = new FakeHttpFetcher(responses);
    const clock = makeClock(Date.UTC(2026, 8, 5, 12, 0, 0));

    const first = await runHrGeCrawl({ db, httpFetcher, now: clock }, BASE_OPTIONS);
    expect(first.crawlRun.newCount).toBe(2);

    const second = await runHrGeCrawl({ db, httpFetcher, now: clock }, BASE_OPTIONS);
    expect(second.crawlRun.status).toBe('completed');
    expect(second.crawlRun.newCount).toBe(0);
    expect(second.crawlRun.unchangedCount).toBe(2);
    expect(second.crawlRun.missingCount).toBe(0);

    const listingsRows = await db
      .select({ id: sourceListings.id })
      .from(sourceListings)
      .where(eq(sourceListings.sourceId, hrGeSource.id));
    const revisions = await db
      .select()
      .from(sourceListingRevisions)
      .where(
        inArray(
          sourceListingRevisions.sourceListingId,
          listingsRows.map((r) => r.id),
        ),
      );
    expect(revisions).toHaveLength(2);
  });

  it('marks a listing missing_suspected once it disappears from discovery on a later complete run', async () => {
    const clock = makeClock(Date.UTC(2026, 8, 5, 12, 0, 0));

    const responsesRun1 = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(
          searchPostingUrl(1),
          buildSearchPostingHtml([{ id: '1001' }, { id: '1002' }], 2),
        ),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), buildDetailHtml({ id: '1001' }))],
      [detailUrl('1002'), htmlResponse(detailUrl('1002'), buildDetailHtml({ id: '1002' }))],
    ]);
    await runHrGeCrawl(
      { db, httpFetcher: new FakeHttpFetcher(responsesRun1), now: clock },
      BASE_OPTIONS,
    );

    const responsesRun2 = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(searchPostingUrl(1), buildSearchPostingHtml([{ id: '1001' }], 1)),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), buildDetailHtml({ id: '1001' }))],
    ]);
    const second = await runHrGeCrawl(
      { db, httpFetcher: new FakeHttpFetcher(responsesRun2), now: clock },
      BASE_OPTIONS,
    );

    expect(second.crawlRun.status).toBe('completed');
    expect(second.crawlRun.missingCount).toBe(1);

    const stillActive = await findListingByRecordId('1001');
    expect(stillActive?.status).toBe('active');
    const nowMissing = await findListingByRecordId('1002');
    expect(nowMissing?.status).toBe('missing_suspected');
    expect(nowMissing?.missingStreak).toBe(1);
  });

  it('records a failed detail fetch as failedCount without blocking other listings, and keeps the listing visible via touchSourceListingSeen', async () => {
    const responses = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(
          searchPostingUrl(1),
          buildSearchPostingHtml([{ id: '1001' }, { id: '1002' }], 2),
        ),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), buildDetailHtml({ id: '1001' }))],
      [detailUrl('1002'), new Error('simulated network failure')],
    ]);

    const result = await runHrGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 5, 12, 0, 0)),
      },
      BASE_OPTIONS,
    );

    expect(result.crawlRun.failedCount).toBe(1);
    expect(result.crawlRun.newCount).toBe(1);

    const failed = await findListingByRecordId('1002');
    // touchSourceListingSeen still records it was seen in discovery, even
    // though the detail fetch failed — it must not look missing.
    expect(failed?.status).toBe('discovered');
    expect(failed?.missingStreak).toBe(0);
  });

  it('quarantines a listing on a detail parse failure and records a parser incident, without aborting the run', async () => {
    const responses = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(
          searchPostingUrl(1),
          buildSearchPostingHtml([{ id: '1001' }, { id: '1002' }], 2),
        ),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), buildDetailHtml({ id: '1001' }))],
      // No ng-state island at all -> HrGeDetailParseError -> quarantine.
      [
        detailUrl('1002'),
        htmlResponse(detailUrl('1002'), '<html><body>broken template</body></html>'),
      ],
    ]);

    const result = await runHrGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 5, 12, 0, 0)),
      },
      BASE_OPTIONS,
    );

    expect(result.crawlRun.quarantinedCount).toBe(1);
    expect(result.crawlRun.newCount).toBe(1);

    const quarantined = await findListingByRecordId('1002');
    expect(quarantined?.status).toBe('quarantined');
  });

  it('marks the run partial when collected listings fall short of the source-stated totalCount beyond tolerance', async () => {
    // totalCount claims 20, but only 2 are actually returned — a real
    // shortfall of 18, well past DEFAULT_MAX_DISCOVERY_SHORTFALL.
    const responses = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(
          searchPostingUrl(1),
          buildSearchPostingHtml([{ id: '1001' }, { id: '1002' }], 20),
        ),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), buildDetailHtml({ id: '1001' }))],
      [detailUrl('1002'), htmlResponse(detailUrl('1002'), buildDetailHtml({ id: '1002' }))],
    ]);

    const result = await runHrGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 5, 12, 0, 0)),
      },
      BASE_OPTIONS,
    );

    expect(result.crawlRun.status).toBe('partial');
    // A partial run must not have advanced closure for anyone.
    expect(result.crawlRun.missingCount).toBe(0);
  });

  it('treats a WAF-challenged detail response as blocked, not a parse attempt', async () => {
    const responses = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(searchPostingUrl(1), buildSearchPostingHtml([{ id: '1001' }], 1)),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      [
        detailUrl('1001'),
        htmlResponse(detailUrl('1001'), 'js challenge page', {
          headers: { 'x-amzn-waf-action': 'challenge' },
        }),
      ],
    ]);

    const result = await runHrGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 5, 12, 0, 0)),
      },
      BASE_OPTIONS,
    );

    // 'blocked' outcome, same bucket as failedCount — never parsed, never
    // quarantined (quarantine is specifically for a successful fetch that
    // failed to PARSE, not a fetch the source itself refused).
    expect(result.crawlRun.failedCount).toBe(1);
    expect(result.crawlRun.quarantinedCount).toBe(0);
  });

  it('recovers a sitemap-only candidate the index walk missed, without ever using the sitemap to infer absence', async () => {
    const responses = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(searchPostingUrl(1), buildSearchPostingHtml([{ id: '1001' }], 1)),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      [SITEMAP_URL, htmlResponse(SITEMAP_URL, sitemapXml(['1001', '1002']))],
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), buildDetailHtml({ id: '1001' }))],
      [detailUrl('1002'), htmlResponse(detailUrl('1002'), buildDetailHtml({ id: '1002' }))],
    ]);

    const result = await runHrGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 5, 12, 0, 0)),
      },
      { missingStreakThreshold: 3 }, // sitemap cross-check enabled
    );

    expect(result.crawlRun.discoveredCount).toBe(2);
    expect(result.crawlRun.newCount).toBe(2);

    const recovered = await findListingByRecordId('1002');
    expect(recovered?.status).toBe('active');
  });

  it('a sitemap fetch failure never fails the run — the cross-check is skippable', async () => {
    const responses = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(searchPostingUrl(1), buildSearchPostingHtml([{ id: '1001' }], 1)),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      [SITEMAP_URL, new Error('simulated sitemap fetch failure')],
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), buildDetailHtml({ id: '1001' }))],
    ]);

    const result = await runHrGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 5, 12, 0, 0)),
      },
      { missingStreakThreshold: 3 },
    );

    expect(result.crawlRun.status).toBe('completed');
    expect(result.crawlRun.discoveredCount).toBe(1);
  });

  it('honors hideContactPerson: a leaked contact field never reaches the stored revision', async () => {
    const responses = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(searchPostingUrl(1), buildSearchPostingHtml([{ id: '1001' }], 1)),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      [
        detailUrl('1001'),
        htmlResponse(detailUrl('1001'), buildDetailHtml({ id: '1001', hideContactPerson: true })),
      ],
    ]);

    await runHrGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 5, 12, 0, 0)),
      },
      BASE_OPTIONS,
    );

    const listing = await findListingByRecordId('1001');
    expect(listing?.currentRevisionId).not.toBeNull();
    const [revision] = await db
      .select()
      .from(sourceListingRevisions)
      .where(eq(sourceListingRevisions.id, listing?.currentRevisionId as string));
    expect((revision?.structuredAttributes as Record<string, unknown>)?.hideContactPerson).toBe(
      true,
    );
    expect(JSON.stringify(revision)).not.toContain('contactName');
  });
});
