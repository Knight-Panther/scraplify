'use server';

import { revalidatePath } from 'next/cache.js';
import { redirect } from 'next/navigation.js';
import { db } from '../../../../src/db/client.js';
import {
  correctClassification,
  type ClassificationVerdict,
  undoClassificationCorrection,
} from '../../../../src/taxonomy/correct-classification.js';
import { readClassificationId } from '../../../lib/taxonomy-review-input.js';
import { assertWritesEnabled } from '../../../lib/writes.js';

/**
 * `correctClassification`/`undoClassificationCorrection` throw a plain
 * `Error` with a recognizable prefix for an expected business conflict (a
 * row already corrected by someone else, nothing to undo) — same pattern
 * `phase-3c1-duplicate-review`'s `web/app/(local)/review/actions.ts` established,
 * so an expected conflict lands as a clean message on this screen rather
 * than the generic "Postgres is probably down" error boundary.
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

// `redirect()` throws internally (NEXT_REDIRECT) — must be called OUTSIDE
// any try/catch, never from inside the block that's catching the conflict.
function redirectToConflict(error: Error): never {
  redirect(`/taxonomy-review?conflict=${encodeURIComponent(userFacingConflictMessage(error))}`);
}

async function correct(form: FormData, verdict: ClassificationVerdict): Promise<void> {
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
            ? 'confirmed by a human reviewer on the taxonomy-review screen'
            : 'rejected by a human reviewer on the taxonomy-review screen',
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

  revalidatePath('/taxonomy-review');
  redirect(`/taxonomy-review?corrected=${newClassificationId}`);
}

export async function confirmClassification(form: FormData): Promise<void> {
  await correct(form, 'confirmed');
}

export async function rejectClassification(form: FormData): Promise<void> {
  await correct(form, 'rejected');
}

export async function undoCorrection(form: FormData): Promise<void> {
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

  revalidatePath('/taxonomy-review');
  redirect('/taxonomy-review');
}
