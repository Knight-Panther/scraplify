'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache.js';
import { redirect } from 'next/navigation.js';
import { db } from '../../../../../src/db/client.js';
import {
  acceptDuplicateCandidate,
  getLiveMembership,
  rejectDuplicateCandidate,
} from '../../../../../src/dedupe/membership-review.js';
import { sourceListingRevisions, sourceListings } from '../../../../../src/db/schema/index.js';
import { requireAdmin } from '../../../../lib/admin-auth.js';
import {
  readCandidateId,
  readMovingListingId,
  readSurvivorListingId,
} from '../../../../lib/review-input.js';
import { assertWritesEnabled } from '../../../../lib/writes.js';

/**
 * Admin's own wrapper around the SAME underlying business logic
 * `(local)/review/actions.ts` calls (`acceptDuplicateCandidate`/
 * `rejectDuplicateCandidate` — `src/dedupe/membership-review.js`), per the
 * Stage 8 plan: a separate action file with its own `requireAdmin()` guard
 * and its own `redirect`/`revalidatePath` targets pointed at
 * `/admin/duplicates`, NOT reused directly from `(local)/review/actions.ts`,
 * whose hardcoded `redirect('/review')` would send a successful admin
 * mutation to a URL the admin surface's own route allow-list 404s.
 *
 * `requireAdmin()` first, matching this file's local counterpart's own
 * `assertLocalSurface()`-first convention — a Server Action is independently
 * reachable by a direct, crafted request regardless of which page nominally
 * renders its form, so a page-level check alone is not authorization for it.
 */

function isKnownReviewConflict(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.startsWith('acceptDuplicateCandidate:') ||
      error.message.startsWith('rejectDuplicateCandidate:'))
  );
}

/** Same translated messages as `(local)/review/actions.ts` — the underlying conflicts are identical. */
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
  return 'That decision could not be made right now. Refresh the page and try again.';
}

function redirectToConflict(error: Error): never {
  redirect(`/admin/duplicates?conflict=${encodeURIComponent(userFacingConflictMessage(error))}`);
}

export async function acceptReviewPair(form: FormData): Promise<void> {
  await requireAdmin();
  assertWritesEnabled();

  const candidateId = readCandidateId(form);
  const survivorListingId = readSurvivorListingId(form);
  const movingListingId = readMovingListingId(form);

  const survivorMembership = await getLiveMembership(db, survivorListingId);
  if (survivorMembership === null) {
    throw new Error(
      `acceptReviewPair: listing ${survivorListingId} has no live membership to merge into.`,
    );
  }

  let conflict: Error | null = null;
  let previousOpportunityId: string | null = null;
  try {
    const result = await acceptDuplicateCandidate(db, {
      candidateId,
      sourceListingId: movingListingId,
      toOpportunityId: survivorMembership.opportunityId,
      confidence: 1,
      evidence: { reasons: ['confirmed by an admin reviewer on the duplicate-review screen'] },
      actor: { decidedBy: 'human', version: 'admin:web' },
      at: new Date().toISOString(),
    });
    previousOpportunityId = result.previousOpportunityId;
  } catch (error) {
    if (!isKnownReviewConflict(error)) throw error;
    conflict = error;
  }

  if (conflict !== null) redirectToConflict(conflict);

  revalidateReviewViews([survivorMembership.opportunityId, previousOpportunityId]);
  redirect('/admin/duplicates');
}

export async function rejectReviewPair(form: FormData): Promise<void> {
  await requireAdmin();
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

  if (listing === undefined) {
    throw new Error(
      `rejectReviewPair: listing ${movingListingId} has no readable title — its current ` +
        'revision could not be found. Resolve this pair directly (npm run browse) instead.',
    );
  }

  let conflict: Error | null = null;
  let splitOpportunityId: string | null = null;
  let previousOpportunityId: string | null = null;
  try {
    const result = await rejectDuplicateCandidate(db, {
      candidateId,
      splitOutListingId: movingListingId,
      canonicalTitle: listing.title,
      actor: { decidedBy: 'human', version: 'admin:web' },
      at: new Date().toISOString(),
    });
    splitOpportunityId = result.splitOpportunityId;
    previousOpportunityId = result.previousOpportunityId;
  } catch (error) {
    if (!isKnownReviewConflict(error)) throw error;
    conflict = error;
  }

  if (conflict !== null) redirectToConflict(conflict);

  revalidateReviewViews([splitOpportunityId, previousOpportunityId]);
  redirect('/admin/duplicates');
}

function revalidateReviewViews(opportunityIds: readonly (string | null)[]): void {
  revalidatePath('/admin/duplicates');
  revalidatePath('/opportunities');
  for (const id of opportunityIds) {
    if (id !== null) revalidatePath(`/opportunities/${id}`);
  }
}
