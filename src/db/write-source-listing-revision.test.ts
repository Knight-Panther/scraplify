import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResourceId } from '../domain/ids.js';
import { db } from './client.js';
import { sourceListingRevisions, sourceListings } from './schema/index.js';
import { cleanupTestSource, createTestResource, createTestSource } from './test-support.js';
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
    titleRaw: 'Software Engineer',
    titleNormalized: 'software engineer',
    organizationRaw: 'Acme',
    description: 'A great job',
    locations: ['Tbilisi'],
    salaryRaw: null,
    publishedDate: { raw: '2026-09-01', parsed: '2026-09-01T00:00:00Z' },
    deadlineDate: { raw: '2026-10-01', parsed: '2026-10-01T00:00:00Z' },
    applicationMethod: { type: 'email', value: 'jobs@acme.example' },
    sourceCategories: ['IT'],
    structuredAttributes: {},
    provenance: {
      fetchedAt: '2026-09-04T12:00:00Z',
      resourceId: resourceId as ResourceId,
      notes: null,
    },
    ...overrides,
  };
}

describe('writeSourceListingRevision', () => {
  let sourceId: string;

  afterEach(async () => {
    if (sourceId) await cleanupTestSource(sourceId);
  });

  it('creates a listing and its first revision, reporting "new"', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const content = makeContent(resourceId);

    const result = await writeSourceListingRevision(
      db,
      {
        sourceId,
        sourceRecordId: '12345',
        canonicalSourceUrl: 'https://example.invalid/?id=12345',
      },
      content,
      '2026-09-04T12:00:00Z',
    );

    expect(result.outcome).toBe('new');
    expect(result.sourceListing.status).toBe('active');
    expect(result.sourceListing.currentRevisionId).toBe(result.revision.id);
    expect(result.revision.meaningfulContentHash).toBe(content.meaningfulContentHash);
  });

  it('reports "unchanged" and does not insert a second revision when the hash matches', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/?id=12345',
    };
    const content = makeContent(resourceId);

    const first = await writeSourceListingRevision(db, identity, content, '2026-09-04T12:00:00Z');
    const second = await writeSourceListingRevision(db, identity, content, '2026-09-05T12:00:00Z');

    expect(second.outcome).toBe('unchanged');
    expect(second.revision.id).toBe(first.revision.id);
    expect(second.sourceListing.lastSeenAt).toContain('2026-09-05');

    const revisions = await db
      .select()
      .from(sourceListingRevisions)
      .where(eq(sourceListingRevisions.sourceListingId, first.sourceListing.id));
    expect(revisions).toHaveLength(1);
  });

  it('reports "changed" and inserts a new revision when the hash differs', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/?id=12345',
    };

    const first = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId, { meaningfulContentHash: 'b'.repeat(64) }),
      '2026-09-04T12:00:00Z',
    );
    const second = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId, {
        meaningfulContentHash: 'c'.repeat(64),
        titleRaw: 'Senior Software Engineer',
      }),
      '2026-09-05T12:00:00Z',
    );

    expect(second.outcome).toBe('changed');
    expect(second.revision.id).not.toBe(first.revision.id);
    expect(second.sourceListing.currentRevisionId).toBe(second.revision.id);

    const revisions = await db
      .select()
      .from(sourceListingRevisions)
      .where(eq(sourceListingRevisions.sourceListingId, first.sourceListing.id));
    expect(revisions).toHaveLength(2);
  });

  it('creates a new revision when content reverts to an earlier hash (A -> B -> A)', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/?id=12345',
    };

    const a1 = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId, { meaningfulContentHash: 'a'.repeat(64) }),
      '2026-09-01T00:00:00Z',
    );
    await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId, { meaningfulContentHash: 'b'.repeat(64) }),
      '2026-09-02T00:00:00Z',
    );
    const a2 = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId, { meaningfulContentHash: 'a'.repeat(64) }),
      '2026-09-03T00:00:00Z',
    );

    expect(a2.outcome).toBe('changed');
    expect(a2.revision.id).not.toBe(a1.revision.id);
    expect(a2.revision.meaningfulContentHash).toBe('a'.repeat(64));

    const revisions = await db
      .select()
      .from(sourceListingRevisions)
      .where(eq(sourceListingRevisions.sourceListingId, a1.sourceListing.id));
    expect(revisions).toHaveLength(3);
  });

  it('falls back to canonicalSourceUrl identity when sourceRecordId is null', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const identity = {
      sourceId,
      sourceRecordId: null,
      canonicalSourceUrl: 'https://example.invalid/no-stable-id',
    };

    const first = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId),
      '2026-09-04T12:00:00Z',
    );
    const second = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId),
      '2026-09-05T12:00:00Z',
    );

    expect(first.sourceListing.id).toBe(second.sourceListing.id);
    expect(second.outcome).toBe('unchanged');
  });

  it('does not reactivate a quarantined listing on a positive observation', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/?id=12345',
    };

    const first = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId),
      '2026-09-04T12:00:00Z',
    );
    await db
      .update(sourceListings)
      .set({ status: 'quarantined' })
      .where(eq(sourceListings.id, first.sourceListing.id));

    const second = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId, { meaningfulContentHash: 'c'.repeat(64) }),
      '2026-09-05T12:00:00Z',
    );

    expect(second.sourceListing.status).toBe('quarantined');
  });

  it.each(['closed', 'expired'] as const)(
    'does not reactivate a %s listing on a fresh, non-stale positive observation',
    async (status) => {
      sourceId = await createTestSource();
      const resourceId = await createTestResource(sourceId);
      const identity = {
        sourceId,
        sourceRecordId: '12345',
        canonicalSourceUrl: 'https://example.invalid/?id=12345',
      };

      const first = await writeSourceListingRevision(
        db,
        identity,
        makeContent(resourceId),
        '2026-09-04T12:00:00Z',
      );
      await db
        .update(sourceListings)
        .set({ status })
        .where(eq(sourceListings.id, first.sourceListing.id));

      // Strictly newer than the prior write, and different content — not
      // stale, but still must not silently flip a completed lifecycle
      // decision back to 'active' on its own.
      const second = await writeSourceListingRevision(
        db,
        identity,
        makeContent(resourceId, { meaningfulContentHash: 'c'.repeat(64) }),
        '2026-09-05T12:00:00Z',
      );

      expect(second.sourceListing.status).toBe(status);
      expect(second.reopened).toBe(false);
    },
  );

  it.each(['closed', 'expired'] as const)(
    'reactivates a %s listing when options.allowReopen is true',
    async (status) => {
      sourceId = await createTestSource();
      const resourceId = await createTestResource(sourceId);
      const identity = {
        sourceId,
        sourceRecordId: '12345',
        canonicalSourceUrl: 'https://example.invalid/?id=12345',
      };

      const first = await writeSourceListingRevision(
        db,
        identity,
        makeContent(resourceId),
        '2026-09-04T12:00:00Z',
      );
      await db
        .update(sourceListings)
        .set({ status })
        .where(eq(sourceListings.id, first.sourceListing.id));

      const second = await writeSourceListingRevision(
        db,
        identity,
        makeContent(resourceId, { meaningfulContentHash: 'c'.repeat(64) }),
        '2026-09-05T12:00:00Z',
        { allowReopen: true },
      );

      expect(second.sourceListing.status).toBe('active');
      expect(second.reopened).toBe(true);
    },
  );

  it('does not report reopened for a listing that was already active, even with allowReopen true', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/?id=12345',
    };

    const first = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId),
      '2026-09-04T12:00:00Z',
      { allowReopen: true },
    );
    expect(first.reopened).toBe(false);

    const second = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId, { meaningfulContentHash: 'c'.repeat(64) }),
      '2026-09-05T12:00:00Z',
      { allowReopen: true },
    );
    expect(second.sourceListing.status).toBe('active');
    expect(second.reopened).toBe(false);
  });

  it.each(['discovered', 'missing_suspected'] as const)(
    'does reactivate a %s listing to active on a positive observation',
    async (status) => {
      sourceId = await createTestSource();
      const resourceId = await createTestResource(sourceId);
      const identity = {
        sourceId,
        sourceRecordId: '12345',
        canonicalSourceUrl: 'https://example.invalid/?id=12345',
      };

      const first = await writeSourceListingRevision(
        db,
        identity,
        makeContent(resourceId),
        '2026-09-04T12:00:00Z',
      );
      await db
        .update(sourceListings)
        .set({ status })
        .where(eq(sourceListings.id, first.sourceListing.id));

      const second = await writeSourceListingRevision(
        db,
        identity,
        makeContent(resourceId, { meaningfulContentHash: 'c'.repeat(64) }),
        '2026-09-05T12:00:00Z',
      );

      expect(second.sourceListing.status).toBe('active');
    },
  );

  it('corrects firstSeenAt backward when a delayed, older first sighting is rejected as stale', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/?id=12345',
    };

    const newer = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId),
      '2026-09-05T00:00:00Z',
    );
    expect(newer.sourceListing.firstSeenAt).toContain('2026-09-05');

    // A delayed report of an earlier fetch than the one that actually
    // created the listing above.
    const olderFirstSighting = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId, { meaningfulContentHash: 'c'.repeat(64) }),
      '2026-09-04T00:00:00Z',
    );

    expect(olderFirstSighting.outcome).toBe('stale');
    expect(olderFirstSighting.sourceListing.firstSeenAt).toContain('2026-09-04');
    // Content/currentRevisionId are still untouched — only the audit field moved.
    expect(olderFirstSighting.sourceListing.currentRevisionId).toBe(newer.revision.id);
  });

  it('refreshes canonicalSourceUrl for a stable-sourceRecordId listing whose URL changed', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/old-slug?id=12345',
    };

    const first = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId),
      '2026-09-04T12:00:00Z',
    );
    expect(first.sourceListing.canonicalSourceUrl).toBe(identity.canonicalSourceUrl);

    const second = await writeSourceListingRevision(
      db,
      { ...identity, canonicalSourceUrl: 'https://example.invalid/new-slug?id=12345' },
      makeContent(resourceId, { meaningfulContentHash: 'c'.repeat(64) }),
      '2026-09-05T12:00:00Z',
    );

    expect(second.sourceListing.id).toBe(first.sourceListing.id);
    expect(second.sourceListing.canonicalSourceUrl).toBe(
      'https://example.invalid/new-slug?id=12345',
    );
  });

  it('rejects an out-of-order observation as "stale" instead of overwriting newer state', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/?id=12345',
    };

    const newer = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId, { meaningfulContentHash: 'b'.repeat(64) }),
      '2026-09-05T00:00:00Z',
    );

    // A late-arriving retry of an OLDER fetch, observed before the one
    // above but landing after it (e.g. a slow retry racing a fresh crawl).
    const stale = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId, { meaningfulContentHash: 'c'.repeat(64) }),
      '2026-09-04T00:00:00Z',
    );

    expect(stale.outcome).toBe('stale');
    expect(stale.sourceListing.currentRevisionId).toBe(newer.revision.id);
    expect(stale.sourceListing.lastSeenAt).toContain('2026-09-05');

    const revisions = await db
      .select()
      .from(sourceListingRevisions)
      .where(eq(sourceListingRevisions.sourceListingId, newer.sourceListing.id));
    expect(revisions).toHaveLength(1);
  });

  it('does not reactivate a closed listing via a stale same-hash retry', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/?id=12345',
    };

    const first = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId),
      '2026-09-04T00:00:00Z',
    );
    // Simulates a later reconciliation run (src/db/reconcile-source-listings.ts)
    // closing the listing after observing it missing.
    await db
      .update(sourceListings)
      .set({ status: 'closed', lastSeenAt: '2026-09-06T00:00:00Z' })
      .where(eq(sourceListings.id, first.sourceListing.id));

    // Same content as `first`, but an observedAt older than the closure
    // above — e.g. a slow retry of the original fetch landing late.
    const stale = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId),
      '2026-09-05T00:00:00Z',
    );

    expect(stale.outcome).toBe('stale');
    expect(stale.sourceListing.status).toBe('closed');
    expect(stale.sourceListing.lastSeenAt).toContain('2026-09-06');
  });

  it('serializes two concurrent writers for the same new listing into one revision', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const identity = {
      sourceId,
      sourceRecordId: '99999',
      canonicalSourceUrl: 'https://example.invalid/?id=99999',
    };
    const content = makeContent(resourceId);
    // Same observedAt for both — realistic for two workers in one crawl run
    // observing the same listing — so the race outcome is deterministic: a
    // tie is never "stale" (see writeSourceListingRevision's staleness
    // check), regardless of which writer's transaction commits first.
    const observedAt = '2026-09-04T12:00:00Z';

    const [first, second] = await Promise.all([
      writeSourceListingRevision(db, identity, content, observedAt),
      writeSourceListingRevision(db, identity, content, observedAt),
    ]);

    expect(first.sourceListing.id).toBe(second.sourceListing.id);
    expect(first.revision.id).toBe(second.revision.id);
    expect([first.outcome, second.outcome].sort()).toEqual(['new', 'unchanged']);

    const listings = await db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.sourceId, sourceId));
    expect(listings).toHaveLength(1);

    const revisions = await db
      .select()
      .from(sourceListingRevisions)
      .where(eq(sourceListingRevisions.sourceListingId, first.sourceListing.id));
    expect(revisions).toHaveLength(1);
  });
});

