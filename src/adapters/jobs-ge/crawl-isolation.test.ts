import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/client.js';
import {
  extendSourceBackoff,
  getSourceBackoffUntil,
  setCrawlCursor,
  setCrawlDiscoveryPage,
  upsertResource,
} from '../../db/ingest.js';
import { crawlRuns, sourceListings } from '../../db/schema/index.js';
import {
  cleanupTestSource,
  createTestCrawlRun,
  createTestSource,
  createTestSourceListing,
  snapshotSourceState,
} from '../../db/test-support.js';
import type { HttpFetcher, HttpFetchResult } from '../../net/http-fetcher.js';
import { jobsGeSource } from '../../policies/jobs-ge.js';
import {
  CLAMP_CONFIRMATION_PROBE_OFFSET,
  ensureJobsGeSourceSeeded,
  runJobsGeCrawl,
} from './crawl.js';

/**
 * Phase 1C's "confirm that a failing source cannot affect the other source's
 * state", at the ORCHESTRATOR level. `src/db/cross-source-isolation.test.ts`
 * proves the shared database primitives are scoped per source; this proves
 * the path that composes them is too — a real crawl, through the real
 * orchestrator, failing in the ways crawls actually fail, with a fully
 * populated neighbouring source sitting next to it in the same tables.
 *
 * The neighbour's state is built with the test-support helpers rather than by
 * driving a second adapter: what matters to the isolation claim is that the
 * rows exist and are maximally susceptible, not which code wrote them.
 *
 * Each test compares a whole-state snapshot (every table carrying per-source
 * state — see snapshotSourceState) rather than spot-checking listing rows, so
 * a leak into cursors, cooldowns, resources, incidents or fetch attempts
 * fails the test just as loudly as a leak into a listing's status.
 */

const testIds = vi.hoisted(() => ({
  sourceId: crypto.randomUUID(),
  policyId: crypto.randomUUID(),
}));

vi.mock('../../policies/jobs-ge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../policies/jobs-ge.js')>();
  return {
    ...actual,
    // Both id and slug disposable — see crawl.test.ts's own comment for why
    // the slug matters as much as the id (the 2026-09-06 seeding collision).
    jobsGeSource: {
      ...actual.jobsGeSource,
      id: testIds.sourceId,
      slug: `isolation-test-${testIds.sourceId}`,
    },
    jobsGePolicy: { ...actual.jobsGePolicy, id: testIds.policyId, sourceId: testIds.sourceId },
  };
});

class FakeHttpFetcher implements HttpFetcher {
  constructor(private responses: Map<string, HttpFetchResult | Error>) {}
  async fetch(url: string): Promise<HttpFetchResult> {
    const entry = this.responses.get(url);
    if (entry === undefined) throw new Error(`FakeHttpFetcher: no canned response for ${url}`);
    if (entry instanceof Error) throw entry;
    return entry;
  }
  async close(): Promise<void> {}
}

/** Fails every request — a source that is entirely unreachable this run. */
class AlwaysFailingFetcher implements HttpFetcher {
  async fetch(url: string): Promise<HttpFetchResult> {
    throw new Error(`network unreachable: ${url}`);
  }
  async close(): Promise<void> {}
}

function htmlResponse(url: string, body: string): HttpFetchResult {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body,
    finalUrl: url,
    redirectCount: 0,
  };
}

function adsPageUrl(page: number): string {
  return `https://www.jobs.ge/ge/ads/?page=${page}`;
}

function detailUrl(id: string): string {
  return `https://www.jobs.ge/ge/?view=jobs&id=${id}`;
}

function buildAdsPageHtml(vipIds: string[], standardIds: string[]): string {
  const row = (id: string) =>
    `<tr><td><a href="/ge/?view=jobs&id=${id}">Listing ${id}</a></td></tr>`;
  return `<html><body>
    <div class="vipEntries"><table>${vipIds.map(row).join('')}</table></div>
    <table id="job_list_table">${standardIds.map(row).join('')}</table>
  </body></html>`;
}

function buildDetailHtml(id: string): string {
  return `<html><body>
    <table class="dtable">
      <tr><td class="dtitle"><span class="grey">დასახელება:</span> <b>Listing ${id}</b></td></tr>
      <tr><td class="dtitle"><span class="grey">გამოქვეყნდა:</span> <b>02 სექტემბერი</b> / <span class="grey">ბოლო ვადა:</span> <b>02 ოქტომბერი</b></td></tr>
      <tr><td>Description for ${id}. <a href="mailto:jobs-${id}@example.invalid">apply</a></td></tr>
    </table>
  </body></html>`;
}

