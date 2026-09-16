import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from './client.js';
import {
  closeMissingListings,
  expireOverdueListings,
  MASS_CLOSURE_MIN_CAP,
} from './reconcile-source-listings.js';
import { parserIncidents, sourceListings } from './schema/index.js';
import {
  cleanupTestSource,
  createTestCrawlRun,
  createTestSource,
  createTestSourceListing,
} from './test-support.js';

describe('closeMissingListings', () => {
  let sourceId: string;

  afterEach(async () => {
    if (sourceId) await cleanupTestSource(sourceId);
  });

  it('rejects a threshold below 2 without touching the database', async () => {
    sourceId = await createTestSource();
    const run = await createTestCrawlRun(sourceId);

    await expect(
      closeMissingListings(db, { crawlRunId: run.id, missingStreakThreshold: 1 }),
    ).rejects.toThrow(/missingStreakThreshold/);
  });

  it('rejects a non-existent crawl run id', async () => {
    sourceId = await createTestSource();

    await expect(
      closeMissingListings(db, {
        crawlRunId: '00000000-0000-0000-0000-000000000000',
        missingStreakThreshold: 3,
      }),
    ).rejects.toThrow(/no crawl run found/);
  });

  it('is a no-op when the persisted run is not completed, even if a caller might assume otherwise', async () => {
    sourceId = await createTestSource();
    const listing = await createTestSourceListing(sourceId, {
      status: 'active',
      lastSeenAt: '2026-01-01T00:00:00Z',
    });
    const run = await createTestCrawlRun(sourceId, { status: 'partial', fullCoverage: true });

    const result = await closeMissingListings(db, {
      crawlRunId: run.id,
      missingStreakThreshold: 3,
    });

    expect(result).toEqual({
      skipped: true,
      missingSuspectedCount: 0,
      closedCount: 0,
      closureCapped: false,
    });
    const [row] = await db.select().from(sourceListings).where(eq(sourceListings.id, listing.id));
    expect(row?.status).toBe('active');
    expect(row?.missingStreak).toBe(0);
  });

  it('is a no-op when the persisted run did not have full coverage', async () => {
    sourceId = await createTestSource();
    const listing = await createTestSourceListing(sourceId, {
      status: 'active',
      lastSeenAt: '2026-01-01T00:00:00Z',
    });
    const run = await createTestCrawlRun(sourceId, { status: 'completed', fullCoverage: false });

    const result = await closeMissingListings(db, {
      crawlRunId: run.id,
      missingStreakThreshold: 3,
    });

    expect(result).toEqual({
      skipped: true,
      missingSuspectedCount: 0,
      closedCount: 0,
      closureCapped: false,
    });
    const [row] = await db.select().from(sourceListings).where(eq(sourceListings.id, listing.id));
    expect(row?.status).toBe('active');
  });

  it('does not touch a listing seen during this run (lastSeenAt >= run.startedAt)', async () => {
    sourceId = await createTestSource();
    const listing = await createTestSourceListing(sourceId, {
      status: 'active',
      lastSeenAt: '2026-01-05T12:00:00Z',
    });
    const run = await createTestCrawlRun(sourceId, { startedAt: '2026-01-05T00:00:00Z' });

    const result = await closeMissingListings(db, {
      crawlRunId: run.id,
      missingStreakThreshold: 3,
    });

    expect(result).toEqual({
      skipped: false,
      missingSuspectedCount: 0,
      closedCount: 0,
      closureCapped: false,
    });
    const [row] = await db.select().from(sourceListings).where(eq(sourceListings.id, listing.id));
    expect(row?.status).toBe('active');
    expect(row?.missingStreak).toBe(0);
  });

  it('moves an active listing missed once to missing_suspected without closing it', async () => {
    sourceId = await createTestSource();
    const listing = await createTestSourceListing(sourceId, {
      status: 'active',
      missingStreak: 0,
      lastSeenAt: '2026-01-01T00:00:00Z',
    });
    const run = await createTestCrawlRun(sourceId, { startedAt: '2026-01-05T00:00:00Z' });

    const result = await closeMissingListings(db, {
      crawlRunId: run.id,
      missingStreakThreshold: 3,
    });

    expect(result).toEqual({
      skipped: false,
      missingSuspectedCount: 1,
      closedCount: 0,
      closureCapped: false,
    });
    const [row] = await db.select().from(sourceListings).where(eq(sourceListings.id, listing.id));
    expect(row?.status).toBe('missing_suspected');
    expect(row?.missingStreak).toBe(1);
  });

  it('closes a listing whose streak crosses the threshold', async () => {
    sourceId = await createTestSource();
    const listing = await createTestSourceListing(sourceId, {
      status: 'missing_suspected',
      missingStreak: 2,
      lastSeenAt: '2026-01-01T00:00:00Z',
    });
    const run = await createTestCrawlRun(sourceId, { startedAt: '2026-01-05T00:00:00Z' });

    const result = await closeMissingListings(db, {
      crawlRunId: run.id,
      missingStreakThreshold: 3,
    });

    expect(result).toEqual({
      skipped: false,
      missingSuspectedCount: 0,
      closedCount: 1,
      closureCapped: false,
    });
    const [row] = await db.select().from(sourceListings).where(eq(sourceListings.id, listing.id));
    expect(row?.status).toBe('closed');
    expect(row?.missingStreak).toBe(3);
  });

  it('does not re-advance the streak when retried for the same crawl run', async () => {
    sourceId = await createTestSource();
    const listing = await createTestSourceListing(sourceId, {
      status: 'active',
      missingStreak: 0,
      lastSeenAt: '2026-01-01T00:00:00Z',
    });
    const run = await createTestCrawlRun(sourceId, { startedAt: '2026-01-05T00:00:00Z' });
    const input = { crawlRunId: run.id, missingStreakThreshold: 3 };

    const first = await closeMissingListings(db, input);
    const retry = await closeMissingListings(db, input);

    expect(first).toEqual({
      skipped: false,
      missingSuspectedCount: 1,
      closedCount: 0,
      closureCapped: false,
    });
    expect(retry).toEqual({
      skipped: false,
      missingSuspectedCount: 0,
      closedCount: 0,
      closureCapped: false,
    });
    const [row] = await db.select().from(sourceListings).where(eq(sourceListings.id, listing.id));
    expect(row?.status).toBe('missing_suspected');
    expect(row?.missingStreak).toBe(1);
  });

  it('does advance the streak again on a later, separate crawl run', async () => {
    sourceId = await createTestSource();
    const listing = await createTestSourceListing(sourceId, {
      status: 'active',
      missingStreak: 0,
      lastSeenAt: '2026-01-01T00:00:00Z',
    });
    const runOneRow = await createTestCrawlRun(sourceId, { startedAt: '2026-01-05T00:00:00Z' });
    const runTwoRow = await createTestCrawlRun(sourceId, {
      startedAt: '2026-01-10T00:00:00Z',
      finishedAt: '2026-01-10T01:00:00Z',
    });

    const runOne = await closeMissingListings(db, {
      crawlRunId: runOneRow.id,
      missingStreakThreshold: 3,
    });
    const runTwo = await closeMissingListings(db, {
      crawlRunId: runTwoRow.id,
      missingStreakThreshold: 3,
    });

    expect(runOne).toEqual({
      skipped: false,
      missingSuspectedCount: 1,
      closedCount: 0,
      closureCapped: false,
    });
    expect(runTwo).toEqual({
      skipped: false,
      missingSuspectedCount: 1,
      closedCount: 0,
      closureCapped: false,
    });
    const [row] = await db.select().from(sourceListings).where(eq(sourceListings.id, listing.id));
    expect(row?.status).toBe('missing_suspected');
    expect(row?.missingStreak).toBe(2);
  });

  it('does not touch listings already closed, expired, discovered, or quarantined', async () => {
    sourceId = await createTestSource();
    const statuses = ['closed', 'expired', 'discovered', 'quarantined'] as const;
    const listings = await Promise.all(
      statuses.map((status) =>
        createTestSourceListing(sourceId, { status, lastSeenAt: '2026-01-01T00:00:00Z' }),
      ),
    );
    const run = await createTestCrawlRun(sourceId, { startedAt: '2026-01-05T00:00:00Z' });

    const result = await closeMissingListings(db, {
      crawlRunId: run.id,
      missingStreakThreshold: 3,
    });

    expect(result).toEqual({
      skipped: false,
      missingSuspectedCount: 0,
      closedCount: 0,
      closureCapped: false,
    });
    for (const [index, status] of statuses.entries()) {
      const [row] = await db
        .select()
        .from(sourceListings)
        .where(eq(sourceListings.id, listings[index]?.id ?? ''));
      expect(row?.status).toBe(status);
    }
  });
});

