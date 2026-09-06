import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  duplicateCandidates,
  opportunities,
  opportunitySourceMemberships,
} from '../db/schema/index.js';
import type { Database, DatabaseOrTransaction } from '../db/types.js';
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
export async function reassignListing(
  db: Database,
  input: {
    sourceListingId: string;
    toOpportunityId: string;
    decision: DedupeDecision;
    confidence: number;
    evidence: Record<string, unknown>;
    actor: ReviewActor;
    at: string;
  },
): Promise<{ previousOpportunityId: string | null }> {
  return db.transaction(async (tx) => {
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
      return { previousOpportunityId };
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
    await tx
      .update(opportunities)
      .set({ updatedAt: input.at })
      .where(eq(opportunities.id, input.toOpportunityId));

    return { previousOpportunityId };
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
