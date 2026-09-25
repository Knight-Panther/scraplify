'use server';

import { revalidatePath } from 'next/cache.js';
import { redirect } from 'next/navigation.js';
import {
  correctClassification,
  type ClassificationVerdict,
  undoClassificationCorrection,
} from '../../../../../src/taxonomy/correct-classification.js';
import {
  auditedMutation,
  recordFailure,
  requireAdminAudited,
} from '../../../../lib/admin-audit.js';
import { readClassificationId } from '../../../../lib/taxonomy-review-input.js';
import { assertWritesEnabled } from '../../../../lib/writes.js';

/**
 * Admin's own wrapper around the SAME underlying `correctClassification`/
 * `undoClassificationCorrection` (`src/taxonomy/correct-classification.js`)
 * `(local)/taxonomy-review/actions.ts` calls — same reasoning as
 * `(admin)/admin/duplicates/actions.ts`'s own header comment: a separate
 * file, `requireAdmin()`-guarded, redirecting back to `/admin/taxonomy`
 * rather than `(local)/taxonomy-review/actions.ts`'s hardcoded `/taxonomy-review`.
 *
 * Stage 11: `requireAdminAudited`/`auditedMutation` (`web/lib/admin-audit.js`)
 * replace the bare `requireAdmin()` + direct mutation calls — see that
 * module's own header comment for the three-outcome audit design.
 */

/** Best-effort, side-effect-free — `null` on a malformed field rather than throwing, so `requireAdminAudited` still runs the real auth check either way. */
function safeClassificationId(form: FormData): string | null {
  try {
    return readClassificationId(form);
  } catch {
    return null;
  }
}

function isKnownCorrectionConflict(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.startsWith('correctClassification:') ||
      error.message.startsWith('undoClassificationCorrection:'))
  );
}

function userFacingConflictMessage(error: Error): string {
  if (error.message.includes('already corrected')) {
    return 'Someone else already corrected this classification. Reload to see the current state.';
  }
  if (error.message.includes('nothing to undo')) {
    return 'This classification was never itself a correction, so there is nothing to undo.';
  }
  if (error.message.includes('already live')) {
    return 'This correction may already have been undone by someone else.';
  }
  return 'This correction could not be completed. Reload and try again.';
}

function redirectToConflict(error: Error): never {
  redirect(`/admin/taxonomy?conflict=${encodeURIComponent(userFacingConflictMessage(error))}`);
}

async function correct(form: FormData, verdict: ClassificationVerdict): Promise<void> {
  const action = verdict === 'confirmed' ? 'taxonomy_confirm' : 'taxonomy_reject';
  // Read once, best-effort, before auth — reused for `requireAdminAudited`'s
  // own refusal audit AND as the `entityId` fallback if the strict re-read
  // inside the try (below) is itself what throws.
  const classificationIdForAudit = safeClassificationId(form);
  const session = await requireAdminAudited(
    action,
    'listing_classification',
    classificationIdForAudit,
  );
  assertWritesEnabled();

  let conflict: Error | null = null;
  let newClassificationId: string | null = null;
  // Computed once, shared by every audit row this attempt might write and by
  // the mutation itself, so `admin_audit_events.occurred_at` matches the
  // classification row's own timestamp exactly rather than drifting by a
  // millisecond or two.
  const at = new Date().toISOString();
  try {
    // Field parsing is now INSIDE this try, not before it (Codex,
    // 2026-09-24): a genuinely authorized, writes-enabled admin whose
    // attempt fails at this step still needs a `failed` audit row, same as
    // one that fails inside `auditedMutation` itself.
    const classificationId = readClassificationId(form);

    const result = await auditedMutation({
      actorGithubId: session.user.githubId ?? 'unknown',
      entityType: 'listing_classification',
      entityId: classificationId,
      action,
      at,
      mutate: (tx) =>
        correctClassification(tx, {
          classificationId,
          verdict,
          evidence: {
            reasons: [
              verdict === 'confirmed'
                ? 'confirmed by an admin reviewer on the taxonomy screen'
                : 'rejected by an admin reviewer on the taxonomy screen',
            ],
          },
          at,
        }),
    });
    newClassificationId = result.newClassificationId;
  } catch (error) {
    await recordFailure({
      actorGithubId: session.user.githubId ?? 'unknown',
      entityType: 'listing_classification',
      entityId: classificationIdForAudit,
      action,
      at,
      error,
    });
    if (!isKnownCorrectionConflict(error)) throw error;
    conflict = error;
  }

  if (conflict !== null) redirectToConflict(conflict);

  revalidatePath('/admin/taxonomy');
  redirect(`/admin/taxonomy?corrected=${newClassificationId}`);
}

export async function confirmClassification(form: FormData): Promise<void> {
  await correct(form, 'confirmed');
}

export async function rejectClassification(form: FormData): Promise<void> {
  await correct(form, 'rejected');
}

export async function undoCorrection(form: FormData): Promise<void> {
  const classificationIdForAudit = safeClassificationId(form);
  const session = await requireAdminAudited(
    'taxonomy_undo',
    'listing_classification',
    classificationIdForAudit,
  );
  assertWritesEnabled();

  // See correct()'s own comment: computed once, shared by every audit row
  // this attempt might write and by the mutation itself.
  const at = new Date().toISOString();
  let conflict: Error | null = null;
  try {
    // Field parsing is now INSIDE this try — see correct()'s own comment.
    const classificationId = readClassificationId(form);
    await auditedMutation({
      actorGithubId: session.user.githubId ?? 'unknown',
      entityType: 'listing_classification',
      entityId: classificationId,
      action: 'taxonomy_undo',
      at,
      mutate: (tx) => undoClassificationCorrection(tx, { classificationId, at }),
    });
  } catch (error) {
    await recordFailure({
      actorGithubId: session.user.githubId ?? 'unknown',
      entityType: 'listing_classification',
      entityId: classificationIdForAudit,
      action: 'taxonomy_undo',
      at,
      error,
    });
    if (!isKnownCorrectionConflict(error)) throw error;
    conflict = error;
  }

  if (conflict !== null) redirectToConflict(conflict);

  revalidatePath('/admin/taxonomy');
  redirect('/admin/taxonomy');
}
