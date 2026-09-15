import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { listingClassifications } from '../db/schema/index.js';
import type { Database, DatabaseOrTransaction } from '../db/types.js';

/**
 * The id of the row that represents a (revision, term) pair's CURRENT
 * state — the same "prefer live, else the most recent retired row" rule
 * `classifyListings`'s own lookup uses, not a plain "most recent by
 * `createdAt`". Plain recency isn't enough: an undo can make an OLDER row
 * live again while the correction it undid stays chronologically newer but
 * retired — undoing THAT correction a second time would be nonsensical (it
 * already has been), yet a pure `createdAt` ordering would still call it
 * "the head" (caught by this file's own tests, not a design review —
 * `canUndoCorrection` reported a just-undone correction as still undoable,
 * commit gate finding, 2026-09-15).
 *
 * Shared between `undoClassificationCorrection` (read under lock, inside
 * its own transaction) and `canUndoCorrection` (a read-only, advisory check
 * for the UI, with no lock — see that function's own doc comment for why
 * that's fine here).
 */
async function currentPairHeadId(
  db: DatabaseOrTransaction,
  pair: { sourceListingRevisionId: string; taxonomyTermId: string },
): Promise<string | undefined> {
  const rows = await db
    .select({ id: listingClassifications.id, supersededAt: listingClassifications.supersededAt })
    .from(listingClassifications)
    .where(
      and(
        eq(listingClassifications.sourceListingRevisionId, pair.sourceListingRevisionId),
        eq(listingClassifications.taxonomyTermId, pair.taxonomyTermId),
      ),
    )
    .orderBy(asc(listingClassifications.createdAt));

  let head: { id: string; supersededAt: string | null } | undefined;
  for (const row of rows) {
    if (head === undefined || row.supersededAt === null || head.supersededAt !== null) {
      head = row;
    }
  }
  return head?.id;
}

export type ClassificationVerdict = 'confirmed' | 'rejected';

export interface CorrectClassificationInput {
  classificationId: string;
  verdict: ClassificationVerdict;
  evidence: { reasons: string[] };
  at: string;
}

export interface CorrectClassificationResult {
  newClassificationId: string;
}

/**
 * A human correcting a classification — confirm ("the term is right") or
 * reject ("this listing shouldn't be filed under this term"). Both retire
 * the live row and insert a new one, mirroring `membership-review.ts`'s
 * append-only pattern: a correction is a judgment about whether the
 * source's own claim was right, the same kind of fact a duplicate-merge
 * verdict is, not a preference a person just changes their mind about.
 *
 * - Confirm inserts a new LIVE row: `method: 'human_review'`,
 *   `confidence: 1` — removes it from the ambiguous queue permanently, and
 *   `classifyListings`/`seedTaxonomyTerms`'s existing "never touch a
 *   non-deterministic_rule row" guards protect it from a later backfill
 *   re-run.
 * - Reject inserts a new row BORN already superseded (its own `createdAt`
 *   is also its `supersededAt`) — no live row remains for the pair, but the
 *   decision itself (who/what/when/why, via `method`/`evidence`/`createdAt`)
 *   is a permanent, queryable record, not an inference from absence.
 *
 * Both set `previousClassificationId` to the row they replaced, which is
 * what makes `undoClassificationCorrection` possible.
 */
export async function correctClassification(
  db: Database,
  input: CorrectClassificationInput,
): Promise<CorrectClassificationResult> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, input.classificationId))
      .for('update');

    if (existing === undefined) {
      throw new Error(`correctClassification: no classification with id ${input.classificationId}`);
    }
    if (existing.supersededAt !== null) {
      throw new Error(
        `correctClassification: classification ${input.classificationId} was already ` +
          'corrected by someone else — reload and try again.',
      );
    }

    const at = input.at;
    await tx
      .update(listingClassifications)
      .set({ supersededAt: at })
      .where(eq(listingClassifications.id, existing.id));

    const newId = randomUUID();
    const confirmed = input.verdict === 'confirmed';
    await tx.insert(listingClassifications).values({
      id: newId,
      sourceListingRevisionId: existing.sourceListingRevisionId,
      taxonomyTermId: existing.taxonomyTermId,
      axis: existing.axis,
      method: 'human_review',
      confidence: confirmed ? 1 : 0,
      evidence: input.evidence,
      taxonomyVersion: existing.taxonomyVersion,
      createdAt: at,
      // A rejection is born already retired — the pair has no live
      // classification once rejected, but the verdict itself still exists
      // as a row, not merely an absence.
      supersededAt: confirmed ? null : at,
      previousClassificationId: existing.id,
    });

    return { newClassificationId: newId };
  });
}

