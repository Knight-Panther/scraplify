import { asc, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResourceId } from '../domain/ids.js';
import { db } from './client.js';
import { closeMissingListings, expireOverdueListings } from './reconcile-source-listings.js';
import { sourceListingStatusEvents, sourceListings } from './schema/index.js';
import { backfillStatusEvents } from './status-events.js';
import {
  cleanupTestSource,
  createTestCrawlRun,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from './test-support.js';
import {
  quarantineSourceListing,
  type SourceListingRevisionContent,
  touchSourceListingSeen,
  writeSourceListingRevision,
} from './write-source-listing-revision.js';

function makeContent(
  resourceId: string,
  overrides: Partial<SourceListingRevisionContent> = {},
): SourceListingRevisionContent {
  return {
    parserVersion: 'v1',
    extractionMethod: 'http',
    rawResourceHash: 'a'.repeat(64),
    meaningfulContentHash: 'b'.repeat(64),
    titleRaw: 'Accountant',
    titleNormalized: 'accountant',
    organizationRaw: 'Acme',
    description: 'Payroll and reporting',
    locations: ['Tbilisi'],
    salaryRaw: null,
    publishedDate: { raw: '2026-09-01', parsed: '2026-09-01T00:00:00Z' },
    deadlineDate: { raw: '2026-10-01', parsed: '2026-10-01T00:00:00Z' },
    applicationMethod: null,
    sourceCategories: [],
    structuredAttributes: {},
    provenance: {
      fetchedAt: '2026-09-04T12:00:00Z',
      resourceId: resourceId as ResourceId,
      notes: null,
    },
    ...overrides,
  };
}

/** Every event of these listings, oldest first, in a shape easy to compare. */
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
    at: new Date(row.at).toISOString(),
    run: row.crawlRunId,
    approximate: row.approximate,
    reason: row.reason,
  }));
}

