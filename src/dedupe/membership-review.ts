import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  duplicateCandidates,
  opportunities,
  opportunitySourceMemberships,
} from '../db/schema/index.js';
import type { Database, DatabaseOrTransaction } from '../db/types.js';
import { resolveCanonicalOpportunity } from './resolve-canonical.js';
import type { DedupeDecision } from './score-pair.js';

/**
 * Human review operations over cluster membership (§12.5: "moving a source
 * listing between clusters must be reversible and audited").
 *
 * This module is the undo for everything `runDedupe` does automatically, and
 * that is precisely why it matters: §14.2 permits auto-linking at all only
 * because a wrong merge can be corrected. Without a working, audited reversal
 * path, every automatic decision would be effectively permanent, and the
 * honest response would be to disable auto-linking entirely.
 *
 * **Nothing here deletes a membership.** Retiring one stamps `supersededAt`
 * and leaves the row, its evidence, its confidence and its decider intact.
 * The history of how a listing moved between clusters is the audit trail; a
 * DELETE would destroy exactly the record a human needs when asking "why was
 * this merged, and by what evidence?".
 */

export interface ReviewActor {
  /** 'human' for an operator decision; 'ruleset'/'model' when replayed by automation. */
  decidedBy: 'ruleset' | 'model' | 'human';
  /** Ruleset/model version, or an operator identifier — recorded on every row (§14.2). */
  version: string;
}

/** The membership a listing currently belongs to, or null if it belongs to none. */
export async function getLiveMembership(
  db: DatabaseOrTransaction,
  sourceListingId: string,
): Promise<typeof opportunitySourceMemberships.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(opportunitySourceMemberships)
    .where(
      and(
        eq(opportunitySourceMemberships.sourceListingId, sourceListingId),
        isNull(opportunitySourceMemberships.supersededAt),
      ),
    );
  return row ?? null;
}

/** Every membership a listing has ever had, newest decision first — the audit trail. */
export async function getMembershipHistory(
  db: DatabaseOrTransaction,
  sourceListingId: string,
): Promise<Array<typeof opportunitySourceMemberships.$inferSelect>> {
  return db
    .select()
    .from(opportunitySourceMemberships)
    .where(eq(opportunitySourceMemberships.sourceListingId, sourceListingId))
    .orderBy(desc(opportunitySourceMemberships.decidedAt));
}

async function retireLiveMembership(
  tx: DatabaseOrTransaction,
  sourceListingId: string,
  at: string,
): Promise<string | null> {
  const live = await getLiveMembership(tx, sourceListingId);
  if (live === null) return null;
  await tx
    .update(opportunitySourceMemberships)
    .set({ supersededAt: at })
    .where(eq(opportunitySourceMemberships.id, live.id));
  return live.opportunityId;
}

export interface DetachResult {
  /** The opportunity the listing was removed from, or null if it had no live membership. */
  detachedFrom: string | null;
  /** True when that opportunity was left with no live members at all. */
  leftOpportunityEmpty: boolean;
}

/**
 * Removes a listing from whatever cluster it is in, without putting it
 * anywhere else — the correction for "this was merged and should not have
 * been".
 *
 * An opportunity left with no live members is deliberately NOT deleted. Its
 * revisions and the retired memberships that pointed at it are the evidence of
 * a merge that happened and was undone; deleting the row would erase that and
 * break the FKs the retired memberships still hold. An empty opportunity is
 * inert — nothing surfaces it — and callers are told when they have created
 * one so it can be reported rather than silently accumulated.
 */
export async function detachListing(
  db: Database,
  input: { sourceListingId: string; at: string },
): Promise<DetachResult> {
  return db.transaction(async (tx) => {
    const detachedFrom = await retireLiveMembership(tx, input.sourceListingId, input.at);
    if (detachedFrom === null) {
      return { detachedFrom: null, leftOpportunityEmpty: false };
    }
    const remaining = await tx
      .select({ id: opportunitySourceMemberships.id })
      .from(opportunitySourceMemberships)
      .where(
        and(
          eq(opportunitySourceMemberships.opportunityId, detachedFrom),
          isNull(opportunitySourceMemberships.supersededAt),
        ),
      );
    // The cluster this listing left now has a different member set, so its
    // canonical revision and denormalized columns must be rebuilt — otherwise
    // they keep describing a membership that no longer exists, and an existing
    // ranking stays a cache hit under an unchanged revision id even though a
    // human just corrected the cluster (adversarial review, 2026-09-06).
    await resolveCanonicalOpportunity(tx, detachedFrom, input.at);
    return { detachedFrom, leftOpportunityEmpty: remaining.length === 0 };
  });
}