describe('expireOverdueListings', () => {
  let sourceId: string;

  afterEach(async () => {
    if (sourceId) await cleanupTestSource(sourceId);
  });

  it('expires an active listing past its deadline', async () => {
    sourceId = await createTestSource();
    const listing = await createTestSourceListing(sourceId, {
      status: 'active',
      sourceDeadlineAt: '2026-01-01T00:00:00Z',
    });

    const result = await expireOverdueListings(db, {
      sourceId,
      asOf: '2026-01-05T00:00:00Z',
    });

    expect(result).toEqual({ expiredCount: 1 });
    const [row] = await db.select().from(sourceListings).where(eq(sourceListings.id, listing.id));
    expect(row?.status).toBe('expired');
  });

  it('expires a missing_suspected listing past its deadline', async () => {
    sourceId = await createTestSource();
    const listing = await createTestSourceListing(sourceId, {
      status: 'missing_suspected',
      sourceDeadlineAt: '2026-01-01T00:00:00Z',
    });

    const result = await expireOverdueListings(db, {
      sourceId,
      asOf: '2026-01-05T00:00:00Z',
    });

    expect(result).toEqual({ expiredCount: 1 });
    const [row] = await db.select().from(sourceListings).where(eq(sourceListings.id, listing.id));
    expect(row?.status).toBe('expired');
  });

  it('does not expire a listing whose deadline has not passed yet', async () => {
    sourceId = await createTestSource();
    const listing = await createTestSourceListing(sourceId, {
      status: 'active',
      sourceDeadlineAt: '2026-01-10T00:00:00Z',
    });

    const result = await expireOverdueListings(db, {
      sourceId,
      asOf: '2026-01-05T00:00:00Z',
    });

    expect(result).toEqual({ expiredCount: 0 });
    const [row] = await db.select().from(sourceListings).where(eq(sourceListings.id, listing.id));
    expect(row?.status).toBe('active');
  });

  it('does not expire a listing with no deadline', async () => {
    sourceId = await createTestSource();
    const listing = await createTestSourceListing(sourceId, {
      status: 'active',
      sourceDeadlineAt: null,
    });

    const result = await expireOverdueListings(db, {
      sourceId,
      asOf: '2026-01-05T00:00:00Z',
    });

    expect(result).toEqual({ expiredCount: 0 });
    const [row] = await db.select().from(sourceListings).where(eq(sourceListings.id, listing.id));
    expect(row?.status).toBe('active');
  });

  it('does not touch a closed or already-expired listing', async () => {
    sourceId = await createTestSource();
    const closed = await createTestSourceListing(sourceId, {
      status: 'closed',
      sourceDeadlineAt: '2026-01-01T00:00:00Z',
    });

    const result = await expireOverdueListings(db, {
      sourceId,
      asOf: '2026-01-05T00:00:00Z',
    });

    expect(result).toEqual({ expiredCount: 0 });
    const [row] = await db.select().from(sourceListings).where(eq(sourceListings.id, closed.id));
    expect(row?.status).toBe('closed');
  });
});