/**
 * Undoes the single most recent correction on a pair, following
 * `previousClassificationId` back one step — not a full history browser,
 * just the "undo what I just did" affordance the correction screen offers
 * immediately after a confirm/reject (commit gate finding, 2026-09-15: a
 * correction with no undo path at all is a real gap).
 */
export async function undoClassificationCorrection(
  db: Database,
  input: { classificationId: string; at: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [correction] = await tx
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, input.classificationId))
      .for('update');

    if (correction === undefined) {
      throw new Error(
        `undoClassificationCorrection: no classification with id ${input.classificationId}`,
      );
    }
    if (correction.previousClassificationId === null) {
      throw new Error(
        `undoClassificationCorrection: classification ${input.classificationId} was not itself ` +
          'a correction — there is nothing to undo.',
      );
    }

    // Lock `previous` BEFORE checking whether `correction` is still the
    // pair's head — not after. A concurrent `correctClassification` call
    // targeting this same pair locks exactly this row too (whatever is
    // currently live IS `previous` once undo reactivates it), so acquiring
    // this lock first forces the two operations to serialize: either we get
    // here first and a concurrent correction blocks until we commit, or a
    // concurrent correction is already mid-flight and we block until IT
    // commits — and then see its result once we proceed. Checking the head
    // BEFORE taking this lock (an earlier version of this fix) left a real
    // gap: the head-check could read "no later correction yet", then block
    // waiting for the lock a concurrent correction already held, and once
    // that correction committed and released it, proceed on the now-stale
    // answer — reactivating `previous` regardless of what the concurrent
    // correction had just decided (commit gate finding, 2026-09-15).
    const [previous] = await tx
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, correction.previousClassificationId))
      .for('update');

    if (previous === undefined) {
      throw new Error(
        `undoClassificationCorrection: the classification ${input.classificationId} replaced ` +
          `(${correction.previousClassificationId}) no longer exists.`,
      );
    }

    // `correction` must still be the pair's CURRENT head. Checking only for
    // a direct successor (something pointing at `correction` via
    // `previousClassificationId`) is not enough: undo(A) already re-lives
    // A's OWN predecessor, so a later correction on the same pair chains
    // from THAT row, not from A — nothing ever points at A again, yet A is
    // no longer current. Performed only now, after the lock above, so its
    // answer cannot go stale before it's acted on.
    const headId = await currentPairHeadId(tx, correction);
    if (headId !== correction.id) {
      throw new Error(
        `undoClassificationCorrection: classification ${input.classificationId} is no longer ` +
          'the most recent correction for this pair — reload and try again.',
      );
    }
    if (previous.supersededAt === null) {
      throw new Error(
        `undoClassificationCorrection: classification ${correction.previousClassificationId} ` +
          'is already live — this correction may have already been undone.',
      );
    }

    // The correction may already be retired (a rejection is born that way);
    // only retire it if it was actually live.
    if (correction.supersededAt === null) {
      await tx
        .update(listingClassifications)
        .set({ supersededAt: input.at })
        .where(eq(listingClassifications.id, correction.id));
    }
    await tx
      .update(listingClassifications)
      .set({ supersededAt: null })
      .where(eq(listingClassifications.id, previous.id));
  });
}

/**
 * Whether `classificationId` is genuinely undoable RIGHT NOW — i.e.
 * `undoClassificationCorrection` would not immediately refuse it. Read-only,
 * unlocked: this exists so the "Corrected. Undo?" banner can be verified
 * before it's shown, not to make the undo itself safe (the transactional
 * checks inside `undoClassificationCorrection` remain the real guard).
 *
 * Without this, a hand-edited or merely stale `?corrected=` URL parameter
 * (left open in a tab after another reviewer already undid or superseded
 * that exact correction) would render a banner claiming success and offer
 * an undo action guaranteed to fail the moment it's clicked — a fabricated
 * success state, not merely a redundant one (commit gate finding,
 * 2026-09-15).
 */
export async function canUndoCorrection(
  db: DatabaseOrTransaction,
  classificationId: string,
): Promise<boolean> {
  const [correction] = await db
    .select()
    .from(listingClassifications)
    .where(eq(listingClassifications.id, classificationId));
  if (correction === undefined || correction.previousClassificationId === null) return false;
  const headId = await currentPairHeadId(db, correction);
  return headId === correction.id;
}