/**
 * Moves a listing into a specific existing opportunity, retiring whatever
 * membership it had. Used both to correct a wrong cluster and to accept a
 * `needs_review` candidate a human has judged to be a genuine duplicate.
 *
 * The target opportunity must already exist — this function will not create
 * one, so a typo in an id fails loudly instead of silently spawning an
 * orphan cluster.
 */
export interface ReassignInput {
  sourceListingId: string;
  toOpportunityId: string;
  decision: DedupeDecision;
  confidence: number;
  evidence: Record<string, unknown>;
  actor: ReviewActor;
  at: string;
}

export async function reassignListing(
  db: Database,
  input: ReassignInput,
): Promise<{ previousOpportunityId: string | null }> {
  return db.transaction(async (tx) => reassignListingWithin(tx, input));
}

/**
 * The body of `reassignListing`, callable inside a transaction the caller
 * already owns.
 *
 * Extracted so `acceptDuplicateCandidate` can do the move and the resolution
 * in ONE transaction. Composing the two public functions instead opened two,
 * and a crash between them left a merged cluster with an unsettled candidate —
 * which the next dedupe pass then re-queued, asking a reviewer to decide again
 * something they had already decided, with the merge already applied.
 */
async function reassignListingWithin(
  tx: DatabaseOrTransaction,
  input: ReassignInput,
): Promise<{ previousOpportunityId: string | null; alreadyInTarget: boolean }> {
  {
    const [target] = await tx
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.id, input.toOpportunityId));
    if (target === undefined) {
      throw new Error(`reassignListing: no opportunity with id ${input.toOpportunityId}`);
    }

    const previousOpportunityId = await retireLiveMembership(tx, input.sourceListingId, input.at);
    if (previousOpportunityId === input.toOpportunityId) {
      // Already there. The retire above is undone rather than leaving the
      // listing with a retired row and an identical fresh one, which would
      // clutter the audit trail with a move that never happened.
      await tx
        .update(opportunitySourceMemberships)
        .set({ supersededAt: null })
        .where(
          and(
            eq(opportunitySourceMemberships.sourceListingId, input.sourceListingId),
            eq(opportunitySourceMemberships.supersededAt, input.at),
          ),
        );
      return { previousOpportunityId, alreadyInTarget: true };
    }

    await tx.insert(opportunitySourceMemberships).values({
      id: randomUUID(),
      opportunityId: input.toOpportunityId,
      sourceListingId: input.sourceListingId,
      decision: input.decision,
      confidence: input.confidence,
      evidence: input.evidence,
      decidedBy: input.actor.decidedBy,
      decidedAt: input.at,
      dedupeModelOrRulesetVersion: input.actor.version,
      supersededAt: null,
    });
    // BOTH clusters changed: one lost a member, the other gained one.
    if (previousOpportunityId !== null) {
      await resolveCanonicalOpportunity(tx, previousOpportunityId, input.at);
    }
    await resolveCanonicalOpportunity(tx, input.toOpportunityId, input.at);

    return { previousOpportunityId, alreadyInTarget: false };
  }
}

/**
 * Accepting a `needs_review` pair: move the listing and settle the candidate,
 * atomically.
 *
 * "Accept" is a composite verb — a membership change plus a resolution — and
 * composing the two public functions ran each in its own transaction. A crash
 * between them left the merge applied and the candidate still pending, so the
 * next dedupe pass re-queued a pair the reviewer had already judged, with the
 * cluster already changed underneath it. One transaction makes the pair of
 * facts land together or not at all.
 *
 * The evidence recorded on the new membership is the REVIEWER's, not the
 * ruleset's: a human accepting a pair is a different kind of claim from a
 * score crossing a threshold, and `decidedBy: 'human'` is what stops the next
 * automated pass overwriting it.
 */
