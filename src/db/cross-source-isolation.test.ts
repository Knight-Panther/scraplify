import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from './client.js';
import {
  CrawlAlreadyRunningError,
  extendSourceBackoff,
  getCrawlCursor,
  getCrawlDiscoveryPage,
  getLastCompletedCrawlRun,
  getMaxDiscoveredCountForSource,
  getSourceBackoffUntil,
  recordParserIncident,
  setCrawlCursor,
  setCrawlDiscoveryPage,
  startCrawlRun,
  upsertResource,
} from './ingest.js';
import { closeMissingListings, expireOverdueListings } from './reconcile-source-listings.js';
import {
  crawlCursors,
  crawlRuns,
  parserIncidents,
  resources,
  sourceListings,
} from './schema/index.js';
import {
  cleanupTestSource,
  createTestCrawlRun,
  createTestSource,
  createTestSourceListing,
  snapshotSourceState,
} from './test-support.js';

/**
 * Phase 1C, "confirm that a failing source cannot affect the other source's
 * state." Every reconciliation and cursor test that existed before this file
 * ran against a single source, so the per-source scoping those functions
 * depend on was asserted nowhere — it was only ever visible by reading the
 * WHERE clauses.
 *
 * These tests are deliberately paired: source A does something (reconciles,
 * gets rate-limited, fails), and the assertion is about source B, which is set
 * up to be *maximally* susceptible — same staleness, same deadline, same
 * record ids, same URLs. A scoping bug that a single-source test cannot see at
 * all shows up here as B's state moving in lockstep with A's.
 *
 * The motivating incident is real: on 2026-09-06 the two adapters' tests
 * collided through a shared `sources.slug`, and 20 hr-ge tests failed because
 * of a row jobs-ge had put there (docs/STATUS.md). The mechanism was a test
 * artifact, but "one source's rows break the other's path" is exactly the
 * class this file exists to rule out.
 */