describe('status events from the observation writers', () => {
  let sourceId: string;

  afterEach(async () => {
    if (sourceId) await cleanupTestSource(sourceId);
  });

  function identity(recordId: string) {
    return {
      sourceId,
      sourceRecordId: recordId,
      canonicalSourceUrl: `https://example.invalid/?id=${recordId}`,
    };
  }

  it('records a new listing once, and nothing for an unchanged or changed re-read', async () => {
    sourceId = await createTestSource();
    const run = await createTestCrawlRun(sourceId);
    const resourceId = await createTestResource(sourceId);

    const first = await writeSourceListingRevision(
      db,
      identity('1'),
      makeContent(resourceId),
      '2026-09-04T12:00:00.000Z',
      { crawlRunId: run.id },
    );
    await writeSourceListingRevision(
      db,
      identity('1'),
      makeContent(resourceId),
      '2026-09-05T12:00:00.000Z',
    );
    await writeSourceListingRevision(
      db,
      identity('1'),
      makeContent(resourceId, { meaningfulContentHash: 'c'.repeat(64) }),
      '2026-09-06T12:00:00.000Z',
    );

    expect(await eventsOf(first.sourceListing.id)).toEqual([
      {
        listing: first.sourceListing.id,
        from: null,
        to: 'active',
        at: '2026-09-04T12:00:00.000Z',
        run: run.id,
        approximate: false,
        reason: 'first_seen',
      },
    ]);
  });

  it('records discovered on a first sighting, then activated by the first read', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);

    const seen = await touchSourceListingSeen(db, identity('2'), '2026-09-04T12:00:00.000Z');
    await touchSourceListingSeen(db, identity('2'), '2026-09-04T13:00:00.000Z');
    await writeSourceListingRevision(
      db,
      identity('2'),
      makeContent(resourceId),
      '2026-09-04T14:00:00.000Z',
    );

    const events = await eventsOf(seen.sourceListing.id);
    expect(events.map(({ from, to, reason }) => ({ from, to, reason }))).toEqual([
      { from: null, to: 'discovered', reason: 'first_seen' },
      { from: 'discovered', to: 'active', reason: 'activated' },
    ]);
    expect(events[1]?.at).toBe('2026-09-04T14:00:00.000Z');
  });

  it('records a missing listing seen again, by a sighting or by a read', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const bySighting = await createTestSourceListing(sourceId, { status: 'missing_suspected' });
    const byRead = await createTestSourceListing(sourceId, { status: 'missing_suspected' });

    await touchSourceListingSeen(
      db,
      {
        sourceId,
        sourceRecordId: bySighting.sourceRecordId,
        canonicalSourceUrl: bySighting.canonicalSourceUrl,
      },
      '2026-02-01T00:00:00.000Z',
    );
    await writeSourceListingRevision(
      db,
      {
        sourceId,
        sourceRecordId: byRead.sourceRecordId,
        canonicalSourceUrl: byRead.canonicalSourceUrl,
      },
      makeContent(resourceId),
      '2026-02-01T00:00:00.000Z',
    );

    const events = await eventsOf(bySighting.id, byRead.id);
    expect(events.map(({ listing, from, to, reason }) => ({ listing, from, to, reason }))).toEqual([
      { listing: bySighting.id, from: 'missing_suspected', to: 'active', reason: 'seen_again' },
      { listing: byRead.id, from: 'missing_suspected', to: 'active', reason: 'seen_again' },
    ]);
  });

  it('records a reopen only when the caller allows it', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const first = await writeSourceListingRevision(
      db,
      identity('3'),
      makeContent(resourceId),
      '2026-09-04T12:00:00.000Z',
    );
    await db
      .update(sourceListings)
      .set({ status: 'closed' })
      .where(eq(sourceListings.id, first.sourceListing.id));

    await writeSourceListingRevision(
      db,
      identity('3'),
      makeContent(resourceId),
      '2026-09-05T12:00:00.000Z',
    );
    const reopened = await writeSourceListingRevision(
      db,
      identity('3'),
      makeContent(resourceId),
      '2026-09-06T12:00:00.000Z',
      { allowReopen: true },
    );

    expect(reopened.reopened).toBe(true);
    const events = await eventsOf(first.sourceListing.id);
    expect(events.map(({ from, to, reason, at }) => ({ from, to, reason, at }))).toEqual([
      { from: null, to: 'active', reason: 'first_seen', at: '2026-09-04T12:00:00.000Z' },
      { from: 'closed', to: 'active', reason: 'reopened', at: '2026-09-06T12:00:00.000Z' },
    ]);
  });

  it('records a quarantine once, and its reopen by a later good read', async () => {
    sourceId = await createTestSource();
    const run = await createTestCrawlRun(sourceId);
    const resourceId = await createTestResource(sourceId);
    const first = await writeSourceListingRevision(
      db,
      identity('4'),
      makeContent(resourceId),
      '2026-09-04T12:00:00.000Z',
    );

    await quarantineSourceListing(db, identity('4'), '2026-09-05T12:00:00.000Z', {
      crawlRunId: run.id,
    });
    await quarantineSourceListing(db, identity('4'), '2026-09-06T12:00:00.000Z');
    // A stale observation changes nothing, so it records nothing.
    await quarantineSourceListing(db, identity('4'), '2026-09-01T12:00:00.000Z');
    await writeSourceListingRevision(
      db,
      identity('4'),
      makeContent(resourceId),
      '2026-09-07T12:00:00.000Z',
      { allowReopen: true },
    );

    const events = await eventsOf(first.sourceListing.id);
    expect(events.map(({ from, to, reason, run }) => ({ from, to, reason, run }))).toEqual([
      { from: null, to: 'active', reason: 'first_seen', run: null },
      { from: 'active', to: 'quarantined', reason: 'quarantined', run: run.id },
      { from: 'quarantined', to: 'active', reason: 'reopened', run: null },
    ]);
  });

  it('records a listing first met by a parse failure as first seen, quarantined', async () => {
    sourceId = await createTestSource();
    const result = await quarantineSourceListing(db, identity('5'), '2026-09-04T12:00:00.000Z');
    const events = await eventsOf(result.sourceListing.id);
    expect(events.map(({ from, to, reason }) => ({ from, to, reason }))).toEqual([
      { from: null, to: 'quarantined', reason: 'first_seen' },
    ]);
  });

  it('refuses an event whose two statuses are equal', async () => {
    sourceId = await createTestSource();
    const listing = await createTestSourceListing(sourceId);
    await expect(
      db.insert(sourceListingStatusEvents).values({
        sourceListingId: listing.id,
        fromStatus: 'active',
        toStatus: 'active',
        at: '2026-01-01T00:00:00Z',
        reason: 'activated',
      }),
    ).rejects.toThrow();
  });
});