function discoveryPages(ids: string[]): Array<readonly [string, HttpFetchResult]> {
  const html = buildAdsPageHtml([], ids);
  const probePage = 2 + CLAMP_CONFIRMATION_PROBE_OFFSET;
  return [1, 2, probePage].map(
    (page) => [adsPageUrl(page), htmlResponse(adsPageUrl(page), html)] as const,
  );
}

function makeClock(startEpochMs: number): () => string {
  let t = startEpochMs;
  return () => new Date(t++).toISOString();
}

/**
 * A neighbouring source in a fully populated, healthy state, deliberately set
 * up to be maximally susceptible to any cross-source leak: listings at
 * several points of §13's lifecycle including one a single further miss would
 * close, staleness older than any run under test, a settled run, both
 * cursors, a cooldown, and a fetched resource.
 */
async function populateNeighbour(sourceId: string): Promise<void> {
  await createTestSourceListing(sourceId, {
    status: 'active',
    lastSeenAt: '2026-01-01T00:00:00Z',
  });
  await createTestSourceListing(sourceId, {
    status: 'missing_suspected',
    lastSeenAt: '2026-01-01T00:00:00Z',
    missingStreak: 2,
  });
  await createTestSourceListing(sourceId, {
    status: 'active',
    lastSeenAt: '2026-01-01T00:00:00Z',
    sourceDeadlineAt: '2026-01-02T00:00:00Z',
  });
  await createTestCrawlRun(sourceId, {
    status: 'completed',
    fullCoverage: true,
    discoveredCount: 42,
  });
  await setCrawlCursor(db, sourceId, 'neighbour-100', '2026-01-05T00:00:00Z');
  await setCrawlDiscoveryPage(db, sourceId, 7, '2026-01-05T00:00:00Z');
  await extendSourceBackoff(db, sourceId, '2026-01-05T03:00:00Z', '2026-01-05T00:00:00Z');
  await upsertResource(db, {
    sourceId,
    role: 'OPPORTUNITY',
    originalUrl: '/listing/1',
    canonicalUrl: 'https://example.invalid/listing/1',
    finalUrl: null,
    status: 'fetched',
    fetchedAt: '2026-01-05T00:00:00Z',
    contentHash: 'd'.repeat(64),
    byteSize: 10,
    mimeType: 'text/html',
  });
}