describe('cross-source isolation', () => {
  const sourceIds: string[] = [];

  async function createSourcePair(): Promise<{ a: string; b: string }> {
    const a = await createTestSource();
    const b = await createTestSource();
    sourceIds.push(a, b);
    return { a, b };
  }

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) {
      await cleanupTestSource(sourceId);
    }
  });

  describe('reconciliation', () => {
    it("does not advance another source's equally stale listing", async () => {
      const { a, b } = await createSourcePair();
      // Identical in every respect a scoping bug could key on: same status,
      // same lastSeenAt, same never-reconciled state, both older than the run.
      const listingA = await createTestSourceListing(a, {
        status: 'active',
        lastSeenAt: '2026-01-01T00:00:00Z',
      });
      const listingB = await createTestSourceListing(b, {
        status: 'active',
        lastSeenAt: '2026-01-01T00:00:00Z',
      });
      const runA = await createTestCrawlRun(a, { status: 'completed', fullCoverage: true });

      const result = await closeMissingListings(db, {
        crawlRunId: runA.id,
        missingStreakThreshold: 3,
      });

      expect(result).toEqual({ skipped: false, missingSuspectedCount: 1, closedCount: 0 });

      const [rowA] = await db
        .select()
        .from(sourceListings)
        .where(eq(sourceListings.id, listingA.id));
      expect(rowA?.status).toBe('missing_suspected');
      expect(rowA?.missingStreak).toBe(1);

      const [rowB] = await db
        .select()
        .from(sourceListings)
        .where(eq(sourceListings.id, listingB.id));
      expect(rowB?.status).toBe('active');
      expect(rowB?.missingStreak).toBe(0);
      expect(rowB?.lastReconciledAt).toBeNull();
    });

    it("does not close another source's listing already at the threshold", async () => {
      const { a, b } = await createSourcePair();
      // B is one miss away from closure — the highest-consequence row a
      // cross-source leak could touch, since closure is the terminal end of
      // §13's lifecycle rather than a recoverable intermediate state.
      const listingA = await createTestSourceListing(a, {
        status: 'missing_suspected',
        lastSeenAt: '2026-01-01T00:00:00Z',
        missingStreak: 2,
      });
      const listingB = await createTestSourceListing(b, {
        status: 'missing_suspected',
        lastSeenAt: '2026-01-01T00:00:00Z',
        missingStreak: 2,
      });
      const runA = await createTestCrawlRun(a, { status: 'completed', fullCoverage: true });

      const result = await closeMissingListings(db, {
        crawlRunId: runA.id,
        missingStreakThreshold: 3,
      });

      expect(result).toEqual({ skipped: false, missingSuspectedCount: 0, closedCount: 1 });

      const [rowA] = await db
        .select()
        .from(sourceListings)
        .where(eq(sourceListings.id, listingA.id));
      expect(rowA?.status).toBe('closed');

      const [rowB] = await db
        .select()
        .from(sourceListings)
        .where(eq(sourceListings.id, listingB.id));
      expect(rowB?.status).toBe('missing_suspected');
      expect(rowB?.missingStreak).toBe(2);
    });

    it("does not expire another source's equally overdue listing", async () => {
      const { a, b } = await createSourcePair();
      const listingA = await createTestSourceListing(a, {
        status: 'active',
        sourceDeadlineAt: '2026-01-02T00:00:00Z',
      });
      const listingB = await createTestSourceListing(b, {
        status: 'active',
        sourceDeadlineAt: '2026-01-02T00:00:00Z',
      });

      const result = await expireOverdueListings(db, {
        sourceId: a,
        asOf: '2026-01-03T00:00:00Z',
      });

      expect(result).toEqual({ expiredCount: 1 });

      const [rowA] = await db
        .select()
        .from(sourceListings)
        .where(eq(sourceListings.id, listingA.id));
      expect(rowA?.status).toBe('expired');

      const [rowB] = await db
        .select()
        .from(sourceListings)
        .where(eq(sourceListings.id, listingB.id));
      expect(rowB?.status).toBe('active');
    });
  });

  describe('coverage baselines', () => {
    it("does not read another source's completed run as its own baseline", async () => {
      const { a, b } = await createSourcePair();
      await createTestCrawlRun(a, {
        status: 'completed',
        fullCoverage: true,
        discoveredCount: 5647,
      });

      expect(await getLastCompletedCrawlRun(db, b)).toBeNull();
      expect(await getLastCompletedCrawlRun(db, a)).not.toBeNull();
    });

    it("does not let another source's corpus size become this source's coverage floor", async () => {
      const { a, b } = await createSourcePair();
      // The realistic shape of this bug: jobs.ge's ~5,647-listing corpus
      // leaking into hr.ge's relative-coverage guard would make every
      // genuinely complete hr.ge run look like a catastrophic collapse and
      // suppress its reconciliation indefinitely.
      await createTestCrawlRun(a, {
        status: 'completed',
        fullCoverage: true,
        discoveredCount: 5647,
      });
      const runB = await createTestCrawlRun(b, { status: 'running', reconciledAt: null });

      expect(await getMaxDiscoveredCountForSource(db, b, runB.id)).toBe(0);
      expect(await getMaxDiscoveredCountForSource(db, a, runB.id)).toBe(5647);
    });
  });

  describe('run exclusivity', () => {
    it("lets one source start a run while another's run is still unsettled", async () => {
      const { a, b } = await createSourcePair();
      // The exclusivity index is partial on (source_id) WHERE reconciled_at
      // IS NULL. If it were global rather than per-source, a single stuck or
      // long-running source would block every other source's crawl — the most
      // direct possible violation of this phase's exit gate.
      await startCrawlRun(db, {
        sourceId: a,
        startedAt: '2026-01-05T00:00:00Z',
        fullCoverage: true,
      });

      const runB = await startCrawlRun(db, {
        sourceId: b,
        startedAt: '2026-01-05T00:00:01Z',
        fullCoverage: true,
      });
      expect(runB.sourceId).toBe(b);
    });

    it('still blocks a second unsettled run for the same source', async () => {
      const { a } = await createSourcePair();
      await startCrawlRun(db, {
        sourceId: a,
        startedAt: '2026-01-05T00:00:00Z',
        fullCoverage: true,
      });

      // The positive control for the test above: proof the index is genuinely
      // enforcing, so "B was allowed to start" means "scoped per-source"
      // rather than "not enforced at all."
      await expect(
        startCrawlRun(db, {
          sourceId: a,
          startedAt: '2026-01-05T00:00:02Z',
          fullCoverage: true,
        }),
      ).rejects.toThrow(CrawlAlreadyRunningError);
    });
  });

  describe('cursors and cooldowns', () => {
    it('does not stall a healthy source when another source is rate-limited', async () => {
      const { a, b } = await createSourcePair();

      await extendSourceBackoff(db, a, '2026-01-05T01:00:00Z', '2026-01-05T00:00:00Z');

      // Compared as an instant, not a string: the driver returns timestamptz
      // in Postgres's own rendering ('2026-01-05 01:00:00+00'), not ISO-8601.
      const backoffA = await getSourceBackoffUntil(db, a);
      expect(backoffA).not.toBeNull();
      expect(Date.parse(backoffA as string)).toBe(Date.parse('2026-01-05T01:00:00Z'));
      expect(await getSourceBackoffUntil(db, b)).toBeNull();
    });

    it("does not move another source's detail or discovery cursor", async () => {
      const { a, b } = await createSourcePair();
      await setCrawlCursor(db, b, 'b-100', '2026-01-05T00:00:00Z');
      await setCrawlDiscoveryPage(db, b, 7, '2026-01-05T00:00:00Z');

      // A stops mid-walk and records its own resume position.
      await setCrawlCursor(db, a, 'a-42', '2026-01-05T00:01:00Z');
      await setCrawlDiscoveryPage(db, a, 3, '2026-01-05T00:01:00Z');

      expect(await getCrawlCursor(db, a)).toBe('a-42');
      expect(await getCrawlDiscoveryPage(db, a)).toBe(3);
      expect(await getCrawlCursor(db, b)).toBe('b-100');
      expect(await getCrawlDiscoveryPage(db, b)).toBe(7);

      // And a cooldown on A leaves B's cursor row entirely alone, including
      // its updatedAt — the field-preservation contract crawl-cursors.ts
      // states is only meaningful if it also holds across sources.
      const [beforeB] = await db.select().from(crawlCursors).where(eq(crawlCursors.sourceId, b));
      await extendSourceBackoff(db, a, '2026-01-05T02:00:00Z', '2026-01-05T00:02:00Z');
      const [afterB] = await db.select().from(crawlCursors).where(eq(crawlCursors.sourceId, b));
      expect(afterB).toEqual(beforeB);
    });
  });

  describe('shared identifiers', () => {
    it('keeps listings with the same source record id distinct per source', async () => {
      const { a, b } = await createSourcePair();
      // Both boards number their listings from small integers, so the same
      // sourceRecordId appearing under both is the normal case, not an edge
      // case. §12.1's identity is (source, record id) precisely for this.
      const sharedRecordId = '12345';
      const listingA = await createTestSourceListing(a, { sourceRecordId: sharedRecordId });
      const listingB = await createTestSourceListing(b, { sourceRecordId: sharedRecordId });

      expect(listingA.id).not.toBe(listingB.id);

      // And reconciling A's copy leaves B's copy alone despite the shared id.
      const runA = await createTestCrawlRun(a, { status: 'completed', fullCoverage: true });
      await db
        .update(sourceListings)
        .set({ lastSeenAt: '2026-01-01T00:00:00Z' })
        .where(eq(sourceListings.sourceId, a));
      await closeMissingListings(db, { crawlRunId: runA.id, missingStreakThreshold: 3 });

      const [rowB] = await db
        .select()
        .from(sourceListings)
        .where(eq(sourceListings.id, listingB.id));
      expect(rowB?.status).toBe('active');
      expect(rowB?.missingStreak).toBe(0);
    });

    it('keeps a resource at the same canonical URL distinct per source', async () => {
      const { a, b } = await createSourcePair();
      // Both boards can link the same external employer careers page, so
      // resource identity (§11) is (source, canonical URL, role). A shared row
      // here would let one source's fetch overwrite the other's provenance —
      // the evidence §6.2 requires every claim to be traceable to.
      const sharedUrl = 'https://employer.invalid/careers';

      const rowB = await upsertResource(db, {
        sourceId: b,
        role: 'ORGANIZATION',
        originalUrl: sharedUrl,
        canonicalUrl: sharedUrl,
        finalUrl: null,
        status: 'fetched',
        fetchedAt: '2026-01-05T00:00:00Z',
        contentHash: 'b'.repeat(64),
        byteSize: 100,
        mimeType: 'text/html',
      });

      const rowA = await upsertResource(db, {
        sourceId: a,
        role: 'ORGANIZATION',
        originalUrl: sharedUrl,
        canonicalUrl: sharedUrl,
        finalUrl: null,
        status: 'failed',
        fetchedAt: '2026-01-05T01:00:00Z',
        contentHash: null,
        byteSize: null,
        mimeType: null,
      });

      expect(rowA.id).not.toBe(rowB.id);
      // A's later, failed fetch must not overwrite B's good row, even though
      // it is newer and would win the setWhere comparison within one source.
      const [storedB] = await db.select().from(resources).where(eq(resources.id, rowB.id));
      expect(storedB?.status).toBe('fetched');
      expect(storedB?.contentHash).toBe('b'.repeat(64));
    });
  });

  describe('incidents', () => {
    it("does not attribute one source's parser incident to another", async () => {
      const { a, b } = await createSourcePair();
      const runA = await createTestCrawlRun(a, { status: 'quarantined', fullCoverage: false });

      await recordParserIncident(db, {
        sourceId: a,
        crawlRunId: runA.id,
        detectedAt: '2026-01-05T00:00:00Z',
        kind: 'count_collapse',
        severity: 'critical',
        evidence: { discovered: 3, baseline: 5647 },
      });

      const forA = await db.select().from(parserIncidents).where(eq(parserIncidents.sourceId, a));
      const forB = await db.select().from(parserIncidents).where(eq(parserIncidents.sourceId, b));
      expect(forA).toHaveLength(1);
      expect(forB).toHaveLength(0);
    });
  });

  describe('whole-state snapshot', () => {
    it("leaves a healthy source's entire recorded state untouched while another source fails", async () => {
      const { a, b } = await createSourcePair();

      // B is a source in a fully populated, healthy state: listings at several
      // interesting points of §13's lifecycle, a settled run, both cursors, a
      // cooldown, and a fetched resource.
      await createTestSourceListing(b, { status: 'active', lastSeenAt: '2026-01-01T00:00:00Z' });
      await createTestSourceListing(b, {
        status: 'missing_suspected',
        lastSeenAt: '2026-01-01T00:00:00Z',
        missingStreak: 2,
      });
      await createTestSourceListing(b, {
        status: 'active',
        sourceDeadlineAt: '2026-01-02T00:00:00Z',
      });
      await createTestCrawlRun(b, { status: 'completed', fullCoverage: true, discoveredCount: 42 });
      await setCrawlCursor(db, b, 'b-100', '2026-01-05T00:00:00Z');
      await setCrawlDiscoveryPage(db, b, 7, '2026-01-05T00:00:00Z');
      await extendSourceBackoff(db, b, '2026-01-05T03:00:00Z', '2026-01-05T00:00:00Z');
      await upsertResource(db, {
        sourceId: b,
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

      const before = await snapshotSourceState(b);

      // A now goes through a full bad day: it starts a run, gets blocked and
      // rate-limited, records an incident, saves a partial resume position,
      // and settles as failed. Then a later completed run of its own
      // reconciles, expires, and closes listings — the write-heaviest thing
      // any source ever does to the shared tables.
      const failing = await startCrawlRun(db, {
        sourceId: a,
        startedAt: '2026-01-06T00:00:00Z',
        fullCoverage: true,
      });
      await extendSourceBackoff(db, a, '2026-01-06T04:00:00Z', '2026-01-06T00:01:00Z');
      await setCrawlDiscoveryPage(db, a, 12, '2026-01-06T00:01:00Z');
      await recordParserIncident(db, {
        sourceId: a,
        crawlRunId: failing.id,
        detectedAt: '2026-01-06T00:02:00Z',
        kind: 'access_denied',
        severity: 'critical',
        evidence: { statusCode: 403 },
      });
      await db
        .update(crawlRuns)
        .set({ status: 'failed', reconciledAt: '2026-01-06T00:03:00Z' })
        .where(eq(crawlRuns.id, failing.id));

      await createTestSourceListing(a, { status: 'active', lastSeenAt: '2026-01-01T00:00:00Z' });
      await createTestSourceListing(a, {
        status: 'active',
        sourceDeadlineAt: '2026-01-02T00:00:00Z',
      });
      const recovered = await createTestCrawlRun(a, {
        startedAt: '2026-01-07T00:00:00Z',
        status: 'completed',
        fullCoverage: true,
      });
      await expireOverdueListings(db, { sourceId: a, asOf: '2026-01-07T00:00:00Z' });
      await closeMissingListings(db, { crawlRunId: recovered.id, missingStreakThreshold: 3 });

      expect(await snapshotSourceState(b)).toEqual(before);
    });
  });
});