export async function acceptDuplicateCandidate(
  db: Database,
  input: Omit<ReassignInput, 'decision'> & { candidateId: string },
): Promise<{ previousOpportunityId: string | null }> {
  return db.transaction(async (tx) => {
    // The candidate FIRST, and locked, before anything moves.
    //
    // Two things went wrong without this. The arguments were trusted, so a
    // stale form or a mistaken caller could accept candidate X while moving a
    // listing that had nothing to do with it — leaving the cluster and the
    // candidate row describing different facts, each internally consistent and
    // jointly wrong. And the row was read after the move, so two reviewers
    // acting at once could both pass their checks before either wrote.
    // `for update` serialises them; the second waits and then finds the pair
    // already settled.
    const [candidate] = await tx
      .select({
        id: duplicateCandidates.id,
        a: duplicateCandidates.sourceListingIdA,
        b: duplicateCandidates.sourceListingIdB,
        decision: duplicateCandidates.resultingDecision,
      })
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.id, input.candidateId))
      .for('update');

    if (candidate === undefined) {
      throw new Error(`acceptDuplicateCandidate: no candidate with id ${input.candidateId}`);
    }
    // Accepting something already settled is not a no-op, it is a second
    // opinion overwriting a first — and for a pair judged `distinct` it would
    // merge listings a reviewer had explicitly separated.
    if (candidate.decision !== 'needs_review') {
      throw new Error(
        `acceptDuplicateCandidate: candidate ${input.candidateId} is not awaiting review ` +
          `(decision: ${candidate.decision ?? 'none'})`,
      );
    }

    // The listing being moved must be one side of THIS pair.
    if (input.sourceListingId !== candidate.a && input.sourceListingId !== candidate.b) {
      throw new Error(
        `acceptDuplicateCandidate: listing ${input.sourceListingId} is not part of candidate ` +
          `${input.candidateId}`,
      );
    }

    // ...and the target must be where the OTHER side already lives. Otherwise
    // "accept" would merge the pair into a cluster neither of them is in,
    // which is a different act entirely and not one this verb should perform.
    const otherListingId = input.sourceListingId === candidate.a ? candidate.b : candidate.a;
    const otherMembership = await getLiveMembership(tx, otherListingId);
    if (otherMembership === null || otherMembership.opportunityId !== input.toOpportunityId) {
      throw new Error(
        `acceptDuplicateCandidate: opportunity ${input.toOpportunityId} does not hold the other ` +
          `side of candidate ${input.candidateId}`,
      );
    }

    // The decision is fixed by the verb rather than taken from the caller.
    // "Accept" means these are the same vacancy; a caller passing 'distinct'
    // here was previously able to merge two listings while recording that they
    // are different.
    const decision: DedupeDecision = 'confirmed_same';

    const result = await reassignListingWithin(tx, { ...input, decision });

    // The reviewer's own membership record, in the one case that would
    // otherwise have none.
    //
    // `reassignListingWithin` short-circuits when the listing is ALREADY in
    // the target — the stale-link case, where both sides are in the cluster
    // and the candidate was queued because the link no longer scores. It
    // restores the previous automatic membership and returns, so the
    // reviewer's evidence, identity and timestamp were never recorded, while
    // the candidate said 'human'. The detail screen reads membership evidence,
    // so a human reaffirmation was invisible exactly where provenance is the
    // point. When the listing DID move, that same function has already
    // inserted a live membership carrying this reviewer's evidence and
    // identity, so there is nothing to add here.
    //
    // Written as retire-then-append, NOT as an update in place. The first fix
    // for this (whole-branch review, 2026-09-08) updated the restored row's
    // decision, evidence, decider and timestamp — which silently overwrote the
    // RULESET's original decision, the exact provenance
    // `opportunity_source_memberships` is append-only to protect (§12.5, and
    // the schema comment says so in as many words). It traded an invisible
    // reviewer for a destroyed automatic decision. Retiring the automatic row
    // and appending a human one keeps both: the history shows the ruleset
    // linked these, and then a person confirmed it.
    if (result.alreadyInTarget) {
      await retireLiveMembership(tx, input.sourceListingId, input.at);
      await tx.insert(opportunitySourceMemberships).values({
        id: randomUUID(),
        opportunityId: input.toOpportunityId,
        sourceListingId: input.sourceListingId,
        decision,
        confidence: input.confidence,
        evidence: input.evidence,
        decidedBy: input.actor.decidedBy,
        decidedAt: input.at,
        dedupeModelOrRulesetVersion: input.actor.version,
        supersededAt: null,
      });
      // Deliberately no `resolveCanonicalOpportunity` call: the cluster's live
      // MEMBER SET is unchanged by a reaffirmation — the same listing, the same
      // opportunity — so re-resolving could only produce the revision it
      // already points at.
    }

    await resolveDuplicateCandidate(tx, {
      candidateId: input.candidateId,
      decision,
      decidedBy: input.actor.decidedBy === 'human' ? 'human' : 'ruleset',
    });
    return result;
  });
}

