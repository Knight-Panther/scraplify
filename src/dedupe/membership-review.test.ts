import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  duplicateCandidates,
  opportunities,
  opportunitySourceMemberships,
} from '../db/schema/index.js';
import {
  cleanupTestSource,
  createTestSource,
  createTestSourceListing,
} from '../db/test-support.js';
import {
  detachListing,
  getLiveMembership,
  getMembershipHistory,
  reassignListing,
  resolveDuplicateCandidate,
  splitListingIntoNewOpportunity,
} from './membership-review.js';

/**
 * These tests exist to justify auto-linking at all. §14.2 permits it only
 * because a wrong merge can be corrected, so "a false merge is genuinely
 * reversible, and the record of it survives" is the property that makes the
 * automatic path acceptable — not a convenience feature.
 */

const ACTOR = { decidedBy: 'human', version: 'operator:test' } as const;

describe('membership review', () => {
  const sourceIds: string[] = [];
  const opportunityIds: string[] = [];
  const listingIds: string[] = [];

  async function makeOpportunity(title: string): Promise<string> {
    const id = randomUUID();
    await db.insert(opportunities).values({
      id,
      type: 'job',
      canonicalTitle: title,
      organizationId: null,
      canonicalStatus: 'active',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-06T12:00:00Z',
      updatedAt: '2026-09-06T12:00:00Z',
    });
    opportunityIds.push(id);
    return id;
  }

  async function makeListing(): Promise<string> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const listing = await createTestSourceListing(sourceId, { status: 'active' });
    listingIds.push(listing.id);
    return listing.id;
  }

  async function addMembership(
    opportunityId: string,
    sourceListingId: string,
    at = '2026-09-06T12:00:00Z',
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(opportunitySourceMemberships).values({
      id,
      opportunityId,
      sourceListingId,
      decision: 'confirmed_same',
      confidence: 0.97,
      evidence: { reasons: ['original automatic merge'] },
      decidedBy: 'ruleset',
      decidedAt: at,
      dedupeModelOrRulesetVersion: 'v1',
      supersededAt: null,
    });
    return id;
  }

  afterEach(async () => {
    if (listingIds.length > 0) {
      await db
        .delete(opportunitySourceMemberships)
        .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
      await db
        .delete(duplicateCandidates)
        .where(inArray(duplicateCandidates.sourceListingIdA, listingIds));
      listingIds.length = 0;
    }
    if (opportunityIds.length > 0) {
      await db.delete(opportunities).where(inArray(opportunities.id, opportunityIds));
      opportunityIds.length = 0;
    }
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  it('detaches a wrongly merged listing and preserves the original decision', async () => {
    const opportunityId = await makeOpportunity('Wrongly merged');
    const listingId = await makeListing();
    const otherListingId = await makeListing();
    const originalId = await addMembership(opportunityId, listingId);
    await addMembership(opportunityId, otherListingId);

    const result = await detachListing(db, {
      sourceListingId: listingId,
      at: '2026-09-06T13:00:00Z',
    });

    expect(result.detachedFrom).toBe(opportunityId);
    // The other listing is still there, so the cluster is not empty.
    expect(result.leftOpportunityEmpty).toBe(false);
    expect(await getLiveMembership(db, listingId)).toBeNull();

    // The original row survives with its evidence — this is the audit trail
    // §12.5 requires, and a DELETE here would destroy exactly the record a
    // human needs to ask why the merge happened.
    const [retired] = await db
      .select()
      .from(opportunitySourceMemberships)
      .where(eq(opportunitySourceMemberships.id, originalId));
    expect(retired).toBeDefined();
    expect(retired?.supersededAt).toBe('2026-09-06 13:00:00+00');
    expect(retired?.decidedBy).toBe('ruleset');
    expect(JSON.stringify(retired?.evidence)).toContain('original automatic merge');
  });

  it('reports when a detach leaves an opportunity with no members', async () => {
    const opportunityId = await makeOpportunity('Sole member');
    const listingId = await makeListing();
    await addMembership(opportunityId, listingId);

    const result = await detachListing(db, {
      sourceListingId: listingId,
      at: '2026-09-06T13:00:00Z',
    });

    expect(result.leftOpportunityEmpty).toBe(true);
    // The empty opportunity is deliberately NOT deleted: retired memberships
    // still reference it, and it is the evidence of a merge that was undone.
    const [still] = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunityId));
    expect(still).toBeDefined();
  });

  it('is a no-op on a listing that belongs to no cluster', async () => {
    const listingId = await makeListing();
    const result = await detachListing(db, {
      sourceListingId: listingId,
      at: '2026-09-06T13:00:00Z',
    });
    expect(result).toEqual({ detachedFrom: null, leftOpportunityEmpty: false });
  });

  it('reassigns a listing to another cluster, retiring the old membership', async () => {
    const from = await makeOpportunity('From');
    const to = await makeOpportunity('To');
    const listingId = await makeListing();
    await addMembership(from, listingId);

    const result = await reassignListing(db, {
      sourceListingId: listingId,
      toOpportunityId: to,
      decision: 'confirmed_same',
      confidence: 1,
      evidence: { reasons: ['operator judged these the same vacancy'] },
      actor: ACTOR,
      at: '2026-09-06T14:00:00Z',
    });

    expect(result.previousOpportunityId).toBe(from);
    const live = await getLiveMembership(db, listingId);
    expect(live?.opportunityId).toBe(to);
    expect(live?.decidedBy).toBe('human');

    // Exactly one live membership, and the history keeps both.
    const history = await getMembershipHistory(db, listingId);
    expect(history).toHaveLength(2);
    expect(history.filter((row) => row.supersededAt === null)).toHaveLength(1);
  });

  it('round-trips: a merge can be undone and redone, leaving a full audit trail', async () => {
    // The property that makes automatic linking acceptable at all.
    const original = await makeOpportunity('Original cluster');
    const listingId = await makeListing();
    await addMembership(original, listingId);

    await detachListing(db, { sourceListingId: listingId, at: '2026-09-06T13:00:00Z' });
    expect(await getLiveMembership(db, listingId)).toBeNull();

    await reassignListing(db, {
      sourceListingId: listingId,
      toOpportunityId: original,
      decision: 'confirmed_same',
      confidence: 1,
      evidence: { reasons: ['operator restored the original merge'] },
      actor: ACTOR,
      at: '2026-09-06T15:00:00Z',
    });

    const live = await getLiveMembership(db, listingId);
    expect(live?.opportunityId).toBe(original);

    // Every step is still on record: the automatic merge, its retirement,
    // and the human restoration.
    const history = await getMembershipHistory(db, listingId);
    expect(history).toHaveLength(2);
    expect(history.filter((row) => row.supersededAt === null)).toHaveLength(1);
    expect(history.map((row) => row.decidedBy).sort()).toEqual(['human', 'ruleset']);
  });

  it('does not churn the audit trail when reassigning to the cluster already held', async () => {
    const opportunityId = await makeOpportunity('Same place');
    const listingId = await makeListing();
    await addMembership(opportunityId, listingId);

    await reassignListing(db, {
      sourceListingId: listingId,
      toOpportunityId: opportunityId,
      decision: 'confirmed_same',
      confidence: 1,
      evidence: {},
      actor: ACTOR,
      at: '2026-09-06T14:00:00Z',
    });

    // A move that never happened must not appear in the history.
    const history = await getMembershipHistory(db, listingId);
    expect(history).toHaveLength(1);
    expect(history[0]?.supersededAt).toBeNull();
  });

  it('refuses to reassign into an opportunity that does not exist', async () => {
    const listingId = await makeListing();
    await expect(
      reassignListing(db, {
        sourceListingId: listingId,
        toOpportunityId: '00000000-0000-0000-0000-000000000000',
        decision: 'confirmed_same',
        confidence: 1,
        evidence: {},
        actor: ACTOR,
        at: '2026-09-06T14:00:00Z',
      }),
    ).rejects.toThrow(/no opportunity/);
    // And the listing is untouched by the failed attempt.
    expect(await getLiveMembership(db, listingId)).toBeNull();
  });

  it('splits a listing out into its own opportunity', async () => {
    const merged = await makeOpportunity('Wrongly merged pair');
    const listingId = await makeListing();
    const otherListingId = await makeListing();
    await addMembership(merged, listingId);
    await addMembership(merged, otherListingId);

    const result = await splitListingIntoNewOpportunity(db, {
      sourceListingId: listingId,
      canonicalTitle: 'Actually a different job',
      type: 'job',
      evidence: { reasons: ['operator judged these different vacancies'] },
      actor: ACTOR,
      at: '2026-09-06T14:00:00Z',
    });
    opportunityIds.push(result.opportunityId);

    expect(result.previousOpportunityId).toBe(merged);
    const live = await getLiveMembership(db, listingId);
    expect(live?.opportunityId).toBe(result.opportunityId);
    expect(live?.decidedBy).toBe('human');

    // The other listing stays where it was — a split moves one listing only.
    const otherLive = await getLiveMembership(db, otherListingId);
    expect(otherLive?.opportunityId).toBe(merged);
  });

  it('keeps at most one live membership per listing through every operation', async () => {
    // The invariant the partial unique index enforces, exercised through the
    // full sequence rather than asserted once.
    const a = await makeOpportunity('A');
    const b = await makeOpportunity('B');
    const listingId = await makeListing();
    await addMembership(a, listingId);

    await reassignListing(db, {
      sourceListingId: listingId,
      toOpportunityId: b,
      decision: 'probable_same',
      confidence: 0.8,
      evidence: {},
      actor: ACTOR,
      at: '2026-09-06T14:00:00Z',
    });
    await detachListing(db, { sourceListingId: listingId, at: '2026-09-06T15:00:00Z' });
    const split = await splitListingIntoNewOpportunity(db, {
      sourceListingId: listingId,
      canonicalTitle: 'Standalone',
      type: 'job',
      evidence: {},
      actor: ACTOR,
      at: '2026-09-06T16:00:00Z',
    });
    opportunityIds.push(split.opportunityId);

    const history = await getMembershipHistory(db, listingId);
    expect(history.filter((row) => row.supersededAt === null)).toHaveLength(1);
    expect(history.length).toBeGreaterThanOrEqual(3);
  });

  it('resolves a duplicate candidate without touching membership', async () => {
    const listingA = await makeListing();
    const listingB = await makeListing();
    const [a, b] = [listingA, listingB].sort() as [string, string];
    const candidateId = randomUUID();
    await db.insert(duplicateCandidates).values({
      id: candidateId,
      sourceListingIdA: a,
      sourceListingIdB: b,
      generatedAt: '2026-09-06T12:00:00Z',
      generationMethod: 'deterministic_match',
      similarityScore: 0.9,
      status: 'pending',
      resultingDecision: null,
    });

    await resolveDuplicateCandidate(db, { candidateId, decision: 'distinct' });

    const [row] = await db
      .select()
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.id, candidateId));
    expect(row?.status).toBe('evaluated');
    expect(row?.resultingDecision).toBe('distinct');
    // Settling the question must not have clustered anything.
    expect(await getLiveMembership(db, a)).toBeNull();
    expect(await getLiveMembership(db, b)).toBeNull();
  });

  it('rejects resolving a candidate that does not exist', async () => {
    await expect(
      resolveDuplicateCandidate(db, {
        candidateId: '00000000-0000-0000-0000-000000000000',
        decision: 'distinct',
      }),
    ).rejects.toThrow(/no candidate/);
  });
});
