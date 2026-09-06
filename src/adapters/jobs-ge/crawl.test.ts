import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/client.js';
import { getCrawlCursor } from '../../db/ingest.js';
import {
  crawlRuns,
  parserIncidents,
  sourceListingRevisions,
  sourceListings,
} from '../../db/schema/index.js';
import { cleanupTestSource, createTestSourceListing } from '../../db/test-support.js';
import type { HttpFetcher, HttpFetchResult } from '../../net/http-fetcher.js';
import { jobsGeSource } from '../../policies/jobs-ge.js';
import {
  CLAMP_CONFIRMATION_PROBE_OFFSET,
  ensureJobsGeSourceSeeded,
  runJobsGeCrawl,
} from './crawl.js';

// Isolates every DB write this test file makes under a disposable, random
// source id instead of the real jobsGeSource.id — without this,
// cleanupTestSource(jobsGeSource.id) in afterEach would delete every real
// jobs.ge listing/revision/crawl-run/policy row a shared dev database might
// already hold, as a side effect of merely running the test suite
// (adversarial review, 2026-09-05). Only the id fields are overridden —
// baseUrl and the rest of the policy stay real, so URL construction and
// isJobsGeUrlAllowed behave exactly as in production. vi.mock is hoisted
// above every import in this file (including the `jobsGeSource` import
// above and crawl.ts's own internal one), so every reference resolves to
// this same mocked module consistently.
// crypto.randomUUID() off the global (not a `node:crypto` import) —
// vi.hoisted's callback runs above even hoisted import bindings, so a
// regular import referenced here throws "Cannot access before
// initialization"; the Web Crypto global is available without an import on
// this project's Node version and sidesteps that ordering issue entirely.
const testIds = vi.hoisted(() => ({
  sourceId: crypto.randomUUID(),
  policyId: crypto.randomUUID(),
}));

