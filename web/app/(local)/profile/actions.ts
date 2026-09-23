'use server';

import { redirect } from 'next/navigation.js';
import { revalidatePath } from 'next/cache.js';
import { extractClaims, CvExtractionFailedError } from '../../../../src/cv-parsing/extract-claims.js';
import {
  CvTooLargeError,
  EmptyCvTextError,
  readDocument,
  UnsupportedCvFormatError,
} from '../../../../src/cv-parsing/read-document.js';
import { db } from '../../../../src/db/client.js';
import {
  createCandidateProfile,
  deleteCandidateProfile,
} from '../../../../src/ranking/profile-store.js';
import { runRanking } from '../../../../src/ranking/run-ranking.js';
import {
  InvalidProfileInputError,
  readConsent,
  readCvFile,
  readLabel,
  readProfileId,
} from '../../../lib/profile-input.js';
import { assertWritesEnabled } from '../../../lib/writes.js';

/**
 * Upload → parse → draft profile (Phase 5's intake path). Ends by calling
 * `createCandidateProfile`, the same function the CLI's `profile:create`
 * already calls — this is a new front door, not a fork of it.
 *
 * §21.1/§23.2: nothing here logs the file, its name, or extracted content.
 * A known, expected failure (bad format, extraction failure, missing
 * consent) redirects back to `/profile` with a plain message rather than
 * falling through to the generic error boundary — the same pattern
 * `taxonomy-review/actions.ts` and `opportunities/[id]/actions.ts` use for
 * their own expected conflicts.
 */

function userFacingUploadMessage(error: Error): string {
  if (error instanceof InvalidProfileInputError) return error.message;
  if (error instanceof CvTooLargeError) return 'That file is too large — the limit is 8MB.';
  if (error instanceof UnsupportedCvFormatError) return error.message;
  if (error instanceof EmptyCvTextError) return error.message;
  if (error instanceof CvExtractionFailedError) {
    return `${error.message} You can also build a profile manually with the CLI (npm run rank -- profile:create).`;
  }
  return 'Could not create a profile from this upload. Try again.';
}

function isKnownUploadFailure(
  error: unknown,
): error is
  | InvalidProfileInputError
  | CvTooLargeError
  | UnsupportedCvFormatError
  | EmptyCvTextError
  | CvExtractionFailedError {
  return (
    error instanceof InvalidProfileInputError ||
    error instanceof CvTooLargeError ||
    error instanceof UnsupportedCvFormatError ||
    error instanceof EmptyCvTextError ||
    error instanceof CvExtractionFailedError
  );
}

export async function uploadCv(form: FormData): Promise<void> {
  assertWritesEnabled();

  let redirectTo: string | null = null;
  let createdProfileId: string | null = null;

  try {
    const label = readLabel(form);
    if (!readConsent(form)) {
      throw new InvalidProfileInputError(
        'You must acknowledge that the file will be sent to Anthropic’s API to continue.',
      );
    }
    const file = readCvFile(form);
    const buffer = Buffer.from(await file.arrayBuffer());

    const document = await readDocument({ filename: file.name, buffer });
    const claims = await extractClaims(document);

    const created = await createCandidateProfile(db, {
      label,
      claims,
      now: new Date().toISOString(),
    });
    createdProfileId = created.profileId;
  } catch (error) {
    if (!isKnownUploadFailure(error)) throw error;
    redirectTo = `/profile?error=${encodeURIComponent(userFacingUploadMessage(error))}`;
  }

  if (redirectTo !== null) redirect(redirectTo);
  if (createdProfileId === null) return;

  revalidatePath('/ranked');
  redirect(`/profile/${createdProfileId}`);
}

/**
 * A real, cascading `DELETE` (`deleteCandidateProfile` already removes
 * rankings, claims and the profile row itself) — never soft, so the UI's own
 * confirmation (a popover, not a plain click) is load-bearing, not decorative.
 */
export async function deleteProfile(form: FormData): Promise<void> {
  assertWritesEnabled();
  const profileId = readProfileId(form);

  await deleteCandidateProfile(db, profileId);

  revalidatePath('/profile');
  revalidatePath('/ranked');
  redirect('/profile');
}

/**
 * The same scoring the CLI's `rank` command runs — this closes the gap where
 * a profile could be uploaded and corrected with no way to actually see
 * ranked results short of a terminal.
 */
export async function rankProfile(form: FormData): Promise<void> {
  assertWritesEnabled();
  const profileId = readProfileId(form);

  let conflictMessage: string | null = null;
  try {
    await runRanking(db, { profileId, force: false });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('no active candidate profile')) {
      throw error;
    }
    conflictMessage = 'This profile could not be found — it may have been deleted.';
  }

  if (conflictMessage !== null) {
    redirect(`/profile?error=${encodeURIComponent(conflictMessage)}`);
  }

  revalidatePath('/ranked');
  redirect(`/ranked?profile=${profileId}`);
}