/**
 * Splits a listing out of its cluster into a brand-new opportunity of its
 * own — the correction for "these are two different jobs that were merged".
 *
 * Distinct from `detachListing`: detaching leaves the listing unclustered,
 * which is right when it should not be canonicalized at all; splitting keeps
 * it visible as its own opportunity, which is right when the listing is a
 * real, separate vacancy. Both are reversible via `reassignListing`.
 */
export async function splitListingIntoNewOpportunity(
  db: Database,
  input: {
    sourceListingId: string;
    canonicalTitle: string;
    type: 'job' | 'summer_school' | 'scholarship' | 'grant' | 'event';
    evidence: Record<string, unknown>;
    actor: ReviewActor;
    at: string;
  },
): Promise<{ opportunityId: string; previousOpportunityId: string | null }> {
  return db.transaction(async (tx) => {
    const previousOpportunityId = await retireLiveMembership(tx, input.sourceListingId, input.at);

    const opportunityId = randomUUID();
    await tx.insert(opportunities).values({
      id: opportunityId,
      type: input.type,
      canonicalTitle: input.canonicalTitle,
      organizationId: null,
      canonicalStatus: 'active',
      currentCanonicalRevisionId: null,
      createdAt: input.at,
      updatedAt: input.at,
    });

    await tx.insert(opportunitySourceMemberships).values({
      id: randomUUID(),
      opportunityId,
      sourceListingId: input.sourceListingId,
      // A human splitting a listing out is asserting it is NOT the same as
      // what it was merged with; 'confirmed_same' describes its relationship
      // to its new single-member cluster, which is trivially itself.
      decision: 'confirmed_same',
      confidence: 1,
      evidence: input.evidence,
      decidedBy: input.actor.decidedBy,
      decidedAt: input.at,
      dedupeModelOrRulesetVersion: input.actor.version,
      supersededAt: null,
    });

    // The split listing's NEW opportunity needs a canonical revision like any
    // other (§12.4), and the cluster it left has a changed member set.
    await resolveCanonicalOpportunity(tx, opportunityId, input.at);
    if (previousOpportunityId !== null) {
      await resolveCanonicalOpportunity(tx, previousOpportunityId, input.at);
    }
    return { opportunityId, previousOpportunityId };
  });
}

/**
 * Records a human's verdict on a candidate pair without necessarily changing
 * membership — the review queue's "these are genuinely different" outcome.
 *
 * Kept separate from the membership operations because resolving a candidate
 * and moving a listing are different acts: marking a pair `distinct` settles
 * the question so it stops resurfacing, and touches no cluster at all.
 */
export async function resolveDuplicateCandidate(
  db: DatabaseOrTransaction,
  input: { candidateId: string; decision: DedupeDecision; decidedBy?: 'human' | 'ruleset' },
): Promise<void> {
  const updated = await db
    .update(duplicateCandidates)
    .set({
      status: 'evaluated',
      resultingDecision: input.decision,
      // Defaults to 'human' because that is what this function is for: an
      // operator settling a pair. Stamping it is what stops the next automated
      // pass overwriting the verdict and resurfacing the pair.
      decidedBy: input.decidedBy ?? 'human',
    })
    .where(eq(duplicateCandidates.id, input.candidateId))
    .returning({ id: duplicateCandidates.id });
  if (updated.length === 0) {
    throw new Error(`resolveDuplicateCandidate: no candidate with id ${input.candidateId}`);
  }
}