vi.mock('../../policies/jobs-ge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../policies/jobs-ge.js')>();
  return {
    ...actual,
    jobsGeSource: { ...actual.jobsGeSource, id: testIds.sourceId },
    jobsGePolicy: { ...actual.jobsGePolicy, id: testIds.policyId, sourceId: testIds.sourceId },
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

/**
 * Canned responses for a "complete" discovery walk: page 1's real content,
 * page 2 identical to it (the candidate clamp signal), and a confirmation
 * probe at page 2 + CLAMP_CONFIRMATION_PROBE_OFFSET with the same content
 * again — discoverAllListings (crawl.ts) refuses to trust a single
 * repeated page on its own since round 3 of adversarial review, 2026-09-05.
 */
function discoveryPages(
  vipIds: string[],
  standardIds: string[],
): Array<readonly [string, HttpFetchResult]> {
  const html = buildAdsPageHtml(vipIds, standardIds);
  const probePage = 2 + CLAMP_CONFIRMATION_PROBE_OFFSET;
  return [1, 2, probePage].map(
    (page) => [adsPageUrl(page), htmlResponse(adsPageUrl(page), html)] as const,
  );
}

function buildDetailHtml(opts: {
  id: string;
  title: string;
  publishedRaw: string;
  deadlineRaw: string;
  applicationHtml: string;
}): string {
  return `<html><body>
    <table class="dtable">
      <tr><td class="dtitle"><span class="grey">დასახელება:</span> <b>${opts.title}</b></td></tr>
      <tr><td class="dtitle"><span class="grey">გამოქვეყნდა:</span> <b>${opts.publishedRaw}</b> / <span class="grey">ბოლო ვადა:</span> <b>${opts.deadlineRaw}</b></td></tr>
      <tr><td>Description for ${opts.id}. ${opts.applicationHtml}</td></tr>
    </table>
  </body></html>`;
}

function mailtoDetailHtml(id: string): string {
  return buildDetailHtml({
    id,
    title: `Listing ${id}`,
    publishedRaw: '02 სექტემბერი',
    deadlineRaw: '02 ოქტომბერი',
    applicationHtml: `<a href="mailto:jobs-${id}@example.invalid">apply</a>`,
  });
}

/** A fake clock that advances by 1ms per call — monotonic, deterministic, no real delay. */
function makeClock(startEpochMs: number): () => string {
  let t = startEpochMs;
  return () => new Date(t++).toISOString();
}

describe('runJobsGeCrawl', () => {
  afterEach(async () => {
    await cleanupTestSource(jobsGeSource.id);
  });

  it('stops after a discovery rate limit, including during a clamp-confirmation probe', async () => {
    const probePage = 2 + CLAMP_CONFIRMATION_PROBE_OFFSET;
    const responses = new Map<string, HttpFetchResult | Error>(discoveryPages([], ['1001']));
    responses.set(adsPageUrl(probePage), {
      ...htmlResponse(adsPageUrl(probePage), ''),
      status: 429,
      headers: { 'retry-after': '120' },
    });
    const httpFetcher = new FakeHttpFetcher(responses);
    const spy = vi.spyOn(httpFetcher, 'fetch');
    const result = await runJobsGeCrawl(
      { db, httpFetcher, now: () => '2026-09-05T12:00:00Z' },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 },
    );
    expect(result.crawlRun.status).toBe('partial');
    expect(result.crawlRun.missingCount).toBe(0);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('retains a rejected detail cursor, honors cooldown, and resumes after the reset', async () => {
    const ids = ['1001', '1002', '1003'];
    const responses = new Map<string, HttpFetchResult | Error>([
      ...discoveryPages([], ids),
      ...ids.map(
        (id) => [detailUrl(id), htmlResponse(detailUrl(id), mailtoDetailHtml(id))] as const,
      ),
    ]);
    const limited = new Map(responses);
    limited.set(detailUrl('1002'), {
      ...htmlResponse(detailUrl('1002'), ''),
      status: 429,
      headers: { 'retry-after': '120' },
    });
    const firstFetcher = new FakeHttpFetcher(limited);
    const firstSpy = vi.spyOn(firstFetcher, 'fetch');
    const options = { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 };
    const first = await runJobsGeCrawl(
      { db, httpFetcher: firstFetcher, now: () => '2026-09-05T12:00:00Z' },
      options,
    );
    expect(first.crawlRun.status).toBe('partial');
    expect(first.crawlRun.newCount).toBe(1);
    expect(firstSpy).not.toHaveBeenCalledWith(detailUrl('1003'));
    expect(await getCrawlCursor(db, jobsGeSource.id)).toBe('1002');
    const pausedFetcher = new FakeHttpFetcher(responses);
    const pausedSpy = vi.spyOn(pausedFetcher, 'fetch');
    await runJobsGeCrawl(
      { db, httpFetcher: pausedFetcher, now: () => '2026-09-05T12:01:00Z' },
      options,
    );
    expect(pausedSpy).not.toHaveBeenCalled();
    const resumedFetcher = new FakeHttpFetcher(responses);
    const resumedSpy = vi.spyOn(resumedFetcher, 'fetch');
    const resumed = await runJobsGeCrawl(
      { db, httpFetcher: resumedFetcher, now: () => '2026-09-05T13:00:00Z' },
      options,
    );
    expect(resumed.crawlRun.status).toBe('completed');
    expect(resumedSpy.mock.calls.filter(([url]) => url.includes('view=jobs'))[0]?.[0]).toBe(
      detailUrl('1002'),
    );
    expect(await getCrawlCursor(db, jobsGeSource.id)).toBeNull();
  });

  it('uses a disposable test source id, never the real jobsGeSource.id constant', () => {
    // Guards the mock itself: if this ever silently stopped applying,
    // every afterEach's cleanupTestSource(jobsGeSource.id) call above would
    // start deleting real jobs.ge data instead of test fixtures.
    expect(jobsGeSource.id).not.toBe('8c3b7cbf-159a-4e13-9d9f-1b50597e4ae9');
  });

  it('discovers, fetches, and writes new listings on a first, complete run', async () => {
    const ids = ['1001', '1002', '1003'];
    const vipIds = ['2001'];
    const responses = new Map<string, HttpFetchResult | Error>([
      ...discoveryPages(vipIds, ids),
      ...[...ids, ...vipIds].map(
        (id) => [detailUrl(id), htmlResponse(detailUrl(id), mailtoDetailHtml(id))] as const,
      ),
    ]);
    const httpFetcher = new FakeHttpFetcher(responses);

    const result = await runJobsGeCrawl(
      { db, httpFetcher, now: makeClock(Date.UTC(2026, 8, 4, 12, 0, 0)) },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 3 },
    );

    expect(result.crawlRun.status).toBe('completed');
    expect(result.crawlRun.fullCoverage).toBe(true);
    expect(result.crawlRun.discoveredCount).toBe(4);
    expect(result.crawlRun.newCount).toBe(4);
    expect(result.crawlRun.changedCount).toBe(0);
    expect(result.crawlRun.unchangedCount).toBe(0);
    expect(result.crawlRun.failedCount).toBe(0);
    expect(result.crawlRun.missingCount).toBe(0);
    expect(result.crawlRun.reopenedCount).toBe(0);
    expect(result.crawlRun.reconciledAt).not.toBeNull(); // the exclusivity lock is released only once reconciliation has actually committed

    const listingsRows = await db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.sourceId, jobsGeSource.id));
    expect(listingsRows).toHaveLength(4);
    for (const listing of listingsRows) {
      expect(listing.status).toBe('active');
      expect(listing.currentRevisionId).not.toBeNull();
    }
  });

  it('reruns idempotently: an unchanged second run reports unchanged, not new, and creates no duplicate revisions', async () => {
    const ids = ['1001', '1002'];
    const responses = new Map<string, HttpFetchResult | Error>([
      ...discoveryPages([], ids),
      ...ids.map(
        (id) => [detailUrl(id), htmlResponse(detailUrl(id), mailtoDetailHtml(id))] as const,
      ),
    ]);
    const httpFetcher = new FakeHttpFetcher(responses);
    const clock = makeClock(Date.UTC(2026, 8, 4, 12, 0, 0));
    const options = { missingStreakThreshold: 3, minExpectedDiscoveredListings: 2 };

    const first = await runJobsGeCrawl({ db, httpFetcher, now: clock }, options);
    expect(first.crawlRun.newCount).toBe(2);

    const second = await runJobsGeCrawl({ db, httpFetcher, now: clock }, options);
    expect(second.crawlRun.status).toBe('completed');
    expect(second.crawlRun.newCount).toBe(0);
    expect(second.crawlRun.unchangedCount).toBe(2);
    expect(second.crawlRun.missingCount).toBe(0);

    // Scoped to this test's own listings — an unfiltered query would also
    // count revisions any other test file's data happens to hold at the
    // same moment, since they all share one database.
    const listingsRows = await db
      .select({ id: sourceListings.id })
      .from(sourceListings)
      .where(eq(sourceListings.sourceId, jobsGeSource.id));
    const revisions = await db
      .select()
      .from(sourceListingRevisions)
      .where(
        inArray(
          sourceListingRevisions.sourceListingId,
          listingsRows.map((row) => row.id),
        ),
      );
    expect(revisions).toHaveLength(2); // still one revision per listing, not duplicated
  });

  it('marks a listing missing_suspected once it disappears from discovery on a later complete run', async () => {
    const responsesRun1 = new Map<string, HttpFetchResult | Error>([
      ...discoveryPages([], ['1001', '1002']),
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), mailtoDetailHtml('1001'))],
      [detailUrl('1002'), htmlResponse(detailUrl('1002'), mailtoDetailHtml('1002'))],
    ]);
    const clock = makeClock(Date.UTC(2026, 8, 4, 12, 0, 0));
    const options = { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 };

    await runJobsGeCrawl(
      { db, httpFetcher: new FakeHttpFetcher(responsesRun1), now: clock },
      options,
    );

    // Second run: 1002 no longer appears in discovery at all.
    const responsesRun2 = new Map<string, HttpFetchResult | Error>([
      ...discoveryPages([], ['1001']),
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), mailtoDetailHtml('1001'))],
    ]);
    const second = await runJobsGeCrawl(
      { db, httpFetcher: new FakeHttpFetcher(responsesRun2), now: clock },
      options,
    );

    expect(second.crawlRun.status).toBe('completed');
    expect(second.crawlRun.discoveredCount).toBe(1);
    expect(second.crawlRun.missingCount).toBe(1);

    const [stillActive] = await db
      .select()
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.sourceId, jobsGeSource.id),
          eq(sourceListings.sourceRecordId, '1001'),
        ),
      );
    expect(stillActive?.status).toBe('active');

    const [nowMissing] = await db
      .select()
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.sourceId, jobsGeSource.id),
          eq(sourceListings.sourceRecordId, '1002'),
        ),
      );
    expect(nowMissing?.status).toBe('missing_suspected');
    expect(nowMissing?.missingStreak).toBe(1);
  });

  it('records a failed detail fetch as failedCount without blocking other listings', async () => {
    const responses = new Map<string, HttpFetchResult | Error>([
      ...discoveryPages([], ['1001', '1002']),
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), mailtoDetailHtml('1001'))],
      [detailUrl('1002'), new Error('simulated network failure')],
    ]);

    const result = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 4, 12, 0, 0)),
      },
      // maxFetchFailureRate raised: this test is about failedCount
      // bookkeeping for one listing (a 50% rate here, out of just 2
      // discovered — technically passes the default 50% ceiling too, but
      // pinning it explicitly keeps this test isolated from that guard's
      // own behavior, which the dedicated "marks the run partial..." test covers.
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1, maxFetchFailureRate: 1 },
    );

    expect(result.crawlRun.status).toBe('completed');
    expect(result.crawlRun.discoveredCount).toBe(2);
    expect(result.crawlRun.newCount).toBe(1);
    expect(result.crawlRun.failedCount).toBe(1);

    const listingsRows = await db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.sourceId, jobsGeSource.id));
    expect(listingsRows).toHaveLength(2); // 1001 has a revision; 1002 exists as a bare "discovered" touch
    const touched = listingsRows.find((l) => l.sourceRecordId === '1002');
    expect(touched?.status).toBe('discovered');
    expect(touched?.currentRevisionId).toBeNull();
  });

  it('quarantines (not failedCount) a listing whose detail page fetched fine but failed to parse, and records a typed incident', async () => {
    const responses = new Map<string, HttpFetchResult | Error>([
      ...discoveryPages([], ['1001', '1002']),
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), mailtoDetailHtml('1001'))],
      // Real HTTP 200 response, but not the expected .dtable template at all.
      [
        detailUrl('1002'),
        htmlResponse(detailUrl('1002'), '<html><body>unexpected markup</body></html>'),
      ],
    ]);

    const result = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 4, 12, 0, 0)),
      },
      // maxQuarantineRate raised: this test is about quarantine bookkeeping
      // for one listing (a 50% rate here, out of just 2 discovered), not
      // about the rate-gating behavior itself — see the dedicated
      // "marks the run partial when most discovered listings quarantine" test.
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1, maxQuarantineRate: 1 },
    );

    expect(result.crawlRun.status).toBe('completed');
    expect(result.crawlRun.newCount).toBe(1);
    expect(result.crawlRun.failedCount).toBe(0); // this is a parse failure, not a fetch failure
    expect(result.crawlRun.quarantinedCount).toBe(1);

    const [quarantined] = await db
      .select()
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.sourceId, jobsGeSource.id),
          eq(sourceListings.sourceRecordId, '1002'),
        ),
      );
    expect(quarantined?.status).toBe('quarantined');

    const incidents = await db
      .select()
      .from(parserIncidents)
      .where(eq(parserIncidents.sourceId, jobsGeSource.id));
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.kind).toBe('field_missing');
    expect(incidents[0]?.severity).toBe('warning');
    expect(incidents[0]?.resolved).toBe(false);
    expect(incidents[0]?.crawlRunId).toBe(result.crawlRun.id);
  });

  it('reactivates a quarantined listing once a later run successfully re-parses it', async () => {
    // Adversarial review, 2026-09-05, round 8: quarantine used to be a
    // one-way trapdoor (no reactivation path existed at all), so a single
    // transient bad response would permanently remove an otherwise-healthy
    // listing even though every later run parsed it fine.
    const clock = makeClock(Date.UTC(2026, 8, 4, 12, 0, 0));
    const options = {
      missingStreakThreshold: 3,
      minExpectedDiscoveredListings: 1,
      maxQuarantineRate: 1,
    };

    const first = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(
          new Map<string, HttpFetchResult | Error>([
            ...discoveryPages([], ['1001']),
            [
              detailUrl('1001'),
              htmlResponse(detailUrl('1001'), '<html><body>unexpected markup</body></html>'),
            ],
          ]),
        ),
        now: clock,
      },
      options,
    );
    expect(first.crawlRun.quarantinedCount).toBe(1);
    const [quarantined] = await db
      .select()
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.sourceId, jobsGeSource.id),
          eq(sourceListings.sourceRecordId, '1001'),
        ),
      );
    expect(quarantined?.status).toBe('quarantined');

    // Run 2: the site serves the ordinary template again — the parser
    // failure was transient, not a genuine template break.
    const second = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(
          new Map<string, HttpFetchResult | Error>([
            ...discoveryPages([], ['1001']),
            [detailUrl('1001'), htmlResponse(detailUrl('1001'), mailtoDetailHtml('1001'))],
          ]),
        ),
        now: clock,
      },
      options,
    );

    expect(second.crawlRun.status).toBe('completed');
    expect(second.crawlRun.reopenedCount).toBe(1);
    expect(second.crawlRun.quarantinedCount).toBe(0);

    const [recovered] = await db
      .select()
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.sourceId, jobsGeSource.id),
          eq(sourceListings.sourceRecordId, '1001'),
        ),
      );
    expect(recovered?.status).toBe('active');
    expect(recovered?.currentRevisionId).not.toBeNull();
  });

  it('quarantines listings (does not silently promote a degraded revision) when detail pages drift to a structurally different template', async () => {
    // Adversarial review, 2026-09-05, round 9: a site template change that
    // preserves the title row but drops everything else used to parse
    // "successfully" (a new hash, since the raw HTML really did change) and
    // get promoted to currentRevisionId with degraded data — invisible to
    // every other run-health guard since nothing threw. detail.ts's new
    // structural-drift checks (missing description cell; neither
    // organization nor published row) now catch this via the same
    // quarantine path round 2/3/8 already exercise.
    const clock = makeClock(Date.UTC(2026, 8, 4, 12, 0, 0));
    // Deliberately the DEFAULT maxQuarantineRate on run 2 (not raised, unlike
    // other quarantine-bookkeeping tests here) — this test's whole point is
    // proving the guard actually trips on a single-listing 100% quarantine.
    const options = { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 };

    await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(
          new Map<string, HttpFetchResult | Error>([
            ...discoveryPages([], ['1001']),
            [detailUrl('1001'), htmlResponse(detailUrl('1001'), mailtoDetailHtml('1001'))],
          ]),
        ),
        now: clock,
      },
      options,
    );
    const [afterFirst] = await db
      .select()
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.sourceId, jobsGeSource.id),
          eq(sourceListings.sourceRecordId, '1001'),
        ),
      );
    expect(afterFirst?.status).toBe('active');
    const revisionIdAfterFirst = afterFirst?.currentRevisionId;
    expect(revisionIdAfterFirst).not.toBeNull();

    // Run 2: title row survives, everything else the template relied on
    // (organization/published rows, the description cell) is gone.
    const driftedHtml = `<html><body>
      <table class="dtable">
        <tr><td class="dtitle"><span class="grey">დასახელება:</span> <b>Listing 1001</b></td></tr>
      </table>
    </body></html>`;
    const second = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(
          new Map<string, HttpFetchResult | Error>([
            ...discoveryPages([], ['1001']),
            [detailUrl('1001'), htmlResponse(detailUrl('1001'), driftedHtml)],
          ]),
        ),
        now: clock,
      },
      options,
    );

    expect(second.crawlRun.status).toBe('partial');
    expect(second.crawlRun.quarantinedCount).toBe(1);
    expect(second.crawlRun.missingCount).toBe(0); // reconciliation must not have run at all

    const [afterSecond] = await db
      .select()
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.sourceId, jobsGeSource.id),
          eq(sourceListings.sourceRecordId, '1001'),
        ),
      );
    expect(afterSecond?.status).toBe('quarantined');
    // Last-known-good content preserved (concept §6.2) — the degraded
    // parse never got promoted to currentRevisionId.
    expect(afterSecond?.currentRevisionId).toBe(revisionIdAfterFirst);
  });

  it('does not mark a listing missing when its detail fetch fails but it is still present in discovery', async () => {
    const clock = makeClock(Date.UTC(2026, 8, 4, 12, 0, 0));
    // maxFetchFailureRate raised: run 2 is 1 discovered / 1 failed = 100%,
    // which would otherwise trip the new fetch-failure-rate guard — this
    // test's subject is touchSourceListingSeen protecting the listing, not
    // that guard's own behavior (see the dedicated "marks the run
    // partial..." test for that).
    const options = {
      missingStreakThreshold: 3,
      minExpectedDiscoveredListings: 1,
      maxFetchFailureRate: 1,
    };

    // Run 1: fully successful, establishes the listing with a real revision.
    await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(
          new Map<string, HttpFetchResult | Error>([
            ...discoveryPages([], ['1001']),
            [detailUrl('1001'), htmlResponse(detailUrl('1001'), mailtoDetailHtml('1001'))],
          ]),
        ),
        now: clock,
      },
      options,
    );

    // Run 2: still discovered, but its detail fetch fails this time.
    const second = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(
          new Map<string, HttpFetchResult | Error>([
            ...discoveryPages([], ['1001']),
            [detailUrl('1001'), new Error('simulated transient failure')],
          ]),
        ),
        now: clock,
      },
      options,
    );

    expect(second.crawlRun.status).toBe('completed');
    expect(second.crawlRun.failedCount).toBe(1);
    expect(second.crawlRun.missingCount).toBe(0); // must NOT count as missing — it's still in discovery

    const [listing] = await db
      .select()
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.sourceId, jobsGeSource.id),
          eq(sourceListings.sourceRecordId, '1001'),
        ),
      );
    expect(listing?.status).toBe('active');
    expect(listing?.missingStreak).toBe(0);
  });

  it('reopens a closed listing that reappears in discovery with a confirmed fresh fetch', async () => {
    await ensureJobsGeSourceSeeded(db);
    const closed = await createTestSourceListing(jobsGeSource.id, {
      sourceRecordId: '1001',
      canonicalSourceUrl: detailUrl('1001'),
      status: 'closed',
      missingStreak: 3,
      lastSeenAt: '2026-08-01T00:00:00Z',
    });

    const responses = new Map<string, HttpFetchResult | Error>([
      ...discoveryPages([], ['1001']),
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), mailtoDetailHtml('1001'))],
    ]);

    const result = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 5, 12, 0, 0)),
      },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 },
    );

    expect(result.crawlRun.status).toBe('completed');
    expect(result.crawlRun.reopenedCount).toBe(1);

    const [reopened] = await db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.id, closed.id));
    expect(reopened?.status).toBe('active');
    expect(reopened?.missingStreak).toBe(0);
    expect(reopened?.currentRevisionId).not.toBeNull();
  });

  it('marks the run partial (and skips reconciliation) when a discovery page fetch fails', async () => {
    // Pre-seed a listing from an earlier, unrelated successful run — a
    // partial run must never touch it, since it lacks full visibility.
    // ensureJobsGeSourceSeeded first, since the sources row this listing's
    // FK needs is normally only created inside runJobsGeCrawl itself.
    await ensureJobsGeSourceSeeded(db);
    const preexisting = await createTestSourceListing(jobsGeSource.id, {
      sourceRecordId: '9999',
      status: 'active',
      missingStreak: 0,
      lastSeenAt: '2026-08-01T00:00:00Z',
    });

    const responses = new Map<string, HttpFetchResult | Error>([
      [adsPageUrl(1), htmlResponse(adsPageUrl(1), buildAdsPageHtml([], ['1001', '1002']))],
      [adsPageUrl(2), new Error('simulated network failure on page 2')],
    ]);

    const result = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 4, 12, 0, 0)),
      },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 },
    );

    expect(result.crawlRun.status).toBe('partial');
    expect(result.crawlRun.fullCoverage).toBe(true); // scope was still "attempt full coverage" — it just didn't succeed
    expect(result.crawlRun.missingCount).toBe(0);

    const [untouched] = await db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.id, preexisting.id));
    expect(untouched?.status).toBe('active');
    expect(untouched?.missingStreak).toBe(0);
  });

  it('marks the run partial when a mid-corpus page is empty, even though earlier pages already passed the expected-listings floor', async () => {
    // Page 1: a real, floor-passing page. Page 2: HTTP 200 but structurally
    // empty (a WAF challenge/error template, say) — NOT a fetch error, and
    // NOT identical to page 1 (empty != page 1's 5 listings), so it must
    // not be mistaken for the genuine "clamped to last page" stop signal.
    // No canned response exists for page 3, so the walk halts there via an
    // ordinary fetch failure rather than running to MAX_DISCOVERY_PAGES.
    const ids = ['1001', '1002', '1003', '1004', '1005'];
    const responses = new Map<string, HttpFetchResult | Error>([
      [adsPageUrl(1), htmlResponse(adsPageUrl(1), buildAdsPageHtml([], ids))],
      [adsPageUrl(2), htmlResponse(adsPageUrl(2), buildAdsPageHtml([], []))],
      ...ids.map(
        (id) => [detailUrl(id), htmlResponse(detailUrl(id), mailtoDetailHtml(id))] as const,
      ),
    ]);

    const result = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 4, 12, 0, 0)),
      },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 3 },
    );

    expect(result.crawlRun.discoveredCount).toBe(5); // only page 1's listings — page 2 contributed nothing
    expect(result.crawlRun.status).toBe('partial'); // must NOT be 'completed' despite passing the floor
  });

  it('marks the run partial when discovery finds fewer listings than the expected floor, even with a natural stop', async () => {
    // discoveryPages gives this a genuinely CONFIRMED clamp (complete: true)
    // so the floor is what's actually being isolated and tested here, not
    // an unconfirmed candidate that would also leave complete: false.
    const responses = new Map<string, HttpFetchResult | Error>([
      ...discoveryPages([], ['1001']),
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), mailtoDetailHtml('1001'))],
    ]);

    // No minExpectedDiscoveredListings override — uses the real default (100).
    const result = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 4, 12, 0, 0)),
      },
      { missingStreakThreshold: 3 },
    );

    expect(result.crawlRun.discoveredCount).toBe(1);
    expect(result.crawlRun.status).toBe('partial');
  });

  it('does not trust a repeated page as the real clamp unless a distant confirmation probe also matches', async () => {
    // Page 2 happens to repeat page 1's content (e.g. a transient cache/proxy
    // glitch), which alone satisfies the candidate-stop check — but the
    // confirmation probe (page 2 + CLAMP_CONFIRMATION_PROBE_OFFSET) returns
    // genuinely different, further-along content, refuting it. No canned
    // response exists beyond that, so the walk halts via an ordinary fetch
    // failure rather than reaching MAX_DISCOVERY_PAGES.
    const page1Html = buildAdsPageHtml([], ['1001', '1002']);
    const probePage = 2 + CLAMP_CONFIRMATION_PROBE_OFFSET;
    const responses = new Map<string, HttpFetchResult | Error>([
      [adsPageUrl(1), htmlResponse(adsPageUrl(1), page1Html)],
      [adsPageUrl(2), htmlResponse(adsPageUrl(2), page1Html)], // coincidental repeat
      [adsPageUrl(probePage), htmlResponse(adsPageUrl(probePage), buildAdsPageHtml([], ['9001']))], // genuinely different
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), mailtoDetailHtml('1001'))],
      [detailUrl('1002'), htmlResponse(detailUrl('1002'), mailtoDetailHtml('1002'))],
    ]);

    const result = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 4, 12, 0, 0)),
      },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 },
    );

    expect(result.crawlRun.status).toBe('partial');
  });

  it('marks the run partial when most discovered listings quarantine on parse, even though discovery itself completed', async () => {
    // A site-wide detail-template break: discovery succeeds fine (a
    // separate parser from the detail page), but every detail page fails
    // to parse — evidence this run's results aren't trustworthy enough to
    // drive closure, distinct from DEFAULT_MIN_EXPECTED_DISCOVERED_LISTINGS
    // (which only covers discovery-page health).
    const ids = ['1001', '1002', '1003', '1004'];
    const responses = new Map<string, HttpFetchResult | Error>([
      ...discoveryPages([], ids),
      ...ids.map(
        (id) =>
          [
            detailUrl(id),
            htmlResponse(detailUrl(id), '<html><body>broken template</body></html>'),
          ] as const,
      ),
    ]);

    const result = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 4, 12, 0, 0)),
      },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1, maxQuarantineRate: 0.1 },
    );

    expect(result.crawlRun.discoveredCount).toBe(4);
    expect(result.crawlRun.quarantinedCount).toBe(4);
    expect(result.crawlRun.status).toBe('partial'); // must NOT be 'completed' despite discovery succeeding
    expect(result.crawlRun.missingCount).toBe(0); // reconciliation must not have run at all
  });

  it('marks the run partial when every detail fetch fails, even though discovery itself completed', async () => {
    // Distinct from the quarantine-rate guard above: a systemic FETCH
    // failure (a ban/WAF/policy-block, or the site returning non-200s for
    // every detail request) never reaches the parser at all, so
    // quarantinedCount/quarantineRate stay 0 — without its own guard this
    // would sail through as 'completed' despite acquiring zero real content
    // this run (adversarial review, 2026-09-05, round 9).
    const ids = ['1001', '1002', '1003', '1004'];
    const responses = new Map<string, HttpFetchResult | Error>([
      ...discoveryPages([], ids),
      ...ids.map((id) => [detailUrl(id), new Error('simulated systemic fetch failure')] as const),
    ]);
    // A pre-existing, genuinely-absent listing — proves reconciliation
    // never ran off this unreliable run's results. ensureJobsGeSourceSeeded
    // first, since the sources row this listing's FK needs is normally only
    // created inside runJobsGeCrawl itself.
    await ensureJobsGeSourceSeeded(db);
    const preExisting = await createTestSourceListing(jobsGeSource.id, {
      sourceRecordId: '9999',
      status: 'active',
      missingStreak: 0,
      lastSeenAt: '2026-01-01T00:00:00Z',
    });

    const result = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(responses),
        now: makeClock(Date.UTC(2026, 8, 4, 12, 0, 0)),
      },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 },
    );

    expect(result.crawlRun.discoveredCount).toBe(4);
    expect(result.crawlRun.failedCount).toBe(4);
    expect(result.crawlRun.quarantinedCount).toBe(0);
    expect(result.crawlRun.status).toBe('partial'); // must NOT be 'completed' despite discovery succeeding
    expect(result.crawlRun.missingCount).toBe(0); // reconciliation must not have run at all

    const [stillActive] = await db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.id, preExisting.id));
    expect(stillActive?.status).toBe('active');
    expect(stillActive?.missingStreak).toBe(0);
  });

  it('does not certify a truncated run just because no completed run exists yet, when an earlier partial run already saw a bigger corpus', async () => {
    // Adversarial review, 2026-09-05, round 10: getLastCompletedCrawlRun
    // returning null means "no run has ever earned 'completed' status," NOT
    // "no history exists" — a prior 'partial' run (discovery succeeded fully
    // but something else made it partial) still persists a real
    // discoveredCount. Without a fallback baseline, a severely truncated
    // crawl (a pagination/caching fault serving one small page everywhere)
    // could certify itself as this source's first 'completed' run and
    // become the baseline for every later comparison — exactly the mass
    // mis-closure the relative-collapse guard (round 4, below) exists to
    // prevent, just reached through the "no baseline yet" escape hatch
    // instead of around it.
    const clock = makeClock(Date.UTC(2026, 8, 4, 12, 0, 0));
    const bigIds = Array.from({ length: 10 }, (_, i) => `100${i}`);
    const first = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(
          new Map<string, HttpFetchResult | Error>([
            [adsPageUrl(1), htmlResponse(adsPageUrl(1), buildAdsPageHtml([], bigIds))],
            [adsPageUrl(2), new Error('simulated network failure on page 2')],
            ...bigIds.map(
              (id) => [detailUrl(id), htmlResponse(detailUrl(id), mailtoDetailHtml(id))] as const,
            ),
          ]),
        ),
        now: clock,
      },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 },
    );
    expect(first.crawlRun.status).toBe('partial'); // no completed baseline exists yet
    expect(first.crawlRun.discoveredCount).toBe(10);

    // Second run: only 2 listings, but genuinely confirmed (page 1, page 2,
    // and the distant probe all agree) — not an unconfirmed fluke. Without
    // this fix, lastCompletedRun would still be null here (run 1 never
    // completed), so baselineOk would trivially pass.
    const collapsedIds = ['2001', '2002'];
    const second = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(
          new Map<string, HttpFetchResult | Error>([
            ...discoveryPages([], collapsedIds),
            ...collapsedIds.map(
              (id) => [detailUrl(id), htmlResponse(detailUrl(id), mailtoDetailHtml(id))] as const,
            ),
          ]),
        ),
        now: clock,
      },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1, maxQuarantineRate: 1 },
    );

    expect(second.crawlRun.discoveredCount).toBe(2);
    expect(second.crawlRun.status).toBe('partial'); // 2 < 10 * 0.5 — must not be 'completed'
    expect(second.crawlRun.missingCount).toBe(0); // reconciliation must not have run at all

    const run1Listings = await db
      .select()
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.sourceId, jobsGeSource.id),
          inArray(sourceListings.sourceRecordId, bigIds),
        ),
      );
    expect(run1Listings).toHaveLength(10);
    for (const listing of run1Listings) {
      expect(listing.status).toBe('active');
      expect(listing.missingStreak).toBe(0);
    }
  });

  it('marks the run partial on a relative count collapse vs. the last completed run, even though complete/floor/quarantine all pass', async () => {
    // Simulates a systemic pagination/caching regression that consistently
    // serves the SAME small subset at every page number queried, including
    // the confirmation probe — complete: true, the fixed floor, and the
    // quarantine rate would all pass this on their own. Only comparing
    // against this source's own history (its prior completed run's
    // discoveredCount) catches it.
    const bigIds = Array.from({ length: 10 }, (_, i) => `100${i}`);
    const first = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(
          new Map<string, HttpFetchResult | Error>([
            ...discoveryPages([], bigIds),
            ...bigIds.map(
              (id) => [detailUrl(id), htmlResponse(detailUrl(id), mailtoDetailHtml(id))] as const,
            ),
          ]),
        ),
        now: makeClock(Date.UTC(2026, 8, 4, 12, 0, 0)),
      },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 },
    );
    expect(first.crawlRun.status).toBe('completed');
    expect(first.crawlRun.discoveredCount).toBe(10);

    // Second run: only 2 listings, but genuinely confirmed (page 1, page 2,
    // and the distant probe all agree) — not an unconfirmed fluke.
    const collapsedIds = ['2001', '2002'];
    const second = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(
          new Map<string, HttpFetchResult | Error>([
            ...discoveryPages([], collapsedIds),
            ...collapsedIds.map(
              (id) => [detailUrl(id), htmlResponse(detailUrl(id), mailtoDetailHtml(id))] as const,
            ),
          ]),
        ),
        now: makeClock(Date.UTC(2026, 8, 5, 12, 0, 0)),
      },
      // Floor and quarantine rate deliberately permissive, so only the
      // relative-collapse guard is what's being isolated here.
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1, maxQuarantineRate: 1 },
    );

    expect(second.crawlRun.discoveredCount).toBe(2);
    expect(second.crawlRun.status).toBe('partial'); // 2 < 10 * 0.5 — must not be 'completed'
    expect(second.crawlRun.missingCount).toBe(0); // reconciliation must not have run at all
  });

  it('marks the run partial when VIP entirely disappears vs. a run that previously had it, even though the combined total barely moves', async () => {
    // A ~10-row VIP wipeout inside a otherwise-healthy, larger standard
    // section barely changes the combined total, so neither the fixed
    // floor nor the relative-collapse ratio (both computed on the combined
    // discoveredCount) would ever catch it on their own.
    const standardIds = Array.from({ length: 20 }, (_, i) => `100${i}`);
    const first = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(
          new Map<string, HttpFetchResult | Error>([
            ...discoveryPages(['2001'], standardIds),
            [detailUrl('2001'), htmlResponse(detailUrl('2001'), mailtoDetailHtml('2001'))],
            ...standardIds.map(
              (id) => [detailUrl(id), htmlResponse(detailUrl(id), mailtoDetailHtml(id))] as const,
            ),
          ]),
        ),
        now: makeClock(Date.UTC(2026, 8, 4, 12, 0, 0)),
      },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 },
    );
    expect(first.crawlRun.status).toBe('completed');
    expect(first.crawlRun.vipCount).toBe(1);
    expect(first.crawlRun.standardCount).toBe(20);

    // Second run: standard section unchanged, but VIP is now empty — as if
    // the .vipEntries selector silently stopped matching.
    const second = await runJobsGeCrawl(
      {
        db,
        httpFetcher: new FakeHttpFetcher(
          new Map<string, HttpFetchResult | Error>([
            ...discoveryPages([], standardIds),
            ...standardIds.map(
              (id) => [detailUrl(id), htmlResponse(detailUrl(id), mailtoDetailHtml(id))] as const,
            ),
          ]),
        ),
        now: makeClock(Date.UTC(2026, 8, 5, 12, 0, 0)),
      },
      { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 },
    );

    expect(second.crawlRun.vipCount).toBe(0);
    expect(second.crawlRun.discoveredCount).toBe(20); // combined total barely moved (21 -> 20)
    expect(second.crawlRun.status).toBe('partial'); // must NOT be 'completed' — VIP silently vanished
    expect(second.crawlRun.missingCount).toBe(0); // reconciliation must not have run at all
  });

  it('marks the run failed (not stuck running) when an unexpected DB error occurs mid-run', async () => {
    // Per-listing fetch/parse failures are deliberately swallowed inline
    // (see the failedCount test above) and never reach the outer
    // try/catch, so exercising it needs a failure from the write path
    // itself — writeSourceListingRevision's db.transaction() call — rather
    // than from the fake HTTP fetcher. insert/select/update are bound
    // directly to the real db (not proxied) so seeding, startCrawlRun,
    // upsertResource, and recordFetchAttempt all still hit the real
    // database normally — a real, running crawl_runs row exists by the
    // time this fails. Explicit bound methods rather than a Proxy over
    // `db`, to avoid `this`-binding hazards a Proxy could introduce against
    // Drizzle's internal implementation.
    const transactionFailingDb = {
      insert: db.insert.bind(db),
      select: db.select.bind(db),
      update: db.update.bind(db),
      transaction: () => {
        throw new Error('simulated database outage');
      },
    } as unknown as typeof db;

    const responses = new Map<string, HttpFetchResult | Error>([
      [adsPageUrl(1), htmlResponse(adsPageUrl(1), buildAdsPageHtml([], ['1001']))],
      [adsPageUrl(2), htmlResponse(adsPageUrl(2), buildAdsPageHtml([], ['1001']))],
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), mailtoDetailHtml('1001'))],
    ]);

    await expect(
      runJobsGeCrawl(
        {
          db: transactionFailingDb,
          httpFetcher: new FakeHttpFetcher(responses),
          now: makeClock(Date.UTC(2026, 8, 4, 12, 0, 0)),
        },
        { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 },
      ),
    ).rejects.toThrow('simulated database outage');

    const [run] = await db.select().from(crawlRuns).where(eq(crawlRuns.sourceId, jobsGeSource.id));
    expect(run?.status).toBe('failed');
    expect(run?.finishedAt).not.toBeNull();
  });

  it('does not leave listings closed/expired while the run itself stays unsettled, when settlement fails', async () => {
    // Proves settlement (terminal status -> expire -> close -> final
    // status+reconciledAt) is atomic (adversarial review, 2026-09-05, round
    // 9): before this fix these were separate autocommitted steps, so a
    // crash between them could leave listings closed/expired while the run
    // itself stayed unsettled (reconciledAt still null), or let the catch
    // block relabel an already-reconciled run 'failed' with stale counts.
    // Counting db.transaction() calls and failing the SECOND one (call 1 is
    // writeSourceListingRevision for this run's one listing; call 2 is the
    // settlement transaction) simulates a total settlement failure and
    // proves nothing it would have written persisted.
    await ensureJobsGeSourceSeeded(db);
    const expiredCandidate = await createTestSourceListing(jobsGeSource.id, {
      sourceRecordId: '8001',
      status: 'active',
      missingStreak: 0,
      lastSeenAt: '2026-09-04T12:00:00Z',
      sourceDeadlineAt: '2026-01-01T00:00:00Z', // already past
    });
    const missingCandidate = await createTestSourceListing(jobsGeSource.id, {
      sourceRecordId: '8002',
      status: 'active',
      missingStreak: 0,
      lastSeenAt: '2026-01-01T00:00:00Z', // old enough, and absent from this run's discovery
    });

    let transactionCalls = 0;
    const settlementFailingDb = {
      insert: db.insert.bind(db),
      select: db.select.bind(db),
      update: db.update.bind(db),
      // biome-ignore lint/suspicious/noExplicitAny: matches drizzle's own transaction callback signature loosely enough to pass through to the real db.transaction without fighting its generics in a test-only stub.
      transaction: (fn: any) => {
        transactionCalls++;
        if (transactionCalls >= 2) {
          throw new Error('simulated settlement failure');
        }
        return db.transaction(fn);
      },
    } as unknown as typeof db;

    const responses = new Map<string, HttpFetchResult | Error>([
      ...discoveryPages([], ['1001']),
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), mailtoDetailHtml('1001'))],
    ]);

    await expect(
      runJobsGeCrawl(
        {
          db: settlementFailingDb,
          httpFetcher: new FakeHttpFetcher(responses),
          now: makeClock(Date.UTC(2026, 8, 4, 12, 0, 0)),
        },
        { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 },
      ),
    ).rejects.toThrow('simulated settlement failure');

    const [run] = await db.select().from(crawlRuns).where(eq(crawlRuns.sourceId, jobsGeSource.id));
    expect(run?.status).toBe('failed');
    expect(run?.expiredCount).toBe(0);
    expect(run?.missingCount).toBe(0);

    const [stillExpiredCandidate] = await db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.id, expiredCandidate.id));
    expect(stillExpiredCandidate?.status).toBe('active');

    const [stillMissingCandidate] = await db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.id, missingCandidate.id));
    expect(stillMissingCandidate?.status).toBe('active');
    expect(stillMissingCandidate?.missingStreak).toBe(0);
  });

  it('does not relabel an already-committed settlement as failed when the commit acknowledgement is lost', async () => {
    // Adversarial review, 2026-09-05, round 10: PostgreSQL can actually
    // commit the settlement transaction (expiry/closure/counts/reconciledAt
    // all persisted) while the client never receives the COMMIT
    // acknowledgment, so db.transaction still throws on the client side even
    // though the run genuinely settled. Unlike the round-9 test above (which
    // fails the transaction before it ever runs), this one lets the
    // transaction really commit via the real db, then throws afterward —
    // proving the outer catch block's failUnsettledCrawlRun leaves an
    // already-settled row alone instead of overwriting it with a false
    // 'failed' status and stale (pre-settlement) counts.
    await ensureJobsGeSourceSeeded(db);
    const expiredCandidate = await createTestSourceListing(jobsGeSource.id, {
      sourceRecordId: '8001',
      status: 'active',
      missingStreak: 0,
      lastSeenAt: '2026-09-04T12:00:00Z',
      sourceDeadlineAt: '2026-01-01T00:00:00Z', // already past
    });
    const missingCandidate = await createTestSourceListing(jobsGeSource.id, {
      sourceRecordId: '8002',
      status: 'active',
      missingStreak: 0,
      lastSeenAt: '2026-01-01T00:00:00Z', // old enough, and absent from this run's discovery
    });

    let transactionCalls = 0;
    const lostAcknowledgementDb = {
      insert: db.insert.bind(db),
      select: db.select.bind(db),
      update: db.update.bind(db),
      // biome-ignore lint/suspicious/noExplicitAny: matches drizzle's own transaction callback signature loosely enough to pass through to the real db.transaction without fighting its generics in a test-only stub.
      transaction: async (fn: any) => {
        transactionCalls++;
        const result = await db.transaction(fn); // really commits
        if (transactionCalls >= 2) {
          throw new Error('simulated lost commit acknowledgement');
        }
        return result;
      },
    } as unknown as typeof db;

    const responses = new Map<string, HttpFetchResult | Error>([
      ...discoveryPages([], ['1001']),
      [detailUrl('1001'), htmlResponse(detailUrl('1001'), mailtoDetailHtml('1001'))],
    ]);

    await expect(
      runJobsGeCrawl(
        {
          db: lostAcknowledgementDb,
          httpFetcher: new FakeHttpFetcher(responses),
          now: makeClock(Date.UTC(2026, 8, 4, 12, 0, 0)),
        },
        { missingStreakThreshold: 3, minExpectedDiscoveredListings: 1 },
      ),
    ).rejects.toThrow('simulated lost commit acknowledgement');

    const [run] = await db.select().from(crawlRuns).where(eq(crawlRuns.sourceId, jobsGeSource.id));
    expect(run?.status).toBe('completed'); // NOT 'failed' — the commit genuinely landed
    expect(run?.reconciledAt).not.toBeNull();
    expect(run?.expiredCount).toBe(1);
    expect(run?.missingCount).toBe(1);

    const [stillExpiredCandidate] = await db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.id, expiredCandidate.id));
    expect(stillExpiredCandidate?.status).toBe('expired');

    const [stillMissingCandidate] = await db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.id, missingCandidate.id));
    expect(stillMissingCandidate?.status).toBe('missing_suspected');
    expect(stillMissingCandidate?.missingStreak).toBe(1);
  });
});
