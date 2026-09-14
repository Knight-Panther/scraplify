import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  duplicateCandidates,
  opportunities,
  opportunityDecisions,
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

/**
 * Carries a shortlist decision across a merge that empties the opportunity it
 * was recorded on, so a dismissal cannot silently reappear as undecided.
 *
 * `opportunity_decisions` is keyed on opportunity id, and a merge changes
 * which opportunity a vacancy's listing lives under. Left alone, a decision
 * on the LOSING side becomes attached to an opportunity nothing points at any
 * more — invisible to `listDecisions`, since nothing surfaces a memberless
 * opportunity there — while the SURVIVING opportunity shows no decision at
 * all. For a dismissal specifically, that reads as the exact failure the
 * shortlist's own design note warns against: "why does this keep coming
 * back" stops being answerable the moment the dismissal it is asking about
 * becomes unreachable (commit gate, 2026-09-14).
 *
 * Only runs when the losing opportunity is now fully EMPTY — a move out of a
 * multi-member cluster leaves other listings still describing that same
 * opportunity, whose own decision (if any) still applies to them and must not
 * be touched.
 *
 * Two outcomes, both explicit rather than guessed: if the surviving
 * opportunity has no decision yet, the losing side's decision (with its note
 * and its original `firstDecidedAt`) is RE-KEYED onto it — the vacancy is the
 * same one, so a prior dismissal or save genuinely still applies. If the
 * surviving opportunity already has its OWN decision, that one wins — it is
 * the opportunity a reviewer explicitly directed this merge into — and the
 * losing side's decision is removed rather than left dangling on a cluster
 * that no longer exists in any visible form.
 */