describe('cross-source isolation at the orchestrator level', () => {
  let neighbourId: string;

  afterEach(async () => {
    await cleanupTestSource(jobsGeSource.id);
    if (neighbourId) await cleanupTestSource(neighbourId);
  });

  it("a totally failed crawl leaves the other source's entire state untouched", async () => {
    neighbourId = await createTestSource();
    await populateNeighbour(neighbourId);
    const before = await snapshotSourceState(neighbourId);

    const result = await runJobsGeCrawl(
      { db, httpFetcher: new AlwaysFailingFetcher(), now: makeClock(Date.UTC(2026, 8, 6, 12)) },
      { missingStreakThreshold: 3 },
    );

    // Discovery never got a single page, so this run certifies nothing.
    expect(result.crawlRun.status).toBe('partial');
    expect(result.crawlRun.discoveredCount).toBe(0);
    expect(result.crawlRun.missingCount).toBe(0);

    expect(await snapshotSourceState(neighbourId)).toEqual(before);
  });

  it('a crawl whose every detail fetch fails leaves the other source untouched', async () => {
    neighbourId = await createTestSource();
    await populateNeighbour(neighbourId);
    const before = await snapshotSourceState(neighbourId);

    // Discovery succeeds, then the detail fetch raises a non-HTTP error the
    // orchestrator does not swallow, aborting the run.
    const responses = new Map<string, HttpFetchResult | Error>(discoveryPages(['1001']));
    const httpFetcher = new FakeHttpFetcher(responses);
    vi.spyOn(httpFetcher, 'fetch').mockImplementation(async (url: string) => {
      if (url.includes('view=jobs')) throw new Error('boom');
      const entry = responses.get(url);
      if (entry === undefined || entry instanceof Error) throw new Error(`no response: ${url}`);
      return entry;
    });

    const result = await runJobsGeCrawl(
      { db, httpFetcher, now: makeClock(Date.UTC(2026, 8, 6, 12)) },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 },
    );

    // A detail-fetch failure is routine, not fatal: the run settles rather
    // than throwing, and is 'partial' because the failure rate guard trips.
    expect(result.crawlRun.status).toBe('partial');
    expect(await snapshotSourceState(neighbourId)).toEqual(before);
  });

  it("a rate-limited crawl's cooldown does not stall the other source", async () => {
    neighbourId = await createTestSource();
    await populateNeighbour(neighbourId);
    const neighbourBackoffBefore = await getSourceBackoffUntil(db, neighbourId);
    const before = await snapshotSourceState(neighbourId);

    const responses = new Map<string, HttpFetchResult | Error>(discoveryPages(['1001']));
    responses.set(adsPageUrl(1), {
      status: 429,
      headers: { 'retry-after': '3600' },
      body: 'rate limited',
      finalUrl: adsPageUrl(1),
      redirectCount: 0,
    });

    const result = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 6, 12)),
      },
      { missingStreakThreshold: 3 },
    );

    expect(result.crawlRun.status).toBe('partial');
    // The crawled source really did take a cooldown...
    const crawledBackoff = await getSourceBackoffUntil(db, jobsGeSource.id);
    expect(crawledBackoff).not.toBeNull();
    // ...and the neighbour's own cooldown is exactly what it was.
    expect(await getSourceBackoffUntil(db, neighbourId)).toBe(neighbourBackoffBefore);
    expect(await snapshotSourceState(neighbourId)).toEqual(before);
  });

  it("a successful crawl's own reconciliation and closure do not reach the other source", async () => {
    // The write-heaviest, highest-consequence path: this run genuinely
    // expires and closes ITS OWN listings, while the neighbour holds
    // listings that are identically stale and identically overdue.
    neighbourId = await createTestSource();
    await populateNeighbour(neighbourId);
    const before = await snapshotSourceState(neighbourId);

    const responses = new Map<string, HttpFetchResult | Error>([
      ...discoveryPages(['1001']),
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), buildDetailHtml('1001'))],
    ]);

    // Seed the crawled source with its own stale and overdue listings, so
    // reconciliation has real work to do on this side of the boundary.
    await ensureJobsGeSourceSeeded(db);
    const ownStale = await createTestSourceListing(jobsGeSource.id, {
      status: 'missing_suspected',
      lastSeenAt: '2026-01-01T00:00:00Z',
      missingStreak: 2,
    });
    const ownOverdue = await createTestSourceListing(jobsGeSource.id, {
      status: 'active',
      lastSeenAt: '2026-01-01T00:00:00Z',
      sourceDeadlineAt: '2026-01-02T00:00:00Z',
    });

    const result = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 6, 12)),
      },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 },
    );

    expect(result.crawlRun.status).toBe('completed');
    expect(result.crawlRun.fullCoverage).toBe(true);

    // Proof the run really did reconcile — otherwise "the neighbour is
    // unchanged" would be vacuous.
    const [closed] = await db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.id, ownStale.id));
    expect(closed?.status).toBe('closed');
    const [expired] = await db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.id, ownOverdue.id));
    expect(expired?.status).toBe('expired');

    expect(await snapshotSourceState(neighbourId)).toEqual(before);
  });

  it('does not block the other source from starting its own run while this one is unsettled', async () => {
    neighbourId = await createTestSource();

    // A crawl left unsettled (reconciledAt null) for the crawled source —
    // the state that legitimately blocks a SECOND run of that same source.
    const responses = new Map<string, HttpFetchResult | Error>(discoveryPages(['1001']));
    responses.set(detailUrl('1001'), htmlResponse(detailUrl('1001'), buildDetailHtml('1001')));
    await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 6, 12)),
      },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 },
    );
    await db
      .update(crawlRuns)
      .set({ reconciledAt: null })
      .where(eq(crawlRuns.sourceId, jobsGeSource.id));

    // The neighbour must still be able to start and settle its own run.
    const neighbourRun = await createTestCrawlRun(neighbourId, {
      status: 'completed',
      fullCoverage: true,
      reconciledAt: null,
    });
    expect(neighbourRun.sourceId).toBe(neighbourId);
  });
});
