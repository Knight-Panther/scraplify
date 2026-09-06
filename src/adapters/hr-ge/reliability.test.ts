import { and, eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { db } from '../../db/client.js';
import {
  getCrawlCursor,
  getCrawlDiscoveryPage,
  getLastCompletedCrawlRun,
  getSourceBackoffUntil,
  setCrawlCursor,
  setCrawlDiscoveryPage,
} from '../../db/ingest.js';
import { sourceListings, sourcePolicies } from '../../db/schema/index.js';
import { cleanupTestSource } from '../../db/test-support.js';
import type { HttpFetcher, HttpFetchResult } from '../../net/http-fetcher.js';
import { hrGeSource } from '../../policies/hr-ge.js';
import { runHrGeCrawl } from './crawl.js';

const ids = vi.hoisted(() => ({ source: crypto.randomUUID(), policy: crypto.randomUUID() }));
vi.mock('../../policies/hr-ge.js', async (original) => {
  const actual = await original<typeof import('../../policies/hr-ge.js')>();
  return {
    ...actual,
    hrGeSource: { ...actual.hrGeSource, id: ids.source, slug: `reliability-${ids.source}` },
    hrGePolicy: { ...actual.hrGePolicy, id: ids.policy, sourceId: ids.source },
  };
});
afterEach(async () => {
  await cleanupTestSource(ids.source);
});
const all = Array.from({ length: 20 }, (_, n) => String(1001 + n));
const detailUrl = (id: string) => `https://www.hr.ge/announcement/${id}/listing`;
function island(path: string, data: unknown): string {
  return `<script id="ng-state" type="application/json">${JSON.stringify({ 1: { u: `https://api.p.hr.ge/public-portal/tenant/1/api/v3/${path}`, b: { data } } })}</script>`;
}
function indexHtml(list: string[], totalCount: number): string {
  return (
    list.map((id) => `<a href="/announcement/${id}/listing">listing</a>`).join('') +
    island('announcement-search', {
      announcements: {
        items: list.map((id) => ({ announcementId: Number(id), title: 'Listing' })),
        totalCount,
      },
    })
  );
}
function detailHtml(id: string): string {
  return island(`announcement/${id}`, {
    announcement: {
      announcementId: Number(id),
      title: 'Listing',
      description: 'Full job description',
      customerName: 'Employer',
      publishDate: '2026-09-01T00:00:00',
      deadlineDate: '2026-12-01T00:00:00',
    },
  });
}
function fetcher(
  list: string[],
  total: number,
  terminal: Partial<HttpFetchResult> = {},
  sitemapIds: string[] = [],
) {
  const calls: string[] = [];
  const impl: HttpFetcher = {
    async fetch(url) {
      calls.push(url);
      const base = { status: 200, headers: {}, body: '', finalUrl: url, redirectCount: 0 };
      if (url.includes('/seo/sitemap'))
        return {
          ...base,
          body: `<urlset>${sitemapIds.map((id) => `<url><loc>${detailUrl(id)}</loc></url>`).join('')}</urlset>`,
        };
      if (url.includes('/search-posting'))
        return url.includes('?pg=')
          ? { ...base, status: 404, ...terminal }
          : { ...base, body: indexHtml(list, total) };
      const id = /announcement\/(\d+)/.exec(url)?.[1] ?? '';
      return list.includes(id) ? { ...base, body: detailHtml(id) } : { ...base, status: 404 };
    },
    async close() {},
  };
  return { impl, calls };
}
async function run(f: HttpFetcher, day: number, sitemap = false) {
  return runHrGeCrawl(
    { db, httpFetcher: f, now: () => `2026-09-${String(day).padStart(2, '0')}T12:00:00Z` },
    { missingStreakThreshold: 3, skipSitemapCrossCheck: !sitemap },
  );
}
it('a blocked 404 cannot certify discovery or advance absence', async () => {
  await run(fetcher(all, 20).impl, 5);
  const f = fetcher(all.slice(0, 10), 20, {
    status: 404,
    headers: { 'x-amzn-waf-action': 'challenge' },
  });
  const result = await run(f.impl, 6);
  expect(result.crawlRun.status).toBe('partial');
  expect(result.crawlRun.missingCount).toBe(0);
  expect(f.calls).toHaveLength(2);
});
it('discovery 429 prevents subsequent sitemap and detail requests', async () => {
  const f = fetcher(all.slice(0, 3), 20, { status: 429, headers: { 'retry-after': '3600' } });
  const result = await run(f.impl, 5, true);
  expect(result.crawlRun.status).toBe('partial');
  expect(f.calls).toHaveLength(2);
});
it('failed sitemap candidates cannot certify incomplete index coverage', async () => {
  await run(fetcher(all, 20).impl, 5);
  const f = fetcher(all.slice(0, 10), 30, {}, all.slice(10));
  const result = await run(f.impl, 6, true);
  expect(result.crawlRun.status).toBe('partial');
  expect(result.crawlRun.missingCount).toBe(0);
  expect(result.crawlRun.discoveredCount).toBe(10);
});
it('a count-shortfall run preserves the established cursor', async () => {
  await run(fetcher(all, 20).impl, 5);
  await setCrawlCursor(db, hrGeSource.id, '1019', '2026-09-05T12:00:00Z');
  const result = await run(fetcher(all.slice(0, 3), 20).impl, 6);
  expect(result.crawlRun.status).toBe('partial');
  expect(await getCrawlCursor(db, hrGeSource.id)).toBe(all[18]);
});
it('title and ID alone cannot replace a healthy revision', async () => {
  await run(fetcher(all.slice(0, 1), 1).impl, 5);
  const where = and(
    eq(sourceListings.sourceId, hrGeSource.id),
    eq(sourceListings.sourceRecordId, '1001'),
  );
  const [before] = await db.select().from(sourceListings).where(where);
  const broken = fetcher(all.slice(0, 1), 1);
  const fetch = broken.impl.fetch.bind(broken.impl);
  broken.impl.fetch = async (url) => {
    const result = await fetch(url);
    return url.includes('/announcement/')
      ? {
          ...result,
          body: island('announcement/1001', {
            announcement: { announcementId: 1001, title: 'Listing' },
          }),
        }
      : result;
  };
  const result = await run(broken.impl, 6);
  const [after] = await db.select().from(sourceListings).where(where);
  expect(result.crawlRun.status).toBe('partial');
  expect(result.crawlRun.quarantinedCount).toBe(1);
  expect(after?.currentRevisionId).toBe(before?.currentRevisionId);
  expect(after?.sourceDeadlineAt).toBe(before?.sourceDeadlineAt);
});

it('a sitemap 429 stops the run and persists its cooldown across invocations', async () => {
  const f = fetcher(all.slice(0, 2), 2);
  const fetch = f.impl.fetch.bind(f.impl);
  f.impl.fetch = async (url) => {
    const result = await fetch(url);
    return url.includes('/seo/sitemap')
      ? { ...result, status: 429, headers: { 'retry-after': '3600' } }
      : result;
  };
  const first = await run(f.impl, 5, true);
  expect(first.crawlRun.status).toBe('partial');
  expect(f.calls).toHaveLength(3);
  expect(f.calls.every((url) => !url.includes('/announcement/'))).toBe(true);
  expect(Date.parse((await getSourceBackoffUntil(db, hrGeSource.id)) ?? '')).toBeGreaterThanOrEqual(
    Date.parse('2026-09-05T13:00:00Z'),
  );
  const blocked = fetcher(all, 20);
  const second = await run(blocked.impl, 5);
  expect(second.crawlRun.status).toBe('partial');
  expect(blocked.calls).toHaveLength(0);
  const resumed = fetcher(all, 20);
  expect((await run(resumed.impl, 6)).crawlRun.status).toBe('completed');
  expect(resumed.calls.length).toBeGreaterThan(0);
});

it('an incremental page limit performs useful work without touching the full-run cursor or closure', async () => {
  const full = await run(fetcher(all, 20).impl, 5);
  await setCrawlCursor(db, hrGeSource.id, '1019', '2026-09-05T12:00:00Z');
  const f = fetcher(all.slice(0, 3), 20);
  const result = await runHrGeCrawl(
    { db, httpFetcher: f.impl, now: () => '2026-09-06T12:00:00Z' },
    { missingStreakThreshold: 3, mode: 'incremental', incrementalPages: 1 },
  );
  expect(result.crawlRun.status).toBe('completed');
  expect(result.crawlRun.fullCoverage).toBe(false);
  expect(result.crawlRun.discoveredCount).toBe(3);
  expect(result.crawlRun.missingCount).toBe(0);
  expect(f.calls).toHaveLength(4);
  expect(f.calls.some((url) => url.includes('/seo/sitemap') || url.includes('?pg='))).toBe(false);
  expect(await getCrawlCursor(db, hrGeSource.id)).toBe('1019');
  expect((await getLastCompletedCrawlRun(db, hrGeSource.id))?.id).toBe(full.crawlRun.id);
});

it('incremental polling also stops immediately on a blocked response', async () => {
  const f = fetcher(all.slice(0, 3), 20, { status: 403 });
  const result = await runHrGeCrawl(
    { db, httpFetcher: f.impl, now: () => '2026-09-05T12:00:00Z' },
    { missingStreakThreshold: 3, mode: 'incremental', incrementalPages: 2 },
  );
  expect(result.crawlRun.status).toBe('partial');
  expect(result.crawlRun.fullCoverage).toBe(false);
  expect(f.calls).toHaveLength(2);
});

it('seeded policy persists the same positive host boundary used by the adapter', async () => {
  await run(fetcher(all.slice(0, 1), 1).impl, 5);
  const [policy] = await db
    .select()
    .from(sourcePolicies)
    .where(eq(sourcePolicies.sourceId, hrGeSource.id));
  expect(policy?.allowedHosts).toEqual(['www.hr.ge', 'api.p.hr.ge']);
});

it('a usable quota-exhausting detail is stored and the next unattempted item becomes the cursor', async () => {
  const f = fetcher(all.slice(0, 3), 3);
  const fetch = f.impl.fetch.bind(f.impl);
  f.impl.fetch = async (url) => {
    const result = await fetch(url);
    return url === detailUrl('1001')
      ? { ...result, headers: { 'ratelimit-remaining': '0', 'ratelimit-reset': '120' } }
      : result;
  };
  const first = await run(f.impl, 5);
  expect(first.crawlRun.newCount).toBe(1);
  expect(first.crawlRun.failedCount).toBe(0);
  expect(f.calls).toHaveLength(3);
  expect(await getCrawlCursor(db, hrGeSource.id)).toBe('1002');
  const resumed = fetcher(all.slice(0, 3), 3);
  await run(resumed.impl, 6);
  expect(resumed.calls.filter((url) => url.includes('/announcement/'))[0]).toBe(detailUrl('1002'));
  expect(await getCrawlCursor(db, hrGeSource.id)).toBeNull();
});

// hr.ge advertises 20 requests / 60s while a full index is ~33 pages
// (policies/hr-ge.ts), so a rate limit can land mid-walk. These cover what
// happens across invocations when it does.
function pagedFetcher(pages: string[][], stopAfterIndexRequests = Number.POSITIVE_INFINITY) {
  const calls: string[] = [];
  let indexRequests = 0;
  const total = pages.reduce((sum, page) => sum + page.length, 0);
  const impl: HttpFetcher = {
    async fetch(url) {
      calls.push(url);
      const base = { status: 200, headers: {}, body: '', finalUrl: url, redirectCount: 0 };
      if (url.includes('/search-posting')) {
        indexRequests++;
        const page = Number(/[?&]pg=(\d+)/.exec(url)?.[1] ?? '1');
        const list = pages[page - 1];
        if (list === undefined) return { ...base, status: 404 };
        // A usable 200 whose headers report the quota is spent: parsed and
        // recorded, then the run stops (fetch-control.ts).
        const headers =
          indexRequests >= stopAfterIndexRequests ? { 'ratelimit-remaining': '0' } : {};
        return { ...base, headers, body: indexHtml(list, total) };
      }
      const id = /announcement\/(\d+)/.exec(url)?.[1] ?? '';
      return pages.flat().includes(id)
        ? { ...base, body: detailHtml(id) }
        : { ...base, status: 404 };
    },
    async close() {},
  };
  return { impl, calls };
}
const pages = [all.slice(0, 4), all.slice(4, 8), all.slice(8, 12)];
const indexCalls = (calls: string[]) => calls.filter((url) => url.includes('/search-posting'));

it('a rate-limited walk resumes at the first uncovered page instead of restarting', async () => {
  const first = pagedFetcher(pages, 2);
  const one = await run(first.impl, 5);
  expect(one.crawlRun.status).toBe('partial');
  expect(one.crawlRun.discoveredCount).toBe(8);
  expect(indexCalls(first.calls)).toHaveLength(2);
  expect(await getCrawlDiscoveryPage(db, hrGeSource.id)).toBe(3);

  // Without the saved page this restarts at page 1, re-spends the same budget
  // on the same prefix, and never reaches page 3's listings at all.
  const second = pagedFetcher(pages);
  const two = await run(second.impl, 6);
  expect(indexCalls(second.calls)[0]).toContain('pg=3');
  expect(second.calls).toContain(detailUrl(all[8] ?? ''));
  expect(two.crawlRun.discoveredCount).toBe(4);
  // Reached the terminator, so the next run sweeps from the top again.
  expect(await getCrawlDiscoveryPage(db, hrGeSource.id)).toBeNull();
  const third = pagedFetcher(pages);
  await run(third.impl, 7);
  expect(indexCalls(third.calls)[0]).not.toContain('pg=');
});

it('a resumed walk cannot certify coverage or close the listings it skipped', async () => {
  const seeded = await run(pagedFetcher(pages).impl, 5);
  expect(seeded.crawlRun.status).toBe('completed');
  await setCrawlDiscoveryPage(db, hrGeSource.id, 3, '2026-09-05T12:00:00Z');

  // Page 3 alone is a healthy walk that reaches the terminator — but it is a
  // suffix, so pages 1-2's listings went unobserved and must not be closed.
  const resumed = await runHrGeCrawl(
    { db, httpFetcher: pagedFetcher(pages).impl, now: () => '2026-09-06T12:00:00Z' },
    { missingStreakThreshold: 2, skipSitemapCrossCheck: true },
  );
  expect(resumed.crawlRun.status).toBe('partial');
  expect(resumed.crawlRun.fullCoverage).toBe(false);
  expect(resumed.crawlRun.missingCount).toBe(0);
  const [skipped] = await db
    .select()
    .from(sourceListings)
    .where(
      and(
        eq(sourceListings.sourceId, hrGeSource.id),
        eq(sourceListings.sourceRecordId, all[0] ?? ''),
      ),
    );
  expect(skipped?.status).toBe('active');
  expect(skipped?.missingStreak).toBe(0);
});