async function reconcileShortlistDecision(
  tx: DatabaseOrTransaction,
  losingOpportunityId: string,
  survivingOpportunityId: string,
): Promise<void> {
  const [stillHasMembers] = await tx
    .select({ id: opportunitySourceMemberships.id })
    .from(opportunitySourceMemberships)
    .where(
      and(
        eq(opportunitySourceMemberships.opportunityId, losingOpportunityId),
        isNull(opportunitySourceMemberships.supersededAt),
      ),
    );
  if (stillHasMembers !== undefined) return;

  const [losingDecision] = await tx
    .select()
    .from(opportunityDecisions)
    .where(eq(opportunityDecisions.opportunityId, losingOpportunityId));
  if (losingDecision === undefined) return;

  const [survivingDecision] = await tx
    .select({ id: opportunityDecisions.id })
    .from(opportunityDecisions)
    .where(eq(opportunityDecisions.opportunityId, survivingOpportunityId));

  if (survivingDecision === undefined) {
    await tx
      .update(opportunityDecisions)
      .set({ opportunityId: survivingOpportunityId })
      .where(eq(opportunityDecisions.id, losingDecision.id));
  } else {
    await tx.delete(opportunityDecisions).where(eq(opportunityDecisions.id, losingDecision.id));
  }
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
 * break the FKs the retired memberships still hold. Callers are told when they
 * have created one so it can be reported rather than silently accumulated.
 *
 * **An emptied opportunity is not as inert as this comment used to claim.** It
 * said "nothing surfaces it", and that is false for ranking: `runRanking`
 * enumerates `opportunities` with no join requiring a live member, so an empty
 * cluster can still be scored and rendered under its last canonical title
 * (found via the test-debris sweep, 2026-09-14). It is harmless for a cluster
 * emptied by a genuine detach — the title describes a real vacancy that was
 * un-merged, and a stale ranking is a stale ranking. It is NOT harmless for a
 * cluster whose listings never existed, which is why `cleanupTestSource`
 * deletes test-only clusters outright rather than merely unlinking them.
 * Whether ranking should require a live member is a real question and is
 * deliberately left open here rather than changed as a side effect of a
 * cleanup fix.
 */
export async function detachListing(
  db: Database,
  input: { sourceListingId: string; at: string },
): Promise<DetachResult> {
  // `remainingMemberIds` is dropped, not merely unused — it is
  // `undoAcceptedMerge`'s own internal detail, and leaking it here would
  // widen `detachListing`'s long-documented `DetachResult` contract as a side
  // effect of a refactor rather than a deliberate change. Caught by this
  // file's own pre-existing test, which asserts the exact shape returned for
  // a no-op detach.
  const { detachedFrom, leftOpportunityEmpty } = await db.transaction((tx) =>
    detachListingWithin(tx, input),
  );
  return { detachedFrom, leftOpportunityEmpty };
}

/**
 * The body of `detachListing`, callable inside a transaction the caller
 * already owns — the same reason every other paired verb in this file has
 * one: `undoAcceptedMerge` needs the detach AND the candidate correction it
 * requires to land in one transaction.
 */
async function detachListingWithin(
  tx: DatabaseOrTransaction,
  input: { sourceListingId: string; at: string },
): Promise<DetachResult & { remainingMemberIds: string[] }> {
  const detachedFrom = await retireLiveMembership(tx, input.sourceListingId, input.at);
  if (detachedFrom === null) {
    return { detachedFrom: null, leftOpportunityEmpty: false, remainingMemberIds: [] };
  }
  const remaining = await tx
    .select({ sourceListingId: opportunitySourceMemberships.sourceListingId })
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
  return {
    detachedFrom,
    leftOpportunityEmpty: remaining.length === 0,
    remainingMemberIds: remaining.map((row) => row.sourceListingId),
  };
}

/**
 * Undoes a review-screen merge: detaches the listing, AND reopens whatever
 * `duplicate_candidates` row claimed it as `confirmed_same` with the
 * listing(s) it shared a cluster with.
 *
 * `detachListing` alone is not a complete undo for an accepted pair, and the
 * gap is not cosmetic. `resolveDuplicateCandidate`'s own comment explains why
 * it matters which way it is wrong: `run-dedupe.ts`'s upsert REFUSES to
 * overwrite a `decidedBy: 'human'` row, so a stale `confirmed_same` left
 * behind by a bare detach does not merely risk being silently re-linked by a
 * later automated pass — it can just as easily sit there PERMANENTLY,
 * suppressing the pair from ever re-entering the review queue even though the
 * membership it described no longer exists. Either outcome is the corpus
 * disagreeing with what the reviewer just did.
 *
 * Scoped to candidates between the detached listing and whoever it shared its
 * PREVIOUS cluster with — not "every candidate touching this listing" —
 * because those are the only ones whose `confirmed_same` claim the detach
 * actually contradicts. A sibling candidate involving a THIRD, unrelated
 * listing was never about this cluster and is left exactly as it was.
 */
export async function undoAcceptedMerge(
  db: Database,
  input: { sourceListingId: string; expectedOpportunityId: string; at: string },
): Promise<DetachResult & { reopenedCandidateIds: string[] }> {
  return db.transaction(async (tx) => {
    // Locked and checked against what the CALLER expected to be undoing,
    // before anything moves. Without this, the action took only a listing
    // id and detached whatever live membership that listing happened to have
    // at request time — so a page left open while something else moved the
    // listing (another review decision, a fresh dedupe pass, a direct
    // correction) would click "undo" on a cluster the reviewer never looked
    // at, silently detaching it from an unrelated merge (commit gate,
    // 2026-09-14). The lock is taken here, before the detach, so the whole
    // sequence — check, then act — is atomic against a concurrent move.
    const [current] = await tx
      .select()
      .from(opportunitySourceMemberships)
      .where(
        and(
          eq(opportunitySourceMemberships.sourceListingId, input.sourceListingId),
          isNull(opportunitySourceMemberships.supersededAt),
        ),
      )
      .for('update');
    if (current === undefined || current.opportunityId !== input.expectedOpportunityId) {
      throw new Error(
        `undoAcceptedMerge: listing ${input.sourceListingId} is no longer in opportunity ` +
          `${input.expectedOpportunityId} — it may have been moved since this page was loaded. ` +
          'Refresh and try again.',
      );
    }

    const { remainingMemberIds, ...detachResult } = await detachListingWithin(tx, input);

    const reopened: string[] = [];
    for (const otherId of remainingMemberIds) {
      const updated = await tx
        .update(duplicateCandidates)
        // decidedBy: 'human', NOT null. A human just acted on this pair —
        // that is what an undo IS — and `run-dedupe.ts`'s own upsert only
        // ever skips a row when `decidedBy` reads 'human'
        // (`decided_by is distinct from 'human'` gates the overwrite). Left
        // null, the very next `npm run dedupe --auto-link` could silently
        // re-score this pair as `confirmed_same` and re-merge it before the
        // reviewer who clicked undo ever sees the reopened candidate —
        // reversing the undo without anyone touching anything (commit gate,
        // 2026-09-14). Marking it human leaves the pair exactly where every
        // other human-reviewed `needs_review` candidate sits: waiting on
        // /review, immune to the ruleset until a person settles it there.
        .set({ resultingDecision: 'needs_review', decidedBy: 'human', status: 'evaluated' })
        .where(
          and(
            or(
              and(
                eq(duplicateCandidates.sourceListingIdA, input.sourceListingId),
                eq(duplicateCandidates.sourceListingIdB, otherId),
              ),
              and(
                eq(duplicateCandidates.sourceListingIdA, otherId),
                eq(duplicateCandidates.sourceListingIdB, input.sourceListingId),
              ),
            ),
            eq(duplicateCandidates.resultingDecision, 'confirmed_same'),
          ),
        )
        .returning({ id: duplicateCandidates.id });
      reopened.push(...updated.map((row) => row.id));
    }

    // Warned, not reversed — and that gap is deliberate, not an oversight.
    //
    // At MERGE time, `reconcileShortlistDecision` may have carried a decision
    // from the listing being detached's PREVIOUS opportunity onto this one —
    // or deleted it, if this one already had its own. Undoing the merge
    // cannot cleanly put that decision back: `detachListing` leaves the
    // listing with NO opportunity at all (by design — "these are not the
    // same vacancy" and "this listing has its own" are different claims, and
    // detach only ever makes the first), so there is nowhere valid to move a
    // decision back TO. Making detach always create a fresh singleton
    // instead would fix this one case by changing a contract every OTHER
    // caller of `detachListing` relies on; tracking enough history to
    // reverse the reconciliation precisely would mean building the audit
    // trail `opportunity_decisions` deliberately does not have, by Stage 9's
    // own explicit design choice ("a person changing their mind... owes
    // nobody an audit trail").
    //
    // So the honest response is visibility, not a fabricated fix: if the
    // opportunity being left has a decision recorded, it may now describe a
    // vacancy that opportunity no longer carries, or may always have been
    // the survivor's own — undo cannot tell which. Reported the same way
    // `cleanupTestSource`'s entangled-cluster case already is, for a human
    // to check via the shortlist screen, since the corpus holds zero real
    // decisions today and this is about correctness once it doesn't.
    const [survivorDecision] = await tx
      .select({ id: opportunityDecisions.id })
      .from(opportunityDecisions)
      .where(eq(opportunityDecisions.opportunityId, input.expectedOpportunityId));
    if (survivorDecision !== undefined) {
      console.error(
        `undoAcceptedMerge: opportunity ${input.expectedOpportunityId} has a shortlist decision ` +
          `recorded, and listing ${input.sourceListingId} was just detached from it. That ` +
          'decision may have arrived via this merge and now describes a vacancy this opportunity ' +
          'no longer carries — undo cannot tell. Check it on the shortlist screen.',
      );
    }

    return { ...detachResult, reopenedCandidateIds: reopened };
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
      await reconcileShortlistDecision(tx, previousOpportunityId, input.toOpportunityId);
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
    //
    // Locked, not merely read — and locked TOGETHER with the moving
    // listing's own row, in one query. A first version locked only the
    // moving side, and that gap was real: with fan-out pairs A-B and B-C
    // accepted concurrently, one transaction could read B's membership here
    // UNLOCKED, cache its opportunity id as the merge target, and then — if
    // the OTHER transaction moved B in the meantime and committed first —
    // proceed anyway using a target B no longer occupies, recording A-B as
    // `confirmed_same` while the two remained in different clusters (commit
    // gate, 2026-09-14). Both rows are locked in the SAME query, ordered by
    // id, so two transactions contending for the same pair of listings
    // always request their locks in the same order — the standard way to
    // avoid turning this into a deadlock instead.
    const otherListingId = input.sourceListingId === candidate.a ? candidate.b : candidate.a;
    const bothMemberships = await tx
      .select()
      .from(opportunitySourceMemberships)
      .where(
        and(
          inArray(opportunitySourceMemberships.sourceListingId, [
            input.sourceListingId,
            otherListingId,
          ]),
          isNull(opportunitySourceMemberships.supersededAt),
        ),
      )
      .orderBy(opportunitySourceMemberships.sourceListingId)
      .for('update');
    const ownMembership =
      bothMemberships.find((row) => row.sourceListingId === input.sourceListingId) ?? null;
    const otherMembership =
      bothMemberships.find((row) => row.sourceListingId === otherListingId) ?? null;
    if (otherMembership === null || otherMembership.opportunityId !== input.toOpportunityId) {
      throw new Error(
        `acceptDuplicateCandidate: opportunity ${input.toOpportunityId} does not hold the other ` +
          `side of candidate ${input.candidateId}`,
      );
    }

    // Moving `sourceListingId` must not silently pull it OUT of a cluster it
    // already shares with another listing.
    //
    // The real review queue has genuine fan-out: one listing can sit in
    // several pending `needs_review` pairs at once (verified live — three hr.ge
    // announcements, posted four seconds apart, all scoring as duplicates of
    // one jobs.ge listing). Accepting the first pair is correct. Accepting a
    // SECOND pending pair for the same listing was previously not refused —
    // it silently retired the first membership and moved the listing into a
    // different cluster, with nothing recording that a decision was
    // overwritten.
    //
    // First written as a check on `sourceListingId`'s OWN membership row
    // (`decidedBy === 'human'`), which is not narrow enough: after a merge,
    // only the MOVING side's row gets freshly written with `decidedBy:
    // 'human'` — the SURVIVING side's own row is untouched and can still read
    // `ruleset`. So a listing that anchors a human-confirmed cluster as the
    // survivor, then later becomes the MOVING side of a different pair, read
    // as unprotected: its own row said 'ruleset', the guard did not fire, and
    // it could be pulled out of the cluster it had just been confirmed
    // into — corrupting the FIRST accept without ever touching its row.
    //
    // The check that actually holds is cluster SIZE, not who decided it.
    // `sourceListingId` must not leave an opportunity that currently has more
    // than one live member, full stop — whether that cluster came from a
    // human accept or an automatic `confirmed_same` link, pulling one member
    // out via an unrelated candidate's accept is the same silent corruption
    // either way. The one exception is the stale-link case just below: moving
    // INTO the opportunity it is already in is not a departure at all.
    //
    // No available `DedupeDecision` describes "this became moot" without
    // fabricating a claim nobody made (`confirmed_same` with no merge, or
    // `distinct` with no actual judgment) — the exact class of defect this
    // branch keeps finding — so the fix is a guard, not a resolution of the
    // sibling candidate. Failing loudly here, and leaving the sibling
    // candidate exactly as it was, is the honest answer.
    //
    // `ownMembership` was already locked above, in the same combined query
    // as `otherMembership` — not re-fetched here, so this reasons about
    // exactly the row the earlier check already holds a lock on.
    if (ownMembership !== null && ownMembership.opportunityId !== input.toOpportunityId) {
      const clusterMates = await tx
        .select({ id: opportunitySourceMemberships.id })
        .from(opportunitySourceMemberships)
        .where(
          and(
            eq(opportunitySourceMemberships.opportunityId, ownMembership.opportunityId),
            isNull(opportunitySourceMemberships.supersededAt),
          ),
        );
      if (clusterMates.length > 1) {
        throw new Error(
          `acceptDuplicateCandidate: listing ${input.sourceListingId} already shares an ` +
            `opportunity (${ownMembership.opportunityId}) with another listing. Resolve or ` +
            `re-run dedupe before accepting candidate ${input.candidateId}.`,
        );
      }
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
export interface SplitInput {
  sourceListingId: string;
  canonicalTitle: string;
  type: 'job' | 'summer_school' | 'scholarship' | 'grant' | 'event';
  evidence: Record<string, unknown>;
  actor: ReviewActor;
  at: string;
}

export async function splitListingIntoNewOpportunity(
  db: Database,
  input: SplitInput,
): Promise<{ opportunityId: string; previousOpportunityId: string | null }> {
  return db.transaction(async (tx) => splitListingIntoNewOpportunityWithin(tx, input));
}

/**
 * The body of `splitListingIntoNewOpportunity`, callable inside a
 * transaction the caller already owns.
 *
 * Extracted for the same reason `reassignListingWithin` was: `rejectDuplicateCandidate`
 * needs to split a stale-link pair apart AND resolve the candidate in ONE
 * transaction, and composing the two public functions would open two —
 * reopening exactly the crash-between-them gap Stage 10 closed for accept.
 */
async function splitListingIntoNewOpportunityWithin(
  tx: DatabaseOrTransaction,
  input: SplitInput,
): Promise<{ opportunityId: string; previousOpportunityId: string | null }> {
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
  // Deliberately NO "must be needs_review" guard here, even though the
  // review screen's own callers need exactly that check. This function stays
  // general-purpose on purpose: `run-dedupe.test.ts` records `distinct` on a
  // candidate that already reads `confirmed_same` — a human detaching an
  // auto-linked pair and then correcting the verdict so a later automated
  // pass does not relink it, which starts from `confirmed_same`, not
  // `needs_review`. A precondition here would refuse that legitimate case
  // along with the race it is not.
  //
  // The race — a stale tab or a second submit landing on the SAME pending
  // candidate — is a property of the REVIEW SCREEN's specific verbs, so it is
  // guarded where those verbs are: `acceptDuplicateCandidate` and
  // `rejectDuplicateCandidate` each lock and check `needs_review` themselves,
  // before ever reaching this function, exactly as `acceptDuplicateCandidate`
  // already did before this file added a second caller.
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

/**
 * Rejecting a `needs_review` pair from the review screen: "these are
 * genuinely different vacancies."
 *
 * For most pairs that is exactly what `resolveDuplicateCandidate` alone does
 * — settle the verdict, touch no membership, since the two listings were
 * never merged in the first place.
 *
 * **But not every `needs_review` pair is unmerged.** `run-dedupe.ts` also
 * queues a candidate for an EXISTING automatic merge whose evidence has since
 * evaporated (a shared ATS link that a later revision changed), written back
 * as `needs_review` specifically so a human decides whether to keep it —
 * §14.2 puts unmerging with a person, not the ruleset. Both sides of that
 * kind of pair already share a live opportunity. If a reviewer looks at one
 * and clicks "different vacancies," recording `distinct` alone would leave
 * the screen agreeing with the reviewer while the corpus kept disagreeing —
 * the two listings would still show up merged everywhere else, exactly the
 * lost-provenance failure this file exists to prevent.
 *
 * So this function checks which shape it has, atomically: if both sides
 * currently share a cluster, it SPLITS `input.splitOutListingId` into its own
 * opportunity before recording the verdict; if they do not, it behaves
 * exactly like a plain reject always has. One transaction either way, for the
 * same reason `acceptDuplicateCandidate` is one: a crash between the split
 * and the resolution would leave a listing detached with its candidate still
 * pending, re-queuing a decision the reviewer had already made.
 */
export async function rejectDuplicateCandidate(
  db: Database,
  input: {
    candidateId: string;
    /** Which side to split out, if the pair turns out to share a cluster. */
    splitOutListingId: string;
    /** For the new opportunity, if a split happens. Unused otherwise. */
    canonicalTitle: string;
    actor: ReviewActor;
    at: string;
  },
): Promise<{
  split: boolean;
  splitOpportunityId: string | null;
  previousOpportunityId: string | null;
}> {
  return db.transaction(async (tx) => {
    // Locked and checked FIRST, exactly as `acceptDuplicateCandidate` does —
    // a stale form must not act on a pair someone else already settled.
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
      throw new Error(`rejectDuplicateCandidate: no candidate with id ${input.candidateId}`);
    }
    if (candidate.decision !== 'needs_review') {
      throw new Error(
        `rejectDuplicateCandidate: candidate ${input.candidateId} is not awaiting review ` +
          `(decision: ${candidate.decision ?? 'none'}).`,
      );
    }
    if (input.splitOutListingId !== candidate.a && input.splitOutListingId !== candidate.b) {
      throw new Error(
        `rejectDuplicateCandidate: listing ${input.splitOutListingId} is not part of candidate ` +
          `${input.candidateId}`,
      );
    }

    // Locked TOGETHER, in one query ordered by id — the same reasoning and
    // the same pattern as `acceptDuplicateCandidate`'s combined lock. An
    // unlocked read here let a concurrent transaction move either listing
    // between this check and the split below: `isStaleLink` would be
    // computed against a cluster shape that no longer held by the time
    // `splitListingIntoNewOpportunityWithin` actually ran, detaching the
    // listing from whatever unrelated cluster it had freshly moved into
    // rather than the one this candidate was actually about (commit gate,
    // 2026-09-14).
    const bothMemberships = await tx
      .select()
      .from(opportunitySourceMemberships)
      .where(
        and(
          inArray(opportunitySourceMemberships.sourceListingId, [candidate.a, candidate.b]),
          isNull(opportunitySourceMemberships.supersededAt),
        ),
      )
      .orderBy(opportunitySourceMemberships.sourceListingId)
      .for('update');
    const membershipA = bothMemberships.find((row) => row.sourceListingId === candidate.a) ?? null;
    const membershipB = bothMemberships.find((row) => row.sourceListingId === candidate.b) ?? null;
    const isStaleLink =
      membershipA !== null &&
      membershipB !== null &&
      membershipA.opportunityId === membershipB.opportunityId;

    if (isStaleLink) {
      // Refuse rather than guess when a THIRD listing shares the cluster.
      // §14.1 builds clusters from independent pairwise merges, so a shared
      // opportunity can legitimately hold A~B~C where the reviewer is judging
      // only the A-B pair. Unconditionally splitting B out into its own
      // singleton would also sever a B~C relationship nobody asked about —
      // real data has no 3-member cluster today (checked directly), but the
      // schema and `run-dedupe.ts` both allow one, and this must not silently
      // corrupt it the day one exists. There is no correct partition to guess
      // from here; a human resolves it directly instead.
      const clusterMates = await tx
        .select({ id: opportunitySourceMemberships.id })
        .from(opportunitySourceMemberships)
        .where(
          and(
            eq(opportunitySourceMemberships.opportunityId, membershipA.opportunityId),
            isNull(opportunitySourceMemberships.supersededAt),
          ),
        );
      if (clusterMates.length > 2) {
        throw new Error(
          `rejectDuplicateCandidate: opportunity ${membershipA.opportunityId} has more than two ` +
            `live members, so splitting one out on candidate ${input.candidateId} could sever a ` +
            'relationship this pair never judged. Resolve it directly (npm run browse) instead.',
        );
      }
    }

    let splitOpportunityId: string | null = null;
    let previousOpportunityId: string | null = null;
    if (isStaleLink) {
      // Read fresh, inside this transaction, rather than accepted as a
      // caller-supplied argument: the caller's own read happens before this
      // transaction opens, so a concurrent reassignment between that read and
      // this one could move the listing into a DIFFERENT shared opportunity
      // than the one this split actually acts on, storing the wrong type on
      // the new opportunity while `isStaleLink` itself (computed from the
      // locked membership rows above) stays correct — a caller argument could
      // silently drift from the state the split decision was actually made
      // against (commit gate finding, 2026-09-14).
      const [sharedOpportunity] = await tx
        .select({ type: opportunities.type })
        .from(opportunities)
        .where(eq(opportunities.id, membershipA.opportunityId));
      if (sharedOpportunity === undefined) {
        throw new Error(
          `rejectDuplicateCandidate: opportunity ${membershipA.opportunityId} could not be read`,
        );
      }
      const split = await splitListingIntoNewOpportunityWithin(tx, {
        sourceListingId: input.splitOutListingId,
        canonicalTitle: input.canonicalTitle,
        type: sharedOpportunity.type,
        evidence: { reasons: ['split from a stale automatic link, rejected by a human reviewer'] },
        actor: input.actor,
        at: input.at,
      });
      splitOpportunityId = split.opportunityId;
      previousOpportunityId = split.previousOpportunityId;
    }

    await resolveDuplicateCandidate(tx, {
      candidateId: input.candidateId,
      decision: 'distinct',
      decidedBy: input.actor.decidedBy === 'human' ? 'human' : 'ruleset',
    });

    return { split: isStaleLink, splitOpportunityId, previousOpportunityId };
  });
}