describe('status events from reconciliation', () => {
  let sourceId: string;

  afterEach(async () => {
    if (sourceId) await cleanupTestSource(sourceId);
  });

  it('writes one event per row whose status changed, in the same pass, and none on a retry', async () => {
    sourceId = await createTestSource();
    const seen = '2026-01-01T00:00:00Z';
    const goesMissing = await Promise.all(
      [1, 2, 3].map(() => createTestSourceListing(sourceId, { lastSeenAt: seen })),
    );
    // Already missing, one miss to go: the streak advances, the status does not.
    const staysMissing = await createTestSourceListing(sourceId, {
      status: 'missing_suspected',
      missingStreak: 0,
      lastSeenAt: seen,
    });
    const closes = await Promise.all(
      [1, 2].map(() =>
        createTestSourceListing(sourceId, {
          status: 'missing_suspected',
          missingStreak: 2,
          lastSeenAt: seen,
        }),
      ),
    );
    // Seen in this run: untouched.
    const present = await createTestSourceListing(sourceId, {
      lastSeenAt: '2026-01-05T00:30:00Z',
    });
    const run = await createTestCrawlRun(sourceId);

    const result = await closeMissingListings(db, {
      crawlRunId: run.id,
      missingStreakThreshold: 3,
    });
    expect(result).toMatchObject({ missingSuspectedCount: 4, closedCount: 2 });

    const all = [...goesMissing, staysMissing, ...closes, present].map((row) => row.id);
    const events = await eventsOf(...all);
    expect(events).toHaveLength(5);
    expect(
      events
        .filter((event) => event.to === 'missing_suspected')
        .map((event) => event.listing)
        .sort(),
    ).toEqual(goesMissing.map((row) => row.id).sort());
    expect(
      events
        .filter((event) => event.to === 'closed')
        .map((event) => event.listing)
        .sort(),
    ).toEqual(closes.map((row) => row.id).sort());
    for (const event of events) {
      expect(event).toMatchObject({
        at: new Date(run.startedAt).toISOString(),
        run: run.id,
        approximate: false,
      });
      expect(event.reason).toBe(event.to === 'closed' ? 'reconcile_closed' : 'reconcile_missing');
      expect(event.from).toBe(event.to === 'closed' ? 'missing_suspected' : 'active');
    }

    // The events match the rows the pass actually changed.
    const changed = await db
      .select({ id: sourceListings.id, status: sourceListings.status })
      .from(sourceListings)
      .where(inArray(sourceListings.id, all));
    for (const row of changed) {
      const mine = events.filter((event) => event.listing === row.id);
      if (row.id === staysMissing.id || row.id === present.id) expect(mine).toEqual([]);
      else expect(mine.map((event) => event.to)).toEqual([row.status]);
    }

    await closeMissingListings(db, { crawlRunId: run.id, missingStreakThreshold: 3 });
    expect(await eventsOf(...all)).toHaveLength(5);
  });

  it('records nothing for a capped mass closure, whose rows stay missing', async () => {
    sourceId = await createTestSource();
    const rows = await Promise.all(
      Array.from({ length: 30 }, () =>
        createTestSourceListing(sourceId, {
          status: 'missing_suspected',
          missingStreak: 2,
          lastSeenAt: '2026-01-01T00:00:00Z',
        }),
      ),
    );
    const run = await createTestCrawlRun(sourceId);
    const result = await closeMissingListings(db, {
      crawlRunId: run.id,
      missingStreakThreshold: 3,
    });
    expect(result.closureCapped).toBe(true);
    expect(await eventsOf(...rows.map((row) => row.id))).toEqual([]);
  });

  it('records each expiry at the pass instant, with its run, once', async () => {
    sourceId = await createTestSource();
    const run = await createTestCrawlRun(sourceId);
    const overdue = await createTestSourceListing(sourceId, {
      sourceDeadlineAt: '2026-01-10T00:00:00Z',
    });
    const overdueMissing = await createTestSourceListing(sourceId, {
      status: 'missing_suspected',
      sourceDeadlineAt: '2026-01-11T00:00:00Z',
    });
    const notYet = await createTestSourceListing(sourceId, {
      sourceDeadlineAt: '2026-03-01T00:00:00Z',
    });

    const asOf = '2026-02-01T00:00:00.000Z';
    const first = await expireOverdueListings(db, { sourceId, asOf, crawlRunId: run.id });
    const second = await expireOverdueListings(db, { sourceId, asOf });
    expect(first.expiredCount).toBe(2);
    expect(second.expiredCount).toBe(0);

    const events = await eventsOf(overdue.id, overdueMissing.id, notYet.id);
    expect(
      events
        .map(({ listing, from, to, at, run, reason }) => ({ listing, from, to, at, run, reason }))
        .sort((a, b) => a.listing.localeCompare(b.listing)),
    ).toEqual(
      [
        {
          listing: overdue.id,
          from: 'active',
          to: 'expired',
          at: asOf,
          run: run.id,
          reason: 'deadline_expired',
        },
        {
          listing: overdueMissing.id,
          from: 'missing_suspected',
          to: 'expired',
          at: asOf,
          run: run.id,
          reason: 'deadline_expired',
        },
      ].sort((a, b) => a.listing.localeCompare(b.listing)),
    );
  });
});