describe('closeMissingListings mass-closure cap', () => {
  let sourceId: string;

  afterEach(async () => {
    if (sourceId) await cleanupTestSource(sourceId);
  });

  /** `closing` listings on their last allowed miss, plus `healthy` ones seen in the run. */
  async function seed(closing: number, healthy: number) {
    sourceId = await createTestSource();
    for (let i = 0; i < closing; i++) {
      await createTestSourceListing(sourceId, {
        status: 'missing_suspected',
        missingStreak: 2,
        lastSeenAt: '2026-01-01T00:00:00Z',
      });
    }
    for (let i = 0; i < healthy; i++) {
      await createTestSourceListing(sourceId, {
        status: 'active',
        lastSeenAt: '2026-01-05T12:00:00Z',
      });
    }
    return createTestCrawlRun(sourceId, {
      startedAt: '2026-01-05T00:00:00Z',
      finishedAt: '2026-01-05T01:00:00Z',
    });
  }

  const incidents = () =>
    db.select().from(parserIncidents).where(eq(parserIncidents.sourceId, sourceId));

  it('closes a batch at the cap as usual', async () => {
    // 25 of 30 open is far above 10%, but never below the fixed floor of 25.
    const run = await seed(MASS_CLOSURE_MIN_CAP, 5);
    const result = await closeMissingListings(db, {
      crawlRunId: run.id,
      missingStreakThreshold: 3,
    });
    expect(result).toMatchObject({ closedCount: MASS_CLOSURE_MIN_CAP, closureCapped: false });
    expect(await incidents()).toHaveLength(0);
  });

  it('closes nothing over the cap, keeps the streaks advancing, and opens one critical incident', async () => {
    const run = await seed(MASS_CLOSURE_MIN_CAP + 1, 5);
    const result = await closeMissingListings(db, {
      crawlRunId: run.id,
      missingStreakThreshold: 3,
    });

    expect(result).toEqual({
      skipped: false,
      missingSuspectedCount: MASS_CLOSURE_MIN_CAP + 1,
      closedCount: 0,
      closureCapped: true,
    });
    const rows = await db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.sourceId, sourceId));
    const held = rows.filter((row) => row.status === 'missing_suspected');
    expect(held).toHaveLength(MASS_CLOSURE_MIN_CAP + 1);
    expect(held.every((row) => row.missingStreak === 3)).toBe(true);
    expect(rows.some((row) => row.status === 'closed')).toBe(false);

    const [incident, ...more] = await incidents();
    expect(more).toHaveLength(0);
    expect(incident).toMatchObject({
      crawlRunId: run.id,
      kind: 'mass_closure_suspected',
      severity: 'critical',
      resolved: false,
    });
    expect(incident?.evidence).toMatchObject({
      closureCandidateCount: MASS_CLOSURE_MIN_CAP + 1,
      openListingCount: MASS_CLOSURE_MIN_CAP + 6,
      closureCap: MASS_CLOSURE_MIN_CAP,
    });
  });

  it('scales the cap with the size of the source', async () => {
    // 10% of 400 open listings is 40, so 30 closures is ordinary churn there.
    const run = await seed(30, 370);
    const result = await closeMissingListings(db, {
      crawlRunId: run.id,
      missingStreakThreshold: 3,
    });
    expect(result).toMatchObject({ closedCount: 30, closureCapped: false });
  });

  it('closes an over-cap batch when a person has reviewed it and allowed it', async () => {
    const run = await seed(MASS_CLOSURE_MIN_CAP + 1, 5);
    const result = await closeMissingListings(db, {
      crawlRunId: run.id,
      missingStreakThreshold: 3,
      allowMassClosure: true,
    });
    expect(result).toMatchObject({ closedCount: MASS_CLOSURE_MIN_CAP + 1, closureCapped: false });
    expect(await incidents()).toHaveLength(0);
  });
});
