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
  acceptDuplicateCandidate,
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

  /** A pair waiting to be judged, which is the only state accept works on. */
  async function pendingCandidate(a: string, b: string): Promise<string> {
    const candidateId = randomUUID();
    await db.insert(duplicateCandidates).values({
      id: candidateId,
      sourceListingIdA: a,
      sourceListingIdB: b,
      generatedAt: '2026-09-08T12:00:00Z',
      generationMethod: 'deterministic_match',
      similarityScore: 0.9,
      status: 'pending',
      resultingDecision: 'needs_review',
      evidence: {},
    });
    return candidateId;
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

  /**
   * "Accept" is a composite verb — move the listing AND settle the candidate —
   * and it used to be two public calls, each opening its own transaction. A
   * crash between them left the merge applied and the pair still pending, so
   * the next dedupe pass re-queued a decision the reviewer had already made,
   * with the cluster changed underneath them.
   */
  it('accepts a candidate as one atomic act', async () => {
    const target = await makeOpportunity('Accept target');
    const listingA = await makeListing();
    const listingB = await makeListing();
    const [a, b] = [listingA, listingB].sort() as [string, string];
    // The OTHER side already lives in the target — that is what makes this
    // opportunity the right place to accept the pair into.
    await addMembership(target, b, '2026-09-08T12:00:00Z');
    const candidateId = randomUUID();
    await db.insert(duplicateCandidates).values({
      id: candidateId,
      sourceListingIdA: a,
      sourceListingIdB: b,
      generatedAt: '2026-09-08T12:00:00Z',
      generationMethod: 'deterministic_match',
      similarityScore: 0.9,
      status: 'pending',
      resultingDecision: 'needs_review',
      evidence: { reasons: ['shared application value'], signals: { titleSimilarity: 1 } },
    });

    await acceptDuplicateCandidate(db, {
      candidateId,
      sourceListingId: a,
      toOpportunityId: target,
      confidence: 0.95,
      evidence: { reasons: ['reviewer accepted the pair'] },
      actor: ACTOR,
      at: '2026-09-08T13:00:00Z',
    });

    // Both facts, together: the listing moved...
    const membership = await getLiveMembership(db, a);
    expect(membership?.opportunityId).toBe(target);
    expect(membership?.decidedBy).toBe('human');

    // ...and the candidate is settled, so the next pass will not re-queue it.
    const [candidate] = await db
      .select()
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.id, candidateId));
    expect(candidate?.resultingDecision).toBe('confirmed_same');
    expect(candidate?.decidedBy).toBe('human');
    expect(candidate?.status).toBe('evaluated');
  });

  /**
   * The arguments used to be trusted. A stale form or a mistaken caller could
   * accept candidate X while moving a listing that had nothing to do with it,
   * leaving the cluster and the candidate row describing different facts —
   * each internally consistent and jointly wrong.
   */
  it('refuses a listing that is not part of the candidate', async () => {
    const target = await makeOpportunity('Identity target');
    const inPair = await makeListing();
    const alsoInPair = await makeListing();
    const unrelated = await makeListing();
    const [a, b] = [inPair, alsoInPair].sort() as [string, string];
    await addMembership(target, b, '2026-09-08T12:00:00Z');
    const candidateId = await pendingCandidate(a, b);

    await expect(
      acceptDuplicateCandidate(db, {
        candidateId,
        sourceListingId: unrelated,
        toOpportunityId: target,
        confidence: 0.95,
        evidence: {},
        actor: ACTOR,
        at: '2026-09-08T13:00:00Z',
      }),
    ).rejects.toThrow(/is not part of candidate/);

    expect(await getLiveMembership(db, unrelated)).toBeNull();
  });

  /**
   * "Accept" means "into the cluster the other side is already in". Merging
   * the pair somewhere neither of them lives is a different act, and not one
   * this verb should quietly perform.
   */
  it('refuses a target that does not hold the other side', async () => {
    const wrongTarget = await makeOpportunity('Wrong target');
    const first = await makeListing();
    const second = await makeListing();
    const [a, b] = [first, second].sort() as [string, string];
    const candidateId = await pendingCandidate(a, b);

    await expect(
      acceptDuplicateCandidate(db, {
        candidateId,
        sourceListingId: a,
        toOpportunityId: wrongTarget,
        confidence: 0.95,
        evidence: {},
        actor: ACTOR,
        at: '2026-09-08T13:00:00Z',
      }),
    ).rejects.toThrow(/does not hold the other side/);
  });

  /**
   * Accepting an already-settled pair is not a no-op — it is a second opinion
   * overwriting a first, and for one judged `distinct` it would merge
   * listings a reviewer had explicitly separated.
   */
  it('refuses a candidate that is already settled', async () => {
    const target = await makeOpportunity('Settled target');
    const first = await makeListing();
    const second = await makeListing();
    const [a, b] = [first, second].sort() as [string, string];
    await addMembership(target, b, '2026-09-08T12:00:00Z');
    const candidateId = await pendingCandidate(a, b);
    await resolveDuplicateCandidate(db, { candidateId, decision: 'distinct' });

    await expect(
      acceptDuplicateCandidate(db, {
        candidateId,
        sourceListingId: a,
        toOpportunityId: target,
        confidence: 0.95,
        evidence: {},
        actor: ACTOR,
        at: '2026-09-08T13:00:00Z',
      }),
    ).rejects.toThrow(/not awaiting review/);

    expect(await getLiveMembership(db, a)).toBeNull();
  });

  /**
   * The stale-link case, and the one that hid a human decision.
   *
   * Both listings are already in the cluster, so `reassignListingWithin`
   * short-circuits: it restores the previous AUTOMATIC membership and returns
   * without recording the reviewer at all. Only the candidate said 'human',
   * while the detail screen — which reads membership evidence — showed the
   * ruleset's original reasoning as though nobody had looked.
   */
  it('records the reviewer even when both listings are already clustered', async () => {
    const target = await makeOpportunity('Reaffirm target');
    const first = await makeListing();
    const second = await makeListing();
    const [a, b] = [first, second].sort() as [string, string];
    await addMembership(target, a, '2026-09-08T12:00:00Z');
    await addMembership(target, b, '2026-09-08T12:00:00Z');
    const candidateId = await pendingCandidate(a, b);

    await acceptDuplicateCandidate(db, {
      candidateId,
      sourceListingId: a,
      toOpportunityId: target,
      confidence: 0.99,
      evidence: { reasons: ['reviewer reaffirmed the existing link'] },
      actor: ACTOR,
      at: '2026-09-08T13:00:00Z',
    });

    const membership = await getLiveMembership(db, a);
    expect(membership?.opportunityId).toBe(target);
    // The reviewer's record, not the ruleset's.
    expect(membership?.decidedBy).toBe('human');
    // Stored as Postgres renders it, space-separated, not ISO.
    expect(membership?.decidedAt).toContain('2026-09-08 13:00');
    expect(membership?.evidence).toEqual({ reasons: ['reviewer reaffirmed the existing link'] });
  });

  /**
   * The failure the transaction actually exists for: one that happens BETWEEN
   * the two halves.
   *
   * A first version of this test used a missing target opportunity, and
   * mutation-checking showed it proved nothing — that failure happens before
   * any write, so two separate transactions roll back exactly as one does.
   * The discriminating case is a move that SUCCEEDS followed by a resolution
   * that fails: with one transaction the move is undone, with two it survives
   * and the reviewer is left with a merged cluster and a pair still pending.
   */
  it('undoes the move when the resolution fails', async () => {
    const target = await makeOpportunity('Rollback target');
    const listingA = await makeListing();

    await expect(
      acceptDuplicateCandidate(db, {
        // No such candidate, so the resolution throws AFTER the membership
        // has been written inside the same transaction.
        candidateId: randomUUID(),
        sourceListingId: listingA,
        toOpportunityId: target,
        confidence: 0.95,
        evidence: {},
        actor: ACTOR,
        at: '2026-09-08T13:00:00Z',
      }),
    ).rejects.toThrow(/no candidate with id/);

    // The move is gone. Under two transactions it would still be here.
    expect(await getLiveMembership(db, listingA)).toBeNull();
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
