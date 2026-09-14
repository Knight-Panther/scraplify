import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/client.js';
import {
  duplicateCandidates,
  opportunities,
  opportunityDecisions,
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
  rejectDuplicateCandidate,
  resolveDuplicateCandidate,
  splitListingIntoNewOpportunity,
  undoAcceptedMerge,
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
      await db
        .delete(opportunityDecisions)
        .where(inArray(opportunityDecisions.opportunityId, opportunityIds));
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

    // And the RULESET's original decision survives, retired rather than
    // overwritten. This half is what the first version of this test was
    // missing: it asserted the reviewer was recorded and never that the
    // automatic decision still was, so it passed just as happily against a
    // fix that wrote the reviewer's fields over the existing row — destroying
    // the provenance this table is append-only to keep (§12.5). Two rows, not
    // one, is the whole point.
    const history = await getMembershipHistory(db, a);
    expect(history).toHaveLength(2);
    const retired = history.filter((row) => row.supersededAt !== null);
    expect(retired).toHaveLength(1);
    expect(retired[0]?.decidedBy).toBe('ruleset');
    expect(retired[0]?.evidence).toEqual({ reasons: ['original automatic merge'] });
    expect(retired[0]?.decidedAt).toContain('2026-09-08 12:00');
  });

  /**
   * Real fan-out, planted exactly as found in the live review queue on
   * 2026-09-14: one listing sitting in two independent pending candidates.
   * There three hr.ge announcements, posted seconds apart, all scored as
   * duplicates of one jobs.ge listing — here, one listing (`a`) pending
   * against two others (`b1` and `b2`).
   *
   * Accepting the first pair is correct. Accepting the SECOND must not
   * silently move `a` again: nothing has judged `a` and `b2` to be anything,
   * and `a` was already confirmed into `b1`'s cluster by a human. The prior
   * behaviour here was to retire that human decision without a trace and
   * move `a` into `b2`'s cluster instead — the exact silent corruption the
   * guard below exists to refuse.
   */
  it('refuses to move a listing a human already confirmed elsewhere', async () => {
    const oppA = await makeOpportunity('a singleton');
    const oppB1 = await makeOpportunity('b1 singleton');
    const oppB2 = await makeOpportunity('b2 singleton');
    const a = await makeListing();
    const b1 = await makeListing();
    const b2 = await makeListing();
    await addMembership(oppA, a);
    await addMembership(oppB1, b1);
    await addMembership(oppB2, b2);
    const candidate1 = await pendingCandidate(a, b1);
    const candidate2 = await pendingCandidate(a, b2);

    await acceptDuplicateCandidate(db, {
      candidateId: candidate1,
      sourceListingId: a,
      toOpportunityId: oppB1,
      confidence: 0.99,
      evidence: { reasons: ['first pending pair, accepted'] },
      actor: ACTOR,
      at: '2026-09-14T12:00:00Z',
    });
    expect((await getLiveMembership(db, a))?.opportunityId).toBe(oppB1);

    await expect(
      acceptDuplicateCandidate(db, {
        candidateId: candidate2,
        sourceListingId: a,
        toOpportunityId: oppB2,
        confidence: 0.99,
        evidence: { reasons: ['second pending pair, same listing'] },
        actor: ACTOR,
        at: '2026-09-14T12:05:00Z',
      }),
    ).rejects.toThrow(/already shares an opportunity/);

    // The refusal must be real, not merely thrown-and-ignored: `a` still
    // belongs to the FIRST cluster, and the second candidate is untouched —
    // still `needs_review`, so a reviewer can still act on it deliberately.
    expect((await getLiveMembership(db, a))?.opportunityId).toBe(oppB1);
    const [stillPending] = await db
      .select({ decision: duplicateCandidates.resultingDecision })
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.id, candidate2));
    expect(stillPending?.decision).toBe('needs_review');
  });

  /**
   * The gap a check on `sourceListingId`'s OWN membership row cannot see, and
   * the reason the guard above is keyed on cluster SIZE instead.
   *
   * `x` is the MOVING side of the first accept, so it gets a fresh
   * `decidedBy: 'human'` row. `y` is the SURVIVOR — its own membership row is
   * untouched by that accept and still reads whatever it had before
   * (`ruleset`, from `addMembership`'s default). A guard that only checked
   * `y`'s own `decidedBy` would see 'ruleset' and let `y` be pulled out of
   * the very cluster it just anchored a human decision into — corrupting the
   * FIRST accept without ever touching the row that guard was watching.
   */
  it('also refuses to move the SURVIVING side of a confirmed pair, not only the moving one', async () => {
    const oppX = await makeOpportunity('x singleton');
    const oppY = await makeOpportunity('y singleton — becomes the survivor');
    const oppZ = await makeOpportunity('z singleton');
    const x = await makeListing();
    const y = await makeListing();
    const z = await makeListing();
    await addMembership(oppX, x);
    await addMembership(oppY, y);
    await addMembership(oppZ, z);
    const candidate1 = await pendingCandidate(x, y);
    const candidate2 = await pendingCandidate(y, z);

    // x moves into y's cluster. y's own row is never rewritten.
    await acceptDuplicateCandidate(db, {
      candidateId: candidate1,
      sourceListingId: x,
      toOpportunityId: oppY,
      confidence: 0.99,
      evidence: { reasons: ['first pair, x moves to y'] },
      actor: ACTOR,
      at: '2026-09-14T13:00:00Z',
    });
    const yMembershipAfterFirstAccept = await getLiveMembership(db, y);
    expect(yMembershipAfterFirstAccept?.decidedBy).toBe('ruleset');
    expect(yMembershipAfterFirstAccept?.opportunityId).toBe(oppY);

    // y — the untouched survivor — is now asked to move to z's cluster.
    await expect(
      acceptDuplicateCandidate(db, {
        candidateId: candidate2,
        sourceListingId: y,
        toOpportunityId: oppZ,
        confidence: 0.99,
        evidence: { reasons: ['second pair, y would move to z'] },
        actor: ACTOR,
        at: '2026-09-14T13:05:00Z',
      }),
    ).rejects.toThrow(/already shares an opportunity/);

    // x must still be exactly where the first accept put it.
    expect((await getLiveMembership(db, x))?.opportunityId).toBe(oppY);
    expect((await getLiveMembership(db, y))?.opportunityId).toBe(oppY);
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

  /**
   * `rejectDuplicateCandidate` — the review screen's "different vacancies"
   * verb, and the fix for a gap the commit gate found before this screen even
   * had users: for the ordinary case (two listings that were never merged),
   * this must behave exactly like a plain `resolveDuplicateCandidate` always
   * has — settle the verdict, touch no membership.
   */
  it('rejects an ordinary pending pair without touching membership', async () => {
    const oppA = await makeOpportunity('a singleton');
    const oppB = await makeOpportunity('b singleton');
    const a = await makeListing();
    const b = await makeListing();
    await addMembership(oppA, a);
    await addMembership(oppB, b);
    const candidateId = await pendingCandidate(a, b);

    const result = await rejectDuplicateCandidate(db, {
      candidateId,
      splitOutListingId: a,
      canonicalTitle: 'unused for a non-stale pair',
      type: 'job',
      actor: ACTOR,
      at: '2026-09-14T14:00:00Z',
    });

    expect(result.split).toBe(false);
    const [row] = await db
      .select()
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.id, candidateId));
    expect(row?.resultingDecision).toBe('distinct');
    expect(row?.decidedBy).toBe('human');
    // Neither listing moved.
    expect((await getLiveMembership(db, a))?.opportunityId).toBe(oppA);
    expect((await getLiveMembership(db, b))?.opportunityId).toBe(oppB);
  });

  /**
   * The case a plain `resolveDuplicateCandidate` call cannot handle correctly
   * on its own: `run-dedupe.ts` queues a `needs_review` candidate for a pair
   * that is ALREADY merged, when the evidence behind an automatic link
   * evaporates. Both sides share a live opportunity when this candidate is
   * read — the "stale link" shape. Rejecting it must actually separate them,
   * not just record a verdict the corpus then contradicts.
   */
  it('splits a stale-link pair apart when rejected, atomically with the verdict', async () => {
    const shared = await makeOpportunity('the stale merged cluster');
    const a = await makeListing();
    const b = await makeListing();
    // Both sides already live in the SAME opportunity — the shape run-dedupe
    // produces when it re-flags a merge whose evidence has since evaporated.
    await addMembership(shared, a);
    await addMembership(shared, b, '2026-09-06T12:00:01Z');
    const candidateId = await pendingCandidate(a, b);

    const result = await rejectDuplicateCandidate(db, {
      candidateId,
      splitOutListingId: b,
      canonicalTitle: 'Split out on rejection',
      type: 'job',
      actor: ACTOR,
      at: '2026-09-14T14:05:00Z',
    });
    // The split creates a THIRD opportunity nothing else in this test tracks.
    // Left unregistered here, `afterEach` deletes the membership rows for
    // `listingIds` but never learns this opportunity exists, and it survives
    // in the shared dev database forever — confirmed for real: seven of
    // these, sourceless, were already sitting in the live corpus from
    // earlier runs of this exact test (commit gate, 2026-09-14).
    if (result.splitOpportunityId !== null) opportunityIds.push(result.splitOpportunityId);

    expect(result.split).toBe(true);
    const [row] = await db
      .select()
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.id, candidateId));
    expect(row?.resultingDecision).toBe('distinct');

    // a stays; b is now in its OWN, different opportunity.
    const aMembership = await getLiveMembership(db, a);
    const bMembership = await getLiveMembership(db, b);
    expect(aMembership?.opportunityId).toBe(shared);
    expect(bMembership?.opportunityId).not.toBe(shared);
    expect(bMembership?.opportunityId).not.toBeNull();

    // The corpus must not go on agreeing with a verdict the reviewer just
    // rejected: a fresh getLiveMembership confirms the two are genuinely
    // apart, which is the property "just record distinct" cannot provide.
    expect(aMembership?.opportunityId).not.toBe(bMembership?.opportunityId);
  });

  it('refuses to reject a candidate that is not awaiting review', async () => {
    const oppA = await makeOpportunity('a singleton');
    const oppB = await makeOpportunity('b singleton');
    const a = await makeListing();
    const b = await makeListing();
    await addMembership(oppA, a);
    await addMembership(oppB, b);
    const candidateId = await pendingCandidate(a, b);
    await resolveDuplicateCandidate(db, { candidateId, decision: 'distinct' });

    await expect(
      rejectDuplicateCandidate(db, {
        candidateId,
        splitOutListingId: a,
        canonicalTitle: 'unused',
        type: 'job',
        actor: ACTOR,
        at: '2026-09-14T14:10:00Z',
      }),
    ).rejects.toThrow(/not awaiting review/);
  });

  it('refuses a listing that is not part of the candidate', async () => {
    const oppA = await makeOpportunity('a singleton');
    const oppB = await makeOpportunity('b singleton');
    const stray = await makeOpportunity('unrelated');
    const a = await makeListing();
    const b = await makeListing();
    const c = await makeListing();
    await addMembership(oppA, a);
    await addMembership(oppB, b);
    await addMembership(stray, c);
    const candidateId = await pendingCandidate(a, b);

    await expect(
      rejectDuplicateCandidate(db, {
        candidateId,
        splitOutListingId: c,
        canonicalTitle: 'unused',
        type: 'job',
        actor: ACTOR,
        at: '2026-09-14T14:15:00Z',
      }),
    ).rejects.toThrow(/is not part of candidate/);
  });

  /**
   * `rejectDuplicateCandidate` refuses a stale-link split when the shared
   * cluster has a THIRD member — the case `splitListingIntoNewOpportunity`
   * cannot resolve correctly by itself, since splitting the rejected side
   * out into a fresh singleton would also sever whatever relationship it has
   * with the third listing, which this candidate never judged.
   */
  it('refuses to split a stale-link pair when a third listing shares the cluster', async () => {
    const shared = await makeOpportunity('three-member cluster');
    const a = await makeListing();
    const b = await makeListing();
    const c = await makeListing();
    await addMembership(shared, a);
    await addMembership(shared, b, '2026-09-06T12:00:01Z');
    await addMembership(shared, c, '2026-09-06T12:00:02Z');
    const candidateId = await pendingCandidate(a, b);

    await expect(
      rejectDuplicateCandidate(db, {
        candidateId,
        splitOutListingId: b,
        canonicalTitle: 'unused',
        type: 'job',
        actor: ACTOR,
        at: '2026-09-14T14:20:00Z',
      }),
    ).rejects.toThrow(/more than two live members/);

    // Refused means untouched: all three still share the one opportunity,
    // and the candidate is still waiting.
    expect((await getLiveMembership(db, a))?.opportunityId).toBe(shared);
    expect((await getLiveMembership(db, b))?.opportunityId).toBe(shared);
    expect((await getLiveMembership(db, c))?.opportunityId).toBe(shared);
    const [row] = await db
      .select({ decision: duplicateCandidates.resultingDecision })
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.id, candidateId));
    expect(row?.decision).toBe('needs_review');
  });

  /**
   * `undoAcceptedMerge` — the review screen's undo, and the fix for a gap
   * `detachListing` alone left open: a bare detach removes the membership
   * but leaves the candidate row claiming `confirmed_same` from a human,
   * decoupled from any membership that still supports it. Left that way, a
   * later dedupe pass either silently re-links the pair, or — since its
   * upsert refuses to overwrite a human verdict — the stale claim sits there
   * PERMANENTLY, hiding a genuinely open question from every future
   * reviewer. Undoing a merge must reopen the question, not just move the
   * listing.
   */
  it('reopens the candidate a merge came from when the merge is undone', async () => {
    const oppA = await makeOpportunity('a singleton');
    const oppB = await makeOpportunity('b singleton, becomes the survivor');
    const a = await makeListing();
    const b = await makeListing();
    await addMembership(oppA, a);
    await addMembership(oppB, b);
    const candidateId = await pendingCandidate(a, b);

    await acceptDuplicateCandidate(db, {
      candidateId,
      sourceListingId: a,
      toOpportunityId: oppB,
      confidence: 1,
      evidence: { reasons: ['accepted on the review screen'] },
      actor: ACTOR,
      at: '2026-09-14T14:25:00Z',
    });
    const [afterAccept] = await db
      .select({ decision: duplicateCandidates.resultingDecision })
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.id, candidateId));
    expect(afterAccept?.decision).toBe('confirmed_same');

    const result = await undoAcceptedMerge(db, {
      sourceListingId: a,
      expectedOpportunityId: oppB,
      at: '2026-09-14T14:30:00Z',
    });

    expect(result.reopenedCandidateIds).toEqual([candidateId]);
    const [afterUndo] = await db
      .select({
        decision: duplicateCandidates.resultingDecision,
        decidedBy: duplicateCandidates.decidedBy,
      })
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.id, candidateId));
    expect(afterUndo?.decision).toBe('needs_review');
    // 'human', not null — a stale row left as anything else would be
    // vulnerable to the next `runDedupe --auto-link` silently re-merging it
    // before the reviewer who undid it ever sees the reopened candidate.
    expect(afterUndo?.decidedBy).toBe('human');
    // a is genuinely unclustered again, not silently left somewhere.
    expect(await getLiveMembership(db, a)).toBeNull();
  });

  it('does not reopen a candidate when the detached listing had no live pair to begin with', async () => {
    const opp = await makeOpportunity('lone listing');
    const a = await makeListing();
    await addMembership(opp, a);

    const result = await undoAcceptedMerge(db, {
      sourceListingId: a,
      expectedOpportunityId: opp,
      at: '2026-09-14T14:35:00Z',
    });

    expect(result.reopenedCandidateIds).toEqual([]);
  });

  /**
   * The other real gap the commit gate found: a bare `sourceListingId`
   * detached whatever opportunity the listing CURRENTLY lived in, not
   * necessarily the one a reviewer was looking at when they clicked undo. A
   * stale page — another decision, a fresh dedupe pass, a direct correction —
   * must not let its undo button silently detach a cluster nobody reviewed.
   */
  it('refuses to undo when the listing has moved since the caller last saw it', async () => {
    const original = await makeOpportunity('what the page showed');
    const elsewhere = await makeOpportunity('where it actually is now');
    const a = await makeListing();
    await addMembership(elsewhere, a);

    await expect(
      undoAcceptedMerge(db, {
        sourceListingId: a,
        expectedOpportunityId: original,
        at: '2026-09-14T14:36:00Z',
      }),
    ).rejects.toThrow(/no longer in opportunity/);

    // Refused means untouched.
    expect((await getLiveMembership(db, a))?.opportunityId).toBe(elsewhere);
  });

  /**
   * The gap a full reversal cannot close without either changing
   * `detachListing`'s contract for every other caller or building the audit
   * trail `opportunity_decisions` deliberately does not have — see
   * `undoAcceptedMerge`'s own comment. What it CAN do is make the risk
   * visible rather than silent, the same way `cleanupTestSource`'s
   * entangled-cluster case already does.
   */
  it('warns when undoing a merge leaves a shortlist decision of uncertain provenance', async () => {
    const oppA = await makeOpportunity('a singleton');
    const oppB = await makeOpportunity('b singleton, becomes the survivor');
    const a = await makeListing();
    const b = await makeListing();
    await addMembership(oppA, a);
    await addMembership(oppB, b);
    await db.insert(opportunityDecisions).values({
      id: randomUUID(),
      opportunityId: oppB,
      decision: 'saved',
      note: 'about whichever vacancy this was',
      decidedAt: '2026-09-14T00:00:00Z',
      firstDecidedAt: '2026-09-14T00:00:00Z',
    });
    const candidateId = await pendingCandidate(a, b);
    await acceptDuplicateCandidate(db, {
      candidateId,
      sourceListingId: a,
      toOpportunityId: oppB,
      confidence: 1,
      evidence: { reasons: ['accepted on the review screen'] },
      actor: ACTOR,
      at: '2026-09-14T14:37:00Z',
    });

    const warned = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await undoAcceptedMerge(db, {
        sourceListingId: a,
        expectedOpportunityId: oppB,
        at: '2026-09-14T14:38:00Z',
      });
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('has a shortlist decision'));
    } finally {
      warned.mockRestore();
    }

    // The decision itself is untouched either way — warned about, not erased.
    const [stillThere] = await db
      .select()
      .from(opportunityDecisions)
      .where(eq(opportunityDecisions.opportunityId, oppB));
    expect(stillThere?.decision).toBe('saved');
  });

  it('does not warn when the survivor has no shortlist decision at all', async () => {
    const oppA = await makeOpportunity('a singleton');
    const oppB = await makeOpportunity('b singleton, no decision');
    const a = await makeListing();
    const b = await makeListing();
    await addMembership(oppA, a);
    await addMembership(oppB, b);
    const candidateId = await pendingCandidate(a, b);
    await acceptDuplicateCandidate(db, {
      candidateId,
      sourceListingId: a,
      toOpportunityId: oppB,
      confidence: 1,
      evidence: { reasons: ['accepted on the review screen'] },
      actor: ACTOR,
      at: '2026-09-14T14:39:00Z',
    });

    const warned = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await undoAcceptedMerge(db, {
        sourceListingId: a,
        expectedOpportunityId: oppB,
        at: '2026-09-14T14:40:00Z',
      });
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });

  /**
   * The shortlist reconciliation `reassignListingWithin` now performs on
   * every move that empties the losing side's opportunity — not only via the
   * review screen, since `reassignListing` is the same shared primitive.
   */
  describe('shortlist reconciliation on merge', () => {
    async function addDecision(
      opportunityId: string,
      decision: 'saved' | 'dismissed',
      note: string,
    ) {
      await db.insert(opportunityDecisions).values({
        id: randomUUID(),
        opportunityId,
        decision,
        note,
        decidedAt: '2026-09-14T00:00:00Z',
        firstDecidedAt: '2026-09-14T00:00:00Z',
      });
    }

    it('carries a decision onto the surviving opportunity when it has none', async () => {
      const from = await makeOpportunity('had a decision');
      const to = await makeOpportunity('gains it');
      const listingId = await makeListing();
      await addMembership(from, listingId);
      await addDecision(from, 'dismissed', 'wrong city');

      await reassignListing(db, {
        sourceListingId: listingId,
        toOpportunityId: to,
        decision: 'confirmed_same',
        confidence: 1,
        evidence: {},
        actor: ACTOR,
        at: '2026-09-14T14:40:00Z',
      });

      const [onTarget] = await db
        .select()
        .from(opportunityDecisions)
        .where(eq(opportunityDecisions.opportunityId, to));
      expect(onTarget?.decision).toBe('dismissed');
      expect(onTarget?.note).toBe('wrong city');
      // The original date survives the move — it is still true that this was
      // dismissed on 2026-09-14, not "just now".
      expect(onTarget?.firstDecidedAt).toContain('2026-09-14');

      const stillOnSource = await db
        .select()
        .from(opportunityDecisions)
        .where(eq(opportunityDecisions.opportunityId, from));
      expect(stillOnSource).toHaveLength(0);
    });

    it('keeps the surviving opportunity’s own decision when both sides have one', async () => {
      const from = await makeOpportunity('dismissed');
      const to = await makeOpportunity('saved — this one should win');
      const listingId = await makeListing();
      await addMembership(from, listingId);
      await addDecision(from, 'dismissed', 'losing side');
      await addDecision(to, 'saved', 'surviving side');

      await reassignListing(db, {
        sourceListingId: listingId,
        toOpportunityId: to,
        decision: 'confirmed_same',
        confidence: 1,
        evidence: {},
        actor: ACTOR,
        at: '2026-09-14T14:45:00Z',
      });

      const [onTarget] = await db
        .select()
        .from(opportunityDecisions)
        .where(eq(opportunityDecisions.opportunityId, to));
      expect(onTarget?.decision).toBe('saved');
      expect(onTarget?.note).toBe('surviving side');

      // The losing side's decision is gone, not dangling on a dead cluster.
      const stillOnSource = await db
        .select()
        .from(opportunityDecisions)
        .where(eq(opportunityDecisions.opportunityId, from));
      expect(stillOnSource).toHaveLength(0);
    });

    it('leaves a decision alone when the listing moves out of a cluster that is NOT left empty', async () => {
      const from = await makeOpportunity('still has another member');
      const to = await makeOpportunity('target');
      const moving = await makeListing();
      const staying = await makeListing();
      await addMembership(from, moving);
      await addMembership(from, staying, '2026-09-06T12:00:01Z');
      await addDecision(from, 'saved', 'about the vacancy staying still applies');

      await reassignListing(db, {
        sourceListingId: moving,
        toOpportunityId: to,
        decision: 'confirmed_same',
        confidence: 1,
        evidence: {},
        actor: ACTOR,
        at: '2026-09-14T14:50:00Z',
      });

      // `from` still has `staying` as a live member, so its decision — which
      // describes THAT listing's vacancy too — must not have moved.
      const [onSource] = await db
        .select()
        .from(opportunityDecisions)
        .where(eq(opportunityDecisions.opportunityId, from));
      expect(onSource?.decision).toBe('saved');
      const onTarget = await db
        .select()
        .from(opportunityDecisions)
        .where(eq(opportunityDecisions.opportunityId, to));
      expect(onTarget).toHaveLength(0);
    });
  });
});
