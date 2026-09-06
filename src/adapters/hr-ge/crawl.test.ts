import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/client.js';
import { getCrawlCursor } from '../../db/ingest.js';
import {
  crawlCursors,
  crawlRuns,
  sourceListingRevisions,
  sourceListings,
} from '../../db/schema/index.js';
import { cleanupTestSource } from '../../db/test-support.js';
import type { HttpFetcher, HttpFetchResult } from '../../net/http-fetcher.js';
import { hrGeSource } from '../../policies/hr-ge.js';
import { runHrGeCrawl } from './crawl.js';

// Wraps the REAL getCrawlCursor by default (every other test in this file
// relies on its genuine behavior) — only the round-7 regression test below
// overrides it once, via mockRejectedValueOnce, to simulate a transient
// database failure at exactly that call site.
vi.mock('../../db/ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/ingest.js')>();
  return { ...actual, getCrawlCursor: vi.fn(actual.getCrawlCursor) };
});

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

/**
 * Simulates a real rate limiter that rejects after a fixed NUMBER of detail
 * (`/announcement/`) requests, regardless of which URLs those happen to be —
 * used to prove processing-order rotation actually changes which listings
 * get covered when the same request-count boundary recurs every run.
 */
class RateLimitAfterNDetailFetches implements HttpFetcher {
  private detailFetchCount = 0;
  constructor(
    private inner: HttpFetcher,
    private limit: number,
  ) {}

