'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache.js';
import { redirect } from 'next/navigation.js';
import { db } from '../../../../src/db/client.js';
import {
  acceptDuplicateCandidate,
  getLiveMembership,
  rejectDuplicateCandidate,
} from '../../../../src/dedupe/membership-review.js';
import { sourceListingRevisions, sourceListings } from '../../../../src/db/schema/index.js';
import {
  readCandidateId,
  readMovingListingId,
  readSurvivorListingId,
} from '../../../lib/review-input.js';
import { assertWritesEnabled } from '../../../lib/writes.js';

/**
 * A refusal `acceptDuplicateCandidate` or `rejectDuplicateCandidate` raises
 * on purpose — a fan-out conflict, a candidate someone else already settled —
 * as opposed to an unexpected failure (Postgres unreachable, a genuine bug).
 *
 * Distinguished by the message prefix both functions use for every `throw`
 * they own, rather than a typed error class: this catches exactly the errors
 * those two functions raise deliberately, and lets anything else (a raw
 * driver error carries no such prefix) fall through to the real error
 * boundary, where "the usual cause is Postgres is not running" is the honest
 * message.
 */
function isKnownReviewConflict(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.startsWith('acceptDuplicateCandidate:') ||
      error.message.startsWith('rejectDuplicateCandidate:'))
  );
}

/**
 * Translates a known conflict into copy this screen may actually show.
 *
 * The internal error carries listing, opportunity and candidate UUIDs and
 * function-name jargon — exactly what `anti-patterns.md`'s "Vocabulary"
 * section forbids in the interface ("raw enums or IDs", "untranslated jargon
 * from the codebase"). It was being rendered VERBATIM in the first version of
 * this screen (commit gate, 2026-09-14). The internal message stays useful —
 * it is what a server log or a thrown, unrecognised error still carries — but
 * what a reader sees is a plain sentence naming the actual situation and what
 * to do about it, matched by which guard actually fired.
 */
function userFacingConflictMessage(error: Error): string {
  if (error.message.includes('already shares an opportunity')) {
    return 'This listing was already merged with another one by a separate decision — accepting this pair would pull it back out. Re-run the dedupe pass or settle it directly with npm run browse.';
  }
  if (error.message.includes('more than two live members')) {
    return 'This pair is part of a larger group of merged listings, so rejecting it here could affect listings nobody has reviewed. Resolve it directly with npm run browse.';
  }
  if (error.message.includes('is not awaiting review')) {
    return 'Someone already settled this pair. Refresh the page to see the current queue.';
  }
  if (error.message.includes('no candidate with id')) {
    return 'This pair could not be found — it may have just been settled elsewhere. Refresh the page.';
  }
  if (error.message.includes('is not part of candidate')) {
    return 'This decision no longer matches what is on screen. Refresh the page and try again.';
  }
  // Any other refusal these two functions raise deliberately: shown as a
  // last resort, still safer than the raw internal message.
  return 'That decision could not be made right now. Refresh the page and try again.';
}

/**
 * Sends the reader back to a CLEAN queue URL with a translated conflict
 * message, via `redirect()` — which Next intercepts as a `NEXT_REDIRECT`
 * signal rather than a thrown error reaching `error.tsx`, the documented way
 * to hand a Server Action's outcome back to a plain form with no client
 * JavaScript. `redirect()` itself throws, so it must be called OUTSIDE any
 * try/catch.
 */
function redirectToConflict(error: Error): never {
  redirect(`/review?conflict=${encodeURIComponent(userFacingConflictMessage(error))}`);
}

/**
 * The duplicate-review screen's writes, following the shortlist's template
 * (`web/app/(local)/saved/actions.ts`) exactly: `assertWritesEnabled()` before any
 * read, plain `<form action={...}>` with no client JavaScript, `revalidatePath`
 * after every write.
 *
 * These are genuinely destructive in a way the shortlist's are not.
 * `resolveDuplicateCandidate` permanently marks a candidate as adjudicated —
 * there is no "clear" for it, unlike a shortlist decision — and only 11 real
 * pending pairs exist to be consumed. `npm run dev` points at the live corpus
 * and these throw; `npm run dev:web:qa` points at a disposable copy.
 */

