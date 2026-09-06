import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  opportunities,
  opportunityRevisions,
  opportunitySourceMemberships,
  sourceListingRevisions,
  sourceListings,
} from '../db/schema/index.js';
import {
  cleanupTestSource,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../db/test-support.js';
import { resolveCanonicalOpportunity } from './resolve-canonical.js';

/**
 * These cover the four separate stale-state defects a single resolver
 * replaced (adversarial review, 2026-09-06). Each was the same underlying
 * mistake — canonical state derived from a caller's local view rather than
 * from the cluster's real membership — so the tests assert against the
 * membership, never against what a caller passed.
 */

describe('resolveCanonicalOpportunity', () => {
  const sourceIds: string[] = [];
  const opportunityIds: string[] = [];
  const listingIds: string[] = [];

  async function addListing(
    sourceId: string,
    spec: { title: string; status?: 'active' | 'closed' | 'expired' | 'missing_suspected' },
  ): Promise<{ listingId: string; revisionId: string }> {
    const listing = await createTestSourceListing(sourceId, { status: spec.status ?? 'active' });
    const resourceId = await createTestResource(sourceId);
    const revisionId = randomUUID();
    await db.insert(sourceListingRevisions).values({
      id: revisionId,
      sourceListingId: listing.id,
      parserVersion: 'test-v1',
      extractionMethod: 'http',
      rawResourceHash: 'a'.repeat(64),
      meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      titleRaw: spec.title,
      titleNormalized: spec.title.toLowerCase(),
      organizationRaw: 'Canonical Test Org',
      description: 'description',
      locations: [],
      publishedDate: { raw: '', parsed: '2026-09-01T00:00:00Z' },
      deadlineDate: { raw: '', parsed: '2026-12-01T00:00:00Z' },
      applicationMethod: null,
      sourceCategories: [],
      structuredAttributes: {},
      createdAt: '2026-09-01T00:00:00Z',
      provenanceResourceId: resourceId,
      provenanceFetchedAt: '2026-09-01T00:00:00Z',
      provenanceNotes: null,
    });
    await db
      .update(sourceListings)
      .set({ currentRevisionId: revisionId })
      .where(eq(sourceListings.id, listing.id));
    listingIds.push(listing.id);
    return { listingId: listing.id, revisionId };
  }

  async function makeOpportunity(): Promise<string> {
    const id = randomUUID();
    await db.insert(opportunities).values({
      id,
      type: 'job',
      canonicalTitle: 'placeholder',
      organizationId: null,
      canonicalStatus: 'active',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-06T12:00:00Z',
      updatedAt: '2026-09-06T12:00:00Z',
    });
    opportunityIds.push(id);
    return id;
  }

  async function addMember(opportunityId: string, listingId: string): Promise<void> {
    await db.insert(opportunitySourceMemberships).values({
      id: randomUUID(),
      opportunityId,
      sourceListingId: listingId,
      decision: 'confirmed_same',
      confidence: 1,
      evidence: {},
      decidedBy: 'ruleset',
      decidedAt: '2026-09-06T12:00:00Z',
      dedupeModelOrRulesetVersion: 'v1',
      supersededAt: null,
    });
  }

  afterEach(async () => {
    if (listingIds.length > 0) {
      await db
        .delete(opportunitySourceMemberships)
        .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
      listingIds.length = 0;
    }
    if (opportunityIds.length > 0) {
      await db
        .update(opportunities)
        .set({ currentCanonicalRevisionId: null })
        .where(inArray(opportunities.id, opportunityIds));
      await db
        .delete(opportunityRevisions)
        .where(inArray(opportunityRevisions.opportunityId, opportunityIds));
      await db.delete(opportunities).where(inArray(opportunities.id, opportunityIds));
      opportunityIds.length = 0;
    }
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  it('builds a revision and syncs the denormalized columns together', () => {
    // Browsing and ranking read title and status straight off `opportunities`,
    // so repointing the revision without updating those leaves the change
    // recorded and invisible at the same time.
    return db.transaction(async (tx) => {
      const source = await createTestSource();
      sourceIds.push(source);
      const opportunityId = await makeOpportunity();
      const { listingId } = await addListing(source, { title: 'Resolved title' });
      await addMember(opportunityId, listingId);

      const result = await resolveCanonicalOpportunity(tx, opportunityId, '2026-09-06T13:00:00Z');
      expect(result.refreshed).toBe(true);
      expect(result.liveMemberCount).toBe(1);

      const [row] = await tx
        .select()
        .from(opportunities)
        .where(eq(opportunities.id, opportunityId));
      expect(row?.canonicalTitle).toBe('Resolved title');
      expect(row?.currentCanonicalRevisionId).toBe(result.revisionId);
    });
  });

  it('appends a new revision when a member is added, keeping the old one', async () => {
    const sourceA = await createTestSource();
    const sourceB = await createTestSource();
    sourceIds.push(sourceA, sourceB);
    const opportunityId = await makeOpportunity();
    const first = await addListing(sourceA, { title: 'First member' });
    await addMember(opportunityId, first.listingId);
    await db.transaction((tx) =>
      resolveCanonicalOpportunity(tx, opportunityId, '2026-09-06T13:00:00Z'),
    );

    const second = await addListing(sourceB, { title: 'Second member' });
    await addMember(opportunityId, second.listingId);
    const after = await db.transaction((tx) =>
      resolveCanonicalOpportunity(tx, opportunityId, '2026-09-06T14:00:00Z'),
    );

    expect(after.refreshed).toBe(true);
    expect(after.liveMemberCount).toBe(2);
    // Revisions are immutable and append-only (§12.4) — the earlier one stays.
    const revisions = await db
      .select()
      .from(opportunityRevisions)
      .where(eq(opportunityRevisions.opportunityId, opportunityId));
    expect(revisions).toHaveLength(2);
  });

  it('resolves the full cluster, not just a caller-supplied pair', async () => {
    // The specific defect: a refresh triggered by one scored pair rewrote the
    // revision from those two members and silently dropped every other live
    // member. The resolver reads the membership itself, so it cannot.
    const sources = await Promise.all([createTestSource(), createTestSource(), createTestSource()]);
    sourceIds.push(...sources);
    const opportunityId = await makeOpportunity();
    for (const [index, source] of sources.entries()) {
      const { listingId } = await addListing(source, { title: `Member ${index}` });
      await addMember(opportunityId, listingId);
    }

    const result = await db.transaction((tx) =>
      resolveCanonicalOpportunity(tx, opportunityId, '2026-09-06T13:00:00Z'),
    );

    expect(result.liveMemberCount).toBe(3);
    const [revision] = await db
      .select()
      .from(opportunityRevisions)
      .where(eq(opportunityRevisions.id, result.revisionId as string));
    expect(Object.keys(revision?.sourceMembershipVersions as object)).toHaveLength(3);
  });

  it('does not present a cluster of closed listings as active', async () => {
    // The user-visible failure: a dead vacancy shown as recommendable.
    const source = await createTestSource();
    sourceIds.push(source);
    const opportunityId = await makeOpportunity();
    const { listingId } = await addListing(source, { title: 'Dead role', status: 'closed' });
    await addMember(opportunityId, listingId);

    await db.transaction((tx) =>
      resolveCanonicalOpportunity(tx, opportunityId, '2026-09-06T13:00:00Z'),
    );

    const [row] = await db.select().from(opportunities).where(eq(opportunities.id, opportunityId));
    expect(row?.canonicalStatus).toBe('closed');
  });

  it('is as available as its most available member', async () => {
    // If one board still lists it, a candidate can still apply — so a mixed
    // cluster must not read closed.
    const sourceA = await createTestSource();
    const sourceB = await createTestSource();
    sourceIds.push(sourceA, sourceB);
    const opportunityId = await makeOpportunity();
    const open = await addListing(sourceA, { title: 'Still open', status: 'active' });
    const shut = await addListing(sourceB, { title: 'Shut here', status: 'closed' });
    await addMember(opportunityId, open.listingId);
    await addMember(opportunityId, shut.listingId);

    await db.transaction((tx) =>
      resolveCanonicalOpportunity(tx, opportunityId, '2026-09-06T13:00:00Z'),
    );

    const [row] = await db.select().from(opportunities).where(eq(opportunities.id, opportunityId));
    expect(row?.canonicalStatus).toBe('active');
  });

  it('is idempotent — resolving unchanged state appends nothing', async () => {
    const source = await createTestSource();
    sourceIds.push(source);
    const opportunityId = await makeOpportunity();
    const { listingId } = await addListing(source, { title: 'Stable' });
    await addMember(opportunityId, listingId);

    await db.transaction((tx) =>
      resolveCanonicalOpportunity(tx, opportunityId, '2026-09-06T13:00:00Z'),
    );
    const second = await db.transaction((tx) =>
      resolveCanonicalOpportunity(tx, opportunityId, '2026-09-06T14:00:00Z'),
    );

    expect(second.refreshed).toBe(false);
    const revisions = await db
      .select()
      .from(opportunityRevisions)
      .where(eq(opportunityRevisions.opportunityId, opportunityId));
    expect(revisions).toHaveLength(1);
  });

  it('marks an emptied opportunity closed without inventing a revision', async () => {
    const source = await createTestSource();
    sourceIds.push(source);
    const opportunityId = await makeOpportunity();
    const { listingId } = await addListing(source, { title: 'Soon detached' });
    await addMember(opportunityId, listingId);
    await db.transaction((tx) =>
      resolveCanonicalOpportunity(tx, opportunityId, '2026-09-06T13:00:00Z'),
    );

    // Retire the only membership, as a review correction would.
    await db
      .update(opportunitySourceMemberships)
      .set({ supersededAt: '2026-09-06T14:00:00Z' })
      .where(eq(opportunitySourceMemberships.sourceListingId, listingId));

    const result = await db.transaction((tx) =>
      resolveCanonicalOpportunity(tx, opportunityId, '2026-09-06T14:00:00Z'),
    );

    expect(result.liveMemberCount).toBe(0);
    const [row] = await db.select().from(opportunities).where(eq(opportunities.id, opportunityId));
    expect(row?.canonicalStatus).toBe('closed');
    // No empty revision asserting content that no source supports.
    const revisions = await db
      .select()
      .from(opportunityRevisions)
      .where(eq(opportunityRevisions.opportunityId, opportunityId));
    expect(revisions).toHaveLength(1);
  });
});