  async fetch(url: string): Promise<HttpFetchResult> {
    if (url.includes('/announcement/')) {
      this.detailFetchCount++;
      if (this.detailFetchCount > this.limit) {
        return rateLimitedResponse(url);
      }
    }
    return this.inner.fetch(url);
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

function rateLimitedResponse(url: string): HttpFetchResult {
  return {
    status: 429,
    headers: { 'ratelimit-remaining': '0' },
    body: 'rate limited',
    finalUrl: url,
    redirectCount: 0,
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
function makeClock(startEpochMs: number): (() => string) & { advance: (ms: number) => void } {
  let t = startEpochMs;
  return Object.assign(() => new Date(t++).toISOString(), {
    advance: (ms: number) => {
      t += ms;
    },
  });
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

/** Reads the persisted cross-run cursor directly from crawl_cursors (src/db/schema/crawl-cursors.ts) — null if no row exists yet, or if the row's own value is null. */
async function getCursor(): Promise<string | null> {
  const [row] = await db
    .select()
    .from(crawlCursors)
    .where(eq(crawlCursors.sourceId, hrGeSource.id));
  return row?.nextSourceRecordId ?? null;
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

  it('treats a 200 response with Ratelimit-Remaining: 0 as success, not as a discarded retry (regression, adversarial review 2026-09-05)', async () => {
    const responses = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(searchPostingUrl(1), buildSearchPostingHtml([{ id: '1001' }], 1)),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      [
        detailUrl('1001'),
        htmlResponse(detailUrl('1001'), buildDetailHtml({ id: '1001' }), {
          headers: { 'ratelimit-remaining': '0' },
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

    // Before the fix, isHrGeRateLimited was checked ahead of the status
    // check, so this exact response (valid 200 body, exhausted quota
    // header) classified as 'retry' and was never parsed at all. The new
    // run-wide cooldown marks the run partial while preserving this content.
    expect(result.crawlRun.status).toBe('partial');
    expect(result.crawlRun.newCount).toBe(1);
    expect(result.crawlRun.failedCount).toBe(0);
    const listing = await findListingByRecordId('1001');
    expect(listing?.currentRevisionId).not.toBeNull();
  });

  it('stops fetching further listings after a genuine 429, rather than continuing at the same cadence (regression, adversarial review 2026-09-05)', async () => {
    const responses = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(
          searchPostingUrl(1),
          buildSearchPostingHtml([{ id: '1001' }, { id: '1002' }], 2),
        ),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      [detailUrl('1001'), rateLimitedResponse(detailUrl('1001'))],
      // Deliberately no canned response for detailUrl('1002') — if the fix
      // regresses back to `continue`ing past a 429, FakeHttpFetcher throws
      // "no canned response," which fetchAndRecord swallows into an
      // ordinary 'failure' outcome, so this test also inspects that 1002
      // was never even attempted, not just that the run didn't crash.
    ]);

    const result = await runHrGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 5, 12, 0, 0)),
      },
      BASE_OPTIONS,
    );

    expect(result.crawlRun.failedCount).toBe(1); // only 1001's 429, not a second failure for 1002
    expect(result.crawlRun.newCount).toBe(0);
    const neverAttempted = await findListingByRecordId('1002');
    expect(neverAttempted).toBeUndefined();
  });

  it('does not let a stale sitemap entry block closure of a genuinely-removed listing (regression, adversarial review 2026-09-05)', async () => {
    const clock = makeClock(Date.UTC(2026, 8, 5, 12, 0, 0));

    // Run 1: both listings genuinely discovered and fetched successfully.
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
    const afterRun1 = await findListingByRecordId('1002');
    expect(afterRun1?.status).toBe('active');

    // Run 2: 1002 has genuinely disappeared from the live index (search
    // only returns 1001), but the sitemap — which carries no lastmod and
    // can retain a removed listing indefinitely — still lists it, and its
    // detail page now 404s. Sitemap cross-check is enabled this time.
    const responsesRun2 = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(searchPostingUrl(1), buildSearchPostingHtml([{ id: '1001' }], 1)),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      [SITEMAP_URL, htmlResponse(SITEMAP_URL, sitemapXml(['1001', '1002']))],
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), buildDetailHtml({ id: '1001' }))],
      [detailUrl('1002'), notFoundResponse(detailUrl('1002'))],
    ]);
    const second = await runHrGeCrawl(
      { db, httpFetcher: new FakeHttpFetcher(responsesRun2), now: clock },
      { missingStreakThreshold: 3 }, // sitemap cross-check enabled
    );

    expect(second.crawlRun.status).toBe('completed');
    // Before the fix, the failed sitemap-only fetch still called
    // touchSourceListingSeen, bumping lastSeenAt past run2's own
    // startedAt — which made 1002 permanently ineligible for
    // closeMissingListingsInTransaction's `lastSeenAt < run.startedAt`
    // check, leaving it 'active' forever despite being genuinely gone.
    const afterRun2 = await findListingByRecordId('1002');
    expect(afterRun2?.status).toBe('missing_suspected');
    expect(afterRun2?.missingStreak).toBe(1);
  });

  it('marks the run partial (never completed) when a 429 aborts detail fetching partway through a large corpus, even though the ratio-based guards alone would pass (regression, adversarial review round 2, 2026-09-05)', async () => {
    const clock = makeClock(Date.UTC(2026, 8, 5, 12, 0, 0));
    const ids = Array.from({ length: 10 }, (_, i) => String(1001 + i));

    // Run 1: every listing genuinely discovered and fetched successfully,
    // establishing real prior state to check nothing wrongly advances.
    const responsesRun1 = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(
          searchPostingUrl(1),
          buildSearchPostingHtml(
            ids.map((id) => ({ id })),
            10,
          ),
        ),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      ...ids.map(
        (id) => [detailUrl(id), htmlResponse(detailUrl(id), buildDetailHtml({ id }))] as const,
      ),
    ]);
    await runHrGeCrawl(
      { db, httpFetcher: new FakeHttpFetcher(responsesRun1), now: clock },
      BASE_OPTIONS,
    );

    // Run 2: discovery finds all 10 again (fully complete, real totalCount),
    // but the very first detail fetch 429s, aborting the loop — the other
    // 9 are never even attempted. A single failure out of 10 (10%) clears
    // every existing ratio-based guard (maxFetchFailureRate 50%,
    // maxQuarantineRate 10%) on its own.
    const responsesRun2 = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(
          searchPostingUrl(1),
          buildSearchPostingHtml(
            ids.map((id) => ({ id })),
            10,
          ),
        ),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      [detailUrl(ids[0] as string), rateLimitedResponse(detailUrl(ids[0] as string))],
      // No canned responses for ids[1..9] — if the loop wrongly continues
      // past the 429, FakeHttpFetcher throws and those get counted as
      // ordinary failures instead, which would itself trip
      // maxFetchFailureRate and mask the real bug this test targets.
    ]);
    const second = await runHrGeCrawl(
      { db, httpFetcher: new FakeHttpFetcher(responsesRun2), now: clock },
      BASE_OPTIONS,
    );

    // Before this fix, discoveryOk only looked at ratio-based guards —
    // fetchFailureRate here is 1/10 = 0.1, well under the 0.5 ceiling — so
    // the run was wrongly marked 'completed', and closeMissingListingsInTransaction
    // would have advanced all 9 untouched (not merely failed — NEVER
    // ATTEMPTED) listings toward missing_suspected.
    expect(second.crawlRun.status).toBe('partial');
    expect(second.crawlRun.missingCount).toBe(0);

    for (const id of ids.slice(1)) {
      const listing = await findListingByRecordId(id);
      expect(listing?.status).toBe('active');
      expect(listing?.missingStreak).toBe(0);
    }
  });

  it('resumes AT the rejected listing (not after it) so a recurring same-count rate-limit boundary cannot lock any listing out forever (regression, adversarial review round 5, 2026-09-05)', async () => {
    // Reproduces the exact counterexample adversarial review used to
    // disprove an earlier version of this fix: 8 stable listings, a rate
    // limit that always allows exactly 3 detail requests before rejecting
    // the 4th. A cursor that resumed AFTER the rejected listing (round 4's
    // version) settles into a stable 2-run cycle for this N/K combination
    // — confirmed by direct simulation before writing this test — where
    // whichever listing always lands in the 4th position of its lap is
    // skipped every single time, forever (items 4 and 8, specifically, in
    // the simulated case). Resuming AT the rejected listing instead means
    // it becomes the FIRST attempt of the very next run, so it is retried
    // rather than perpetually skipped — the same simulation with this
    // change reaches full 8-listing coverage by the third run.
    const ids = Array.from({ length: 8 }, (_, i) => String(1001 + i));
    const detailFetchLimit = 3;

    function buildResponses(): Map<string, HttpFetchResult | Error> {
      return new Map<string, HttpFetchResult | Error>([
        [
          searchPostingUrl(1),
          htmlResponse(
            searchPostingUrl(1),
            buildSearchPostingHtml(
              ids.map((id) => ({ id })),
              8,
            ),
          ),
        ],
        [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
        ...ids.map(
          (id) => [detailUrl(id), htmlResponse(detailUrl(id), buildDetailHtml({ id }))] as const,
        ),
      ]);
    }

    async function coveredIds(): Promise<Set<string>> {
      const covered = new Set<string>();
      for (const id of ids) {
        const listing = await findListingByRecordId(id);
        if (listing?.currentRevisionId) covered.add(id);
      }
      return covered;
    }

    const clock = makeClock(Date.UTC(2026, 8, 5, 12, 0, 0));
    const runOnce = () =>
      runHrGeCrawl(
        {
          db,
          // A fresh limiter each call — a real rate-limit window resets,
          // it doesn't remember across separate runs.
          httpFetcher: new RateLimitAfterNDetailFetches(
            new FakeHttpFetcher(buildResponses()),
            detailFetchLimit,
          ),
          now: clock,
        },
        BASE_OPTIONS,
      );

    const first = await runOnce();
    expect(first.crawlRun.status).toBe('partial');
    expect(await getCursor()).toBe('1004'); // the one that 429'd
    expect((await coveredIds()).size).toBe(3); // 1001-1003

    clock.advance(120_000); // the persisted rate-limit window has now elapsed
    const second = await runOnce();
    expect(second.crawlRun.status).toBe('partial');
    // 1004 is retried FIRST this run (resuming AT it) and succeeds; 1007
    // is the one that then 429s (1004,1005,1006 = 3 successes).
    expect(await getCursor()).toBe('1007');
    expect((await coveredIds()).size).toBe(6); // 1001-1006

    clock.advance(120_000);
    await runOnce();
    // 1001-1008 all reachable by the third run — no listing was ever
    // permanently skipped, unlike the round-4 "resume after" design.
    expect((await coveredIds()).size).toBe(8);
  });

  it("preserves the previous run's cursor rather than wiping it out when this run never attempts any detail fetch at all (regression, adversarial review round 5, 2026-09-05)", async () => {
    const clock = makeClock(Date.UTC(2026, 8, 5, 12, 0, 0));

    // Run 1: rate-limited after 1 successful detail fetch — establishes a
    // real, non-null cursor to protect.
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
      [detailUrl('1002'), rateLimitedResponse(detailUrl('1002'))],
    ]);
    await runHrGeCrawl(
      { db, httpFetcher: new FakeHttpFetcher(responsesRun1), now: clock },
      BASE_OPTIONS,
    );
    expect(await getCursor()).toBe('1002');

    // Run 2: discovery itself is rate-limited on page 1 — the per-listing
    // loop never runs at all, so nothing new was learned this run.
    const responsesRun2 = new Map<string, HttpFetchResult | Error>([
      [searchPostingUrl(1), rateLimitedResponse(searchPostingUrl(1))],
    ]);
    clock.advance(120_000);
    const second = await runHrGeCrawl(
      { db, httpFetcher: new FakeHttpFetcher(responsesRun2), now: clock },
      BASE_OPTIONS,
    );
    expect(second.crawlRun.status).toBe('partial');
    expect(second.crawlRun.discoveredCount).toBe(0);
    // The whole point: an earlier version of this fix always persisted
    // whatever lastAttemptedSourceRecordId happened to be (null here,
    // since the per-listing loop never ran), which explicitly wiped out
    // run 1's real cursor on a run that made zero progress — silently
    // resetting to the head and recreating the exact starvation this
    // mechanism exists to prevent, just triggered by a discovery-level
    // rate limit rather than a detail-level one.
    expect(await getCursor()).toBe('1002');
  });

  it('does not withhold missing-streak protection from a sitemap-only candidate on a merely transient failure, only on a confirmed 404 (regression, adversarial review round 4, 2026-09-05)', async () => {
    const clock = makeClock(Date.UTC(2026, 8, 5, 12, 0, 0));

    // Run 1: 1002 genuinely active, discovered and fetched normally.
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

    // Run 2: 1002 is still genuinely active — the index walk's own
    // documented pagination-shift race (RECON_NOTES.md) just happens to
    // miss it this run — but the sitemap cross-check recovers it, and its
    // detail fetch fails for a TRANSIENT reason (a network error), not a
    // confirmed 404.
    const responsesRun2 = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(searchPostingUrl(1), buildSearchPostingHtml([{ id: '1001' }], 1)),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      [SITEMAP_URL, htmlResponse(SITEMAP_URL, sitemapXml(['1001', '1002']))],
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), buildDetailHtml({ id: '1001' }))],
      [detailUrl('1002'), new Error('simulated transient network failure')],
    ]);
    const second = await runHrGeCrawl(
      { db, httpFetcher: new FakeHttpFetcher(responsesRun2), now: clock },
      { missingStreakThreshold: 3 }, // sitemap cross-check enabled
    );

    expect(second.crawlRun.status).toBe('completed');
    // Before this fix, ANY sitemap-only failure (transient or not) skipped
    // touchSourceListingSeen, so this genuinely-still-active listing would
    // have started accumulating missingStreak purely from bad luck on a
    // race the source's own sitemap staleness already explains.
    const afterRun2 = await findListingByRecordId('1002');
    expect(afterRun2?.status).toBe('active');
    expect(afterRun2?.missingStreak).toBe(0);
  });

  it('does not treat a WAF-blocked response that happens to carry status 404 as confirmed absence (regression, adversarial review round 6, 2026-09-05)', async () => {
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

    // Run 2: 1002 is genuinely still active (missed by the index walk's own
    // race), recovered via the sitemap — but its detail fetch this time
    // returns status 404 WITH an explicit WAF-action header. classifyHttpResult
    // (challenge.ts) checks the WAF-challenge signal before falling back to
    // plain status handling, so this classifies 'blocked', not 'failure' —
    // evidence of a block, never evidence the listing doesn't exist.
    const responsesRun2 = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(searchPostingUrl(1), buildSearchPostingHtml([{ id: '1001' }], 1)),
      ],
      [searchPostingUrl(2), notFoundResponse(searchPostingUrl(2))],
      [SITEMAP_URL, htmlResponse(SITEMAP_URL, sitemapXml(['1001', '1002']))],
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), buildDetailHtml({ id: '1001' }))],
      [
        detailUrl('1002'),
        {
          status: 404,
          headers: { 'x-amzn-waf-action': 'block' },
          body: 'blocked',
          finalUrl: detailUrl('1002'),
          redirectCount: 0,
        },
      ],
    ]);
    await runHrGeCrawl(
      { db, httpFetcher: new FakeHttpFetcher(responsesRun2), now: clock },
      { missingStreakThreshold: 3 },
    );

    // Before this fix, `fetchResult?.status === 404` alone was sufficient
    // to treat this as confirmed absence, regardless of the WAF header.
    const afterRun2 = await findListingByRecordId('1002');
    expect(afterRun2?.status).toBe('active');
    expect(afterRun2?.missingStreak).toBe(0);
  });

  it('does not reset the cursor to null after a truncated discovery walk, even when every discovered listing was fully processed (regression, adversarial review round 6, 2026-09-05)', async () => {
    const clock = makeClock(Date.UTC(2026, 8, 5, 12, 0, 0));

    // Run 1: establishes a real cursor via a rate-limited detail fetch.
    const responsesRun1 = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(searchPostingUrl(1), buildSearchPostingHtml([{ id: '2001' }], 1)),
      ],
      [detailUrl('2001'), rateLimitedResponse(detailUrl('2001'))],
    ]);
    await runHrGeCrawl(
      { db, httpFetcher: new FakeHttpFetcher(responsesRun1), now: clock },
      BASE_OPTIONS,
    );
    expect(await getCursor()).toBe('2001');

    clock.advance(120_000);
    // Run 2: page 1 succeeds (a different listing, '3001' — small enough
    // that '2001' isn't even in this run's own discovered set), but page 2
    // fails with a genuine network error (not a 404 terminator), so
    // discovery itself is truncated (`complete: false`). The single
    // discovered listing then gets fully processed without hitting a
    // rate limit — a naive "loop finished without aborting -> reset the
    // cursor" rule (an earlier version of this fix) would wrongly discard
    // run 1's real cursor here.
    const responsesRun2 = new Map<string, HttpFetchResult | Error>([
      [
        searchPostingUrl(1),
        htmlResponse(searchPostingUrl(1), buildSearchPostingHtml([{ id: '3001' }], 50)),
      ],
      [searchPostingUrl(2), new Error('simulated transient discovery failure')],
      [detailUrl('3001'), htmlResponse(detailUrl('3001'), buildDetailHtml({ id: '3001' }))],
    ]);
    const second = await runHrGeCrawl(
      { db, httpFetcher: new FakeHttpFetcher(responsesRun2), now: clock },
      BASE_OPTIONS,
    );

    expect(second.crawlRun.status).toBe('partial'); // discovery incomplete
    expect(await getCursor()).toBe('2001'); // unchanged, not reset to null
  });

  it('settles the run (marks it failed, not permanently unsettled) when reading the cursor itself throws (regression, adversarial review round 7, 2026-09-05)', async () => {
    const clock = makeClock(Date.UTC(2026, 8, 5, 12, 0, 0));
    vi.mocked(getCrawlCursor).mockRejectedValueOnce(
      new Error('simulated transient database failure reading the cursor'),
    );

    // Never reached — the failure happens before any fetch.
    const responses = new Map<string, HttpFetchResult | Error>();

    await expect(
      runHrGeCrawl({ db, httpFetcher: new FakeHttpFetcher(responses), now: clock }, BASE_OPTIONS),
    ).rejects.toThrow('simulated transient database failure reading the cursor');

    // Before this fix, getCrawlCursor was called BETWEEN startCrawlRun and
    // the try block that guards failUnsettledCrawlRun — a failure here
    // would leave the row's reconciledAt permanently null, which
    // (crawl_runs_one_unsettled_per_source_idx) blocks every future crawl
    // for this source until someone manually clears it by hand.
    const [run] = await db.select().from(crawlRuns).where(eq(crawlRuns.sourceId, hrGeSource.id));
    expect(run?.status).toBe('failed');
    expect(run?.reconciledAt).not.toBeNull();
  });
});