/**
 * Merges a pair: moves the `moving` listing into the `survivor`'s opportunity.
 *
 * The survivor is decided by the page (`pickSurvivor` in `review-pair.ts`),
 * not by the form — deterministic, so which id ends up as the surviving
 * opportunity is not a per-click choice. The action still validates it:
 * `acceptDuplicateCandidate` requires the target to be where the OTHER side of
 * the pair already lives, so a form tampered to name the wrong opportunity
 * fails there rather than silently merging into an unrelated cluster.
 *
 * Confidence 1.0, not a ruleset score: a human looked at both boards side by
 * side and confirmed it, which is a different kind of claim from a threshold
 * crossing, and `decidedBy: 'human'` is what stops the next automated pass
 * from overwriting it.
 */
export async function acceptReviewPair(form: FormData): Promise<void> {
  assertWritesEnabled();

  const candidateId = readCandidateId(form);
  const survivorListingId = readSurvivorListingId(form);
  const movingListingId = readMovingListingId(form);

  const survivorMembership = await getLiveMembership(db, survivorListingId);
  if (survivorMembership === null) {
    // Every listing has its own singleton opportunity from ingestion, so this
    // should not happen against real data — surfaced as a clear error rather
    // than a null-pointer crash if it ever does.
    throw new Error(
      `acceptReviewPair: listing ${survivorListingId} has no live membership to merge into.`,
    );
  }

  // A fan-out conflict here (a sibling candidate sharing a listing this pair
  // no longer shares, per the guard in acceptDuplicateCandidate) is EXPECTED
  // — the queue's own real data has this shape. Caught and turned into a
  // redirect with the refusal's own message, rather than the generic "Postgres
  // may be down" error boundary misdescribing a business conflict as an
  // infrastructure failure.
  let conflict: Error | null = null;
  let previousOpportunityId: string | null = null;
  try {
    const result = await acceptDuplicateCandidate(db, {
      candidateId,
      sourceListingId: movingListingId,
      toOpportunityId: survivorMembership.opportunityId,
      confidence: 1,
      evidence: { reasons: ['confirmed by a human reviewer on the duplicate-review screen'] },
      actor: { decidedBy: 'human', version: 'operator:web' },
      at: new Date().toISOString(),
    });
    previousOpportunityId = result.previousOpportunityId;
  } catch (error) {
    if (!isKnownReviewConflict(error)) throw error;
    conflict = error;
  }

  if (conflict !== null) redirectToConflict(conflict);

  // Both clusters changed: the survivor's gained a member, and the moving
  // listing's previous opportunity lost one (and may now be empty). Neither
  // detail page is covered by revalidating the list alone.
  revalidateReviewViews([survivorMembership.opportunityId, previousOpportunityId]);

  // A clean URL, not whatever this request arrived with. Without this, a
  // reviewer who lands on /review?conflict=... from an earlier refusal and
  // then successfully accepts a DIFFERENT pair keeps seeing the stale
  // refusal — a plain form submit does not change the URL on its own, and
  // revalidatePath only invalidates cache, it does not navigate (commit
  // gate, 2026-09-14).
  redirect('/review');
}

/**
 * Settles a pair as distinct — two different vacancies, not the same one.
 *
 * Usually touches no membership: the two listings were never merged, and
 * `rejectDuplicateCandidate` records the verdict and stops there. But not
 * every `needs_review` pair is unmerged — `run-dedupe.ts` also re-queues an
 * EXISTING automatic merge when the evidence behind it evaporates, and both
 * sides of that kind already share a live opportunity. Rejecting one of
 * those must actually split the listings apart, or the screen would agree
 * with the reviewer while the corpus kept disagreeing. `movingListingId` is
 * the side that gets split out if this turns out to be that case.
 *
 * The title and type for a split are read FRESH from the database rather
 * than trusted from the form, matching this screen's own rule for every
 * other field: nothing but validated ids ever comes from client input here.
 */
