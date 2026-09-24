'use server';

import { revalidatePath } from 'next/cache.js';
import { redirect } from 'next/navigation.js';
import { db } from '../../../../../src/db/client.js';
import {
  correctClassification,
  type ClassificationVerdict,
  undoClassificationCorrection,
} from '../../../../../src/taxonomy/correct-classification.js';
import { requireAdmin } from '../../../../lib/admin-auth.js';
import { readClassificationId } from '../../../../lib/taxonomy-review-input.js';
import { assertWritesEnabled } from '../../../../lib/writes.js';

/**
 * Admin's own wrapper around the SAME underlying `correctClassification`/
 * `undoClassificationCorrection` (`src/taxonomy/correct-classification.js`)
 * `(local)/taxonomy-review/actions.ts` calls — same reasoning as
 * `(admin)/admin/duplicates/actions.ts`'s own header comment: a separate
 * file, `requireAdmin()`-guarded, redirecting back to `/admin/taxonomy`
 * rather than `(local)/taxonomy-review/actions.ts`'s hardcoded `/taxonomy-review`.
 */

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
  await requireAdmin();
  assertWritesEnabled();
  const classificationId = readClassificationId(form);

  let conflict: Error | null = null;
  let newClassificationId: string | null = null;
  try {
    const result = await correctClassification(db, {
      classificationId,
      verdict,
      evidence: {
        reasons: [
          verdict === 'confirmed'
            ? 'confirmed by an admin reviewer on the taxonomy screen'
            : 'rejected by an admin reviewer on the taxonomy screen',
        ],
      },
      at: new Date().toISOString(),
    });
    newClassificationId = result.newClassificationId;
  } catch (error) {
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
  await requireAdmin();
  assertWritesEnabled();
  const classificationId = readClassificationId(form);

  let conflict: Error | null = null;
  try {
    await undoClassificationCorrection(db, { classificationId, at: new Date().toISOString() });
  } catch (error) {
    if (!isKnownCorrectionConflict(error)) throw error;
    conflict = error;
  }

  if (conflict !== null) redirectToConflict(conflict);

  revalidatePath('/admin/taxonomy');
  redirect('/admin/taxonomy');
}