describe('touchSourceListingSeen', () => {
  let sourceId: string;

  afterEach(async () => {
    if (sourceId) await cleanupTestSource(sourceId);
  });

  it('creates a discovered listing with no revision on a first-ever touch', async () => {
    sourceId = await createTestSource();
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/?id=12345',
    };

    const result = await touchSourceListingSeen(db, identity, '2026-09-05T12:00:00Z');

    expect(result.stale).toBe(false);
    expect(result.sourceListing.status).toBe('discovered');
    expect(result.sourceListing.currentRevisionId).toBeNull();
    expect(result.sourceListing.lastSeenAt).toContain('2026-09-05');
  });

  it('reactivates a missing_suspected listing around its last-known-good content', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/?id=12345',
    };

    const first = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId),
      '2026-09-01T00:00:00Z',
    );
    await db
      .update(sourceListings)
      .set({ status: 'missing_suspected', missingStreak: 2 })
      .where(eq(sourceListings.id, first.sourceListing.id));

    const result = await touchSourceListingSeen(db, identity, '2026-09-05T12:00:00Z');

    expect(result.sourceListing.status).toBe('active');
    expect(result.sourceListing.missingStreak).toBe(0);
    expect(result.sourceListing.currentRevisionId).toBe(first.revision.id); // untouched — same last-known-good content
  });

  it('bumps lastSeenAt for an active listing without changing its status', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/?id=12345',
    };

    await writeSourceListingRevision(db, identity, makeContent(resourceId), '2026-09-01T00:00:00Z');

    const result = await touchSourceListingSeen(db, identity, '2026-09-05T12:00:00Z');

    expect(result.sourceListing.status).toBe('active');
    expect(result.sourceListing.lastSeenAt).toContain('2026-09-05');
  });

  it.each(['closed', 'expired', 'quarantined'] as const)(
    'does not reactivate a %s listing — a mere index sighting is not confirmed reappearance',
    async (status) => {
      sourceId = await createTestSource();
      const resourceId = await createTestResource(sourceId);
      const identity = {
        sourceId,
        sourceRecordId: '12345',
        canonicalSourceUrl: 'https://example.invalid/?id=12345',
      };

      const first = await writeSourceListingRevision(
        db,
        identity,
        makeContent(resourceId),
        '2026-09-01T00:00:00Z',
      );
      await db
        .update(sourceListings)
        .set({ status })
        .where(eq(sourceListings.id, first.sourceListing.id));

      const result = await touchSourceListingSeen(db, identity, '2026-09-05T12:00:00Z');

      expect(result.sourceListing.status).toBe(status);
    },
  );

  it('rejects an out-of-order touch as stale, matching writeSourceListingRevision', async () => {
    sourceId = await createTestSource();
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/?id=12345',
    };

    const newer = await touchSourceListingSeen(db, identity, '2026-09-05T00:00:00Z');
    const stale = await touchSourceListingSeen(db, identity, '2026-09-04T00:00:00Z');

    expect(stale.stale).toBe(true);
    expect(stale.sourceListing.lastSeenAt).toBe(newer.sourceListing.lastSeenAt);
  });
});