export async function rejectReviewPair(form: FormData): Promise<void> {
  assertWritesEnabled();

  const candidateId = readCandidateId(form);
  const movingListingId = readMovingListingId(form);

  const [listing] = await db
    .select({ title: sourceListingRevisions.titleRaw })
    .from(sourceListings)
    .innerJoin(
      sourceListingRevisions,
      eq(sourceListingRevisions.id, sourceListings.currentRevisionId),
    )
    .where(eq(sourceListings.id, movingListingId));

  // Refused, not fabricated. `sourceListings.currentRevisionId` is nullable
  // (a listing that never successfully parsed has none), so `listing` can
  // genuinely come back empty — and the first version of this action filled
  // that gap with an invented title, which `rejectDuplicateCandidate`'s
  // stale-link branch would then store as a REAL, permanent canonical title
  // if a split happened to be needed (commit gate, 2026-09-14) — exactly the
  // fabricated-data failure this project treats as P1 everywhere else. A
  // clear refusal here is the honest alternative: there is no reliable value
  // to use, so none is invented.
  //
  // `type` is deliberately NOT read or passed here at all (it was, until a
  // supplementary review after commit gate round 4 caught it): pre-fetching
  // it outside this action's transaction let a concurrent reassignment move
  // the listing between this read and `rejectDuplicateCandidate`'s own
  // locked check, so the split — if one happened — could store a type read
  // from a DIFFERENT opportunity than the one actually being split from.
  // `rejectDuplicateCandidate` now resolves it itself, inside the same
  // locked transaction that decides whether a split happens at all.
  if (listing === undefined) {
    throw new Error(
      `rejectReviewPair: listing ${movingListingId} has no readable title — its current ` +
        'revision could not be found. Resolve this pair directly (npm run browse) instead.',
    );
  }

  // Same reasoning as acceptReviewPair: a race with another decision on this
  // candidate is expected, real, and deserves an inline message rather than
  // the generic error boundary.
  let conflict: Error | null = null;
  let splitOpportunityId: string | null = null;
  let previousOpportunityId: string | null = null;
  try {
    const result = await rejectDuplicateCandidate(db, {
      candidateId,
      splitOutListingId: movingListingId,
      canonicalTitle: listing.title,
      actor: { decidedBy: 'human', version: 'operator:web' },
      at: new Date().toISOString(),
    });
    splitOpportunityId = result.splitOpportunityId;
    previousOpportunityId = result.previousOpportunityId;
  } catch (error) {
    if (!isKnownReviewConflict(error)) throw error;
    conflict = error;
  }

  if (conflict !== null) redirectToConflict(conflict);

  // A plain reject touches no opportunity, so only the queue changes. A
  // split changes two: the cluster the listing left, and the new one it
  // landed in — both null when nothing split.
  revalidateReviewViews([splitOpportunityId, previousOpportunityId]);

  // See acceptReviewPair's own comment: a clean URL, so an earlier refusal
  // does not keep showing after a later, unrelated success.
  redirect('/review');
}

/**
 * Every screen a merge or a rejection changes, not just the queue.
 *
 * A merge moves a listing between opportunities, which changes both clusters'
 * pages and the two lists they appear in — the same reasoning as the
 * shortlist's `revalidateShortlistViews`, widened to the specific opportunity
 * ids this screen actually touches rather than only the list route.
 */
function revalidateReviewViews(opportunityIds: readonly (string | null)[]): void {
  revalidatePath('/review');
  revalidatePath('/opportunities');
  for (const id of opportunityIds) {
    if (id !== null) revalidatePath(`/opportunities/${id}`);
  }
}