describe('backfillStatusEvents', () => {
  let sourceId: string;

  afterEach(async () => {
    if (sourceId) await cleanupTestSource(sourceId);
  });

  it('gives every older listing one approximate first event, and a second call writes nothing', async () => {
    sourceId = await createTestSource();
    const first = '2026-01-01T00:00:00.000Z';
    const lastSeen = '2026-01-20T00:00:00.000Z';
    const reconciled = '2026-01-25T00:00:00.000Z';
    const deadline = '2026-01-15T00:00:00.000Z';
    const base = { firstSeenAt: first, lastSeenAt: lastSeen };
    const active = await createTestSourceListing(sourceId, base);
    const missing = await createTestSourceListing(sourceId, {
      ...base,
      status: 'missing_suspected',
    });
    const closed = await createTestSourceListing(sourceId, {
      ...base,
      status: 'closed',
      lastReconciledAt: reconciled,
    });
    const closedUnreconciled = await createTestSourceListing(sourceId, {
      ...base,
      status: 'closed',
    });
    const expired = await createTestSourceListing(sourceId, {
      ...base,
      status: 'expired',
      sourceDeadlineAt: deadline,
    });
    const expiredNoDeadline = await createTestSourceListing(sourceId, {
      ...base,
      status: 'expired',
    });
    const discovered = await createTestSourceListing(sourceId, { ...base, status: 'discovered' });
    const quarantined = await createTestSourceListing(sourceId, {
      ...base,
      status: 'quarantined',
    });

    const result = await backfillStatusEvents(db, { sourceIds: [sourceId] });
    expect(result).toEqual({
      inserted: {
        active: 1,
        missing_suspected: 1,
        closed: 2,
        expired: 2,
        discovered: 1,
        quarantined: 1,
      },
      total: 8,
    });

    const expected = new Map([
      [active.id, ['active', first]],
      [missing.id, ['missing_suspected', first]],
      [closed.id, ['closed', reconciled]],
      [closedUnreconciled.id, ['closed', lastSeen]],
      [expired.id, ['expired', deadline]],
      [expiredNoDeadline.id, ['expired', lastSeen]],
      [discovered.id, ['discovered', first]],
      [quarantined.id, ['quarantined', lastSeen]],
    ]);
    const events = await eventsOf(...expected.keys());
    expect(events).toHaveLength(8);
    for (const event of events) {
      const [to, at] = expected.get(event.listing) ?? [];
      expect(event).toMatchObject({
        from: null,
        to,
        at,
        run: null,
        approximate: true,
        reason: 'backfill',
      });
    }

    expect(await backfillStatusEvents(db, { sourceIds: [sourceId] })).toEqual({
      inserted: {},
      total: 0,
    });
    expect(await eventsOf(...expected.keys())).toHaveLength(8);
  });

  it('backfills a listing that changed since the release with the status it had before, no later than that change', async () => {
    sourceId = await createTestSource();
    const run = await createTestCrawlRun(sourceId);
    // Closed on 01-20 by the old code, reopened on 01-10 by the new code
    // (an earlier instant than its closing time, as a late observation can).
    const reopened = await createTestSourceListing(sourceId, {
      status: 'closed',
      lastSeenAt: '2026-01-20T00:00:00Z',
    });
    await db
      .update(sourceListings)
      .set({ status: 'active' })
      .where(eq(sourceListings.id, reopened.id));
    await db.insert(sourceListingStatusEvents).values({
      sourceListingId: reopened.id,
      fromStatus: 'closed',
      toStatus: 'active',
      at: '2026-01-10T00:00:00Z',
      crawlRunId: run.id,
      reason: 'reopened',
    });
    // Created by the new code: already has its first event.
    const fresh = await writeSourceListingRevision(
      db,
      {
        sourceId,
        sourceRecordId: 'fresh',
        canonicalSourceUrl: 'https://example.invalid/fresh',
      },
      makeContent(await createTestResource(sourceId)),
      '2026-01-12T00:00:00.000Z',
    );

    const result = await backfillStatusEvents(db, { sourceIds: [sourceId] });
    expect(result).toEqual({ inserted: { closed: 1 }, total: 1 });
    const events = await eventsOf(reopened.id, fresh.sourceListing.id);
    expect(
      events.map(({ listing, from, to, at, approximate }) => ({
        listing,
        from,
        to,
        at,
        approximate,
      })),
    ).toEqual([
      {
        listing: reopened.id,
        from: 'closed',
        to: 'active',
        at: '2026-01-10T00:00:00.000Z',
        approximate: false,
      },
      {
        listing: fresh.sourceListing.id,
        from: null,
        to: 'active',
        at: '2026-01-12T00:00:00.000Z',
        approximate: false,
      },
      {
        listing: reopened.id,
        from: null,
        to: 'closed',
        at: '2026-01-10T00:00:00.000Z',
        approximate: true,
      },
    ]);
  });

  it('touches no other source', async () => {
    sourceId = await createTestSource();
    const other = await createTestSource();
    try {
      const mine = await createTestSourceListing(sourceId);
      const theirs = await createTestSourceListing(other);
      await backfillStatusEvents(db, { sourceIds: [sourceId] });
      expect(await eventsOf(mine.id)).toHaveLength(1);
      expect(await eventsOf(theirs.id)).toEqual([]);
      const [count] = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from ${sourceListingStatusEvents} where source_listing_id = ${theirs.id}`,
        )
      ).rows;
      expect(count?.n).toBe(0);
    } finally {
      await cleanupTestSource(other);
    }
  });
});