describe('quarantineSourceListing', () => {
  let sourceId: string;

  afterEach(async () => {
    if (sourceId) await cleanupTestSource(sourceId);
  });

  it('creates a quarantined listing with no revision on a first-ever quarantine', async () => {
    sourceId = await createTestSource();
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/?id=12345',
    };

    const result = await quarantineSourceListing(db, identity, '2026-09-05T12:00:00Z');

    expect(result.stale).toBe(false);
    expect(result.sourceListing.status).toBe('quarantined');
    expect(result.sourceListing.currentRevisionId).toBeNull();
  });

  it.each(['active', 'missing_suspected', 'closed', 'expired'] as const)(
    'overrides a %s listing to quarantined unconditionally',
    async (status) => {
      sourceId = await createTestSource();
      const resourceId = await createTestResource(sourceId);
      const identity = {
        sourceId,
        sourceRecordId: '12345',
        canonicalSourceUrl: 'https://example.invalid/?id=12345',
      };

      const first = await writeSourceListingRevision(
        db,
        identity,
        makeContent(resourceId),
        '2026-09-01T00:00:00Z',
      );
      await db
        .update(sourceListings)
        .set({ status })
        .where(eq(sourceListings.id, first.sourceListing.id));

      const result = await quarantineSourceListing(db, identity, '2026-09-05T12:00:00Z');

      expect(result.sourceListing.status).toBe('quarantined');
    },
  );

  it('does not reset missingStreak', async () => {
    sourceId = await createTestSource();
    const resourceId = await createTestResource(sourceId);
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/?id=12345',
    };

    const first = await writeSourceListingRevision(
      db,
      identity,
      makeContent(resourceId),
      '2026-09-01T00:00:00Z',
    );
    await db
      .update(sourceListings)
      .set({ status: 'missing_suspected', missingStreak: 2 })
      .where(eq(sourceListings.id, first.sourceListing.id));

    const result = await quarantineSourceListing(db, identity, '2026-09-05T12:00:00Z');

    expect(result.sourceListing.status).toBe('quarantined');
    expect(result.sourceListing.missingStreak).toBe(2);
  });

  it('rejects an out-of-order quarantine as stale', async () => {
    sourceId = await createTestSource();
    const identity = {
      sourceId,
      sourceRecordId: '12345',
      canonicalSourceUrl: 'https://example.invalid/?id=12345',
    };

    const newer = await quarantineSourceListing(db, identity, '2026-09-05T00:00:00Z');
    const stale = await quarantineSourceListing(db, identity, '2026-09-04T00:00:00Z');

    expect(stale.stale).toBe(true);
    expect(stale.sourceListing.lastSeenAt).toBe(newer.sourceListing.lastSeenAt);
  });
});
