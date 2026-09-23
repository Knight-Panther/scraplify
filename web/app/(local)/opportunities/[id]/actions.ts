'use server';

import { revalidatePath } from 'next/cache.js';
import { redirect } from 'next/navigation.js';
import { db } from '../../../../../src/db/client.js';
import { undoAcceptedMerge } from '../../../../../src/dedupe/membership-review.js';
import { assertWritesEnabled } from '../../../../lib/writes.js';

/**
 * The undo for a merge made anywhere — the review screen, an earlier
 * `reassignListing` call, or an automatic link — reachable from the one
 * screen with enough context to judge it: the boards compared side by side.
 *
 * Its absence was a real gap: the review screen's "Same vacancy — merge"
 * accepts into a cluster, and until this action existed no web route could
 * undo that click. A reviewer who merged the wrong pair had no way back
 * except direct database access — the exact failure Phase 3's own exit gate
 * ("the stored corpus can be inspected and corrected without direct database
 * access") exists to rule out.
 *
 * `undoAcceptedMerge`, not the bare `detachListing`: a detach alone left the
 * `duplicate_candidates` row claiming `confirmed_same` from a human,
 * decoupled from any membership that still supports it — which either gets
 * silently re-linked by a later dedupe pass, or, since that pass refuses to
 * overwrite a human verdict, sits there PERMANENTLY suppressing the pair from
 * ever being reconsidered (commit gate, 2026-09-14). `undoAcceptedMerge`
 * reopens the candidate atomically with the detach, so "undo" is a complete
 * correction rather than half of one.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readUuid(form: FormData, field: string): string {
  const raw = form.get(field);
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!UUID.test(id)) {
    throw new Error(`detachFromOpportunity: a valid ${field} is required.`);
  }
  return id;
}

export async function detachFromOpportunity(form: FormData): Promise<void> {
  assertWritesEnabled();

  const sourceListingId = readUuid(form, 'sourceListingId');
  // The opportunity THIS PAGE is currently showing, not merely the listing —
  // `undoAcceptedMerge` checks the two still match, under lock, before
  // touching anything. Without it, a stale page (another decision, a fresh
  // dedupe pass, or a direct correction moved the listing since this page
  // loaded) could detach the listing from a cluster the reviewer never
  // looked at (commit gate, 2026-09-14).
  const expectedOpportunityId = readUuid(form, 'expectedOpportunityId');

  // The mismatch `undoAcceptedMerge` refuses on (a stale page, the listing
  // moved since it loaded) is expected and real, not a bug — so it is caught
  // and turned into an inline, refreshable message on the SAME page, rather
  // than left to fall through to the generic error boundary, which would
  // tell the reader the opportunity failed to load and Postgres is probably
  // down when the actual cause is "this changed under you" (commit gate,
  // 2026-09-14). `redirect()` itself throws, so it is called OUTSIDE the
  // try/catch, matching the review screen's own established pattern.
  let conflict: Error | null = null;
  let result: Awaited<ReturnType<typeof undoAcceptedMerge>> | null = null;
  try {
    result = await undoAcceptedMerge(db, {
      sourceListingId,
      expectedOpportunityId,
      at: new Date().toISOString(),
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('undoAcceptedMerge:')) throw error;
    conflict = error;
  }

  if (conflict !== null) {
    redirect(
      `/opportunities/${expectedOpportunityId}?conflict=${encodeURIComponent(
        'This changed since the page loaded — refresh to see the current state before undoing.',
      )}`,
    );
  }
  if (result === null) return;

  // The listing now has NO opportunity at all — detaching deliberately does
  // not create one, since "these are not the same vacancy" and "this listing
  // has its own" are different claims. It surfaces unmerged on the listings
  // view; giving it a fresh singleton opportunity, if that turns out to be
  // wanted, is what `splitListingIntoNewOpportunity` is for, not this action.
  //
  // Any reopened candidate now shows up on /review again — this listing's
  // pair is genuinely awaiting a decision once more, which is what "undo"
  // means here.
  revalidatePath('/review');
  revalidatePath('/opportunities');
  revalidatePath('/listings');
  if (result.detachedFrom !== null) revalidatePath(`/opportunities/${result.detachedFrom}`);
}
