'use server';

import { revalidatePath } from 'next/cache.js';
import { redirect } from 'next/navigation.js';
import { db } from '../../../src/db/client.js';
import {
  approveDraft,
  deleteDraft,
  editDraft,
  loadDraft,
  OutreachError,
} from '../../../src/outreach/draft-store.js';
import { DraftGenerationFailedError, generateDraft } from '../../../src/outreach/generate-draft.js';
import {
  InvalidDraftInputError,
  readDraftEdit,
  readDraftId,
  readDraftProfileId,
  readExpectedContentHash,
  readExpectedGenerationInputs,
  readGenerationConsent,
  readLanguage,
  readOpportunityId,
} from '../../lib/draft-input.js';
import { assertWritesEnabled } from '../../lib/writes.js';

/**
 * Outreach draft mutations (Phase 6A). Every one is behind
 * `assertWritesEnabled()`, and every expected refusal — missing consent, a
 * stale draft, a failed generation — redirects back with a plain message
 * instead of reaching the generic error boundary, the same pattern
 * `profile/actions.ts` uses.
 *
 * None of these sends anything. Approval records that a person approved exact
 * content; what they then do with it stays in their own hands.
 */

function isExpected(
  error: unknown,
): error is OutreachError | InvalidDraftInputError | DraftGenerationFailedError {
  return (
    error instanceof OutreachError ||
    error instanceof InvalidDraftInputError ||
    error instanceof DraftGenerationFailedError
  );
}

function withError(path: string, error: Error): string {
  const base = `${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(error.message)}`;
  // The code, when the error carries one, lets the client distinguish
  // WHICH refusal happened without parsing prose — used today only to spot
  // a stale-save conflict and recover the rejected tab's unsaved text (see
  // `draft-conflict-recovery.tsx`), but generically useful for any future
  // case that needs the same.
  return error instanceof OutreachError ? `${base}&code=${error.code}` : base;
}

export async function generateDraftAction(form: FormData): Promise<void> {
  assertWritesEnabled();
  const profileId = readDraftProfileId(form);
  const opportunityId = readOpportunityId(form);
  const back = `/drafts/new?profile=${profileId}&opportunity=${opportunityId}`;

  let target: string;
  try {
    if (!readGenerationConsent(form)) {
      throw new InvalidDraftInputError(
        'You must acknowledge that your profile claims and this listing are sent to Anthropic’s API to continue.',
      );
    }
    const language = readLanguage(form);
    const expected = readExpectedGenerationInputs(form);
    const draft = await generateDraft(db, {
      profileId,
      opportunityId,
      ...(language === undefined ? {} : { language }),
      now: new Date().toISOString(),
      expected,
    });
    target = `/drafts/${draft.id}`;
  } catch (error) {
    if (!isExpected(error)) throw error;
    target = withError(back, error);
  }
  revalidatePath('/drafts');
  redirect(target);
}

export async function saveDraftAction(form: FormData): Promise<void> {
  assertWritesEnabled();
  const draftId = readDraftId(form);
  let target = `/drafts/${draftId}?saved=1`;
  try {
    const { subject, body } = readDraftEdit(form);
    // Same hidden field Approve already reads (see approveDraftAction below) —
    // rendered once, unconditionally, in the shared edit form. Catches two
    // tabs open on the same draft: without it, a stale tab's Save would
    // silently overwrite whatever the other tab already wrote.
    const expectedContentHash = readExpectedContentHash(form);
    await editDraft(db, {
      draftId,
      subject,
      body,
      expectedContentHash,
      now: new Date().toISOString(),
    });
  } catch (error) {
    if (!isExpected(error)) throw error;
    target = withError(`/drafts/${draftId}`, error);
  }
  revalidatePath('/drafts');
  redirect(target);
}

export async function approveDraftAction(form: FormData): Promise<void> {
  assertWritesEnabled();
  const draftId = readDraftId(form);
  let target = `/drafts/${draftId}?approved=1`;
  try {
    // The approve button is a `formAction` override on the SAME form as
    // Save (see draft-approval-guard.tsx), so this posts the current
    // subject/body fields too — not just draftId and a hash — and
    // `approveDraft` checks them against what is actually stored.
    const { subject, body } = readDraftEdit(form);
    await approveDraft(db, {
      draftId,
      expectedContentHash: readExpectedContentHash(form),
      visibleSubject: subject,
      visibleBody: body,
      now: new Date().toISOString(),
    });
  } catch (error) {
    if (!isExpected(error)) throw error;
    target = withError(`/drafts/${draftId}`, error);
  }
  revalidatePath('/drafts');
  redirect(target);
}

/**
 * Whether a draft's approval is current RIGHT NOW, called directly from
 * `draft-approval-guard.tsx` (not a `<form>` action) immediately before
 * revealing or acting on Copy / "open in your mail app".
 *
 * The client-side dirty guard only ever sees this ONE tab's edit form — it
 * cannot know that another tab saved an edit, that the profile was revised,
 * or that a crawl advanced the listing while this page stayed open, any of
 * which invalidates the approval on the server without this tab's form ever
 * becoming "dirty". A stale-but-confident page would then let Copy and the
 * static `mailto:` link keep serving text that is no longer approved. This
 * re-reads the real, authoritative check (`approvalState`, which never
 * trusts a stored flag) and fails closed: anything other than an exact,
 * still-current match refuses.
 */
export async function checkApprovalCurrentAction(
  draftId: string,
  expectedContentHash: string,
): Promise<boolean> {
  const loaded = await loadDraft(db, draftId);
  if (loaded === null) return false;
  return (
    loaded.approval.status === 'current' && loaded.approval.contentHash === expectedContentHash
  );
}

export async function deleteDraftAction(form: FormData): Promise<void> {
  assertWritesEnabled();
  const draftId = readDraftId(form);
  let target = '/drafts?deleted=1';
  try {
    await deleteDraft(db, draftId, new Date().toISOString());
  } catch (error) {
    if (!isExpected(error)) throw error;
    target = withError('/drafts', error);
  }
  revalidatePath('/drafts');
  redirect(target);
}
