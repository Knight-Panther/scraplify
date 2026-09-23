'use server';

import { revalidatePath } from 'next/cache.js';
import { redirect } from 'next/navigation.js';
import { db } from '../../../../../src/db/client.js';
import { reviseCandidateProfile } from '../../../../../src/ranking/profile-store.js';
import {
  InvalidProfileInputError,
  readCorrectedClaims,
  readProfileId,
} from '../../../../lib/profile-input.js';
import { assertLocalSurface } from '../../../../lib/surface.js';
import { assertWritesEnabled } from '../../../../lib/writes.js';

/**
 * §17.1's "users can correct the profile before ranking" — writes a new
 * profile version via the same `reviseCandidateProfile` the CLI already
 * uses. Every remaining row is reviewed by construction: a human looked at
 * the whole set on this screen and pressed Save (see `profile-input.ts`'s
 * `readCorrectedClaims` for the exact origin rule).
 */

function isKnownSaveConflict(error: unknown): error is Error {
  return (
    error instanceof InvalidProfileInputError ||
    (error instanceof Error && error.message.includes('no active profile with id'))
  );
}

export async function saveCorrections(form: FormData): Promise<void> {
  assertLocalSurface();
  assertWritesEnabled();
  // A malformed profileId means this request did not come from our own
  // rendered form — let it fall through to the generic error boundary,
  // same as `readUuid`/`readClassificationId` do elsewhere in this app.
  const profileId = readProfileId(form);

  let conflictMessage: string | null = null;
  try {
    const claims = readCorrectedClaims(form);
    await reviseCandidateProfile(db, { profileId, claims, now: new Date().toISOString() });
  } catch (error) {
    if (!isKnownSaveConflict(error)) throw error;
    conflictMessage =
      error instanceof InvalidProfileInputError
        ? error.message
        : 'This profile could not be found — it may have been deleted.';
  }

  if (conflictMessage !== null) {
    redirect(`/profile/${profileId}?error=${encodeURIComponent(conflictMessage)}`);
  }

  revalidatePath(`/profile/${profileId}`);
  revalidatePath('/ranked');
  redirect(`/profile/${profileId}?saved=1`);
}
