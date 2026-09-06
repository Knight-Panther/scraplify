import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { CandidateClaimKind, CandidateClaimOrigin } from '../domain/candidate.js';
import { candidateProfileClaims, candidateProfiles, rankings } from '../db/schema/index.js';
import type { Database, DatabaseOrTransaction } from '../db/types.js';
import { normalizeTitle } from '../normalize/text.js';

/**
 * Storage for candidate profiles and their claims (§17.1).
 *
 * Everything in these tables is CV-derived personal data. Two rules follow,
 * and both are requirements rather than preferences:
 *
 * - **Deletable for real.** §6.2 requires deletion of the raw CV, derived
 *   profile, embeddings and cached assessments — not just hiding a row. That
 *   is what `deleteCandidateProfile` does, and why it is a purge across
 *   several tables rather than a flag.
 * - **Never logged.** §21.1 lists CV contents alongside credentials as things
 *   to redact. No function here logs a claim value or an evidence span, and
 *   callers must not either.
 */

export interface ClaimInput {
  kind: string;
  value: string;
  evidence?: string | null;
  origin?: string;
  confidence?: number;
  years?: number | null;
}

export interface CreateProfileInput {
  label: string;
  claims: readonly ClaimInput[];
  now: string;
}

/**
 * Validates and normalizes one claim. Rejecting an unknown kind loudly beats
 * storing it: a typo'd kind would silently never match anything during
 * ranking, and the profile would look complete while scoring as if the claim
 * were absent.
 */
function prepareClaim(input: ClaimInput): {
  kind: CandidateClaimKind;
  value: string;
  valueNormalized: string;
  evidence: string | null;
  origin: CandidateClaimOrigin;
  confidence: number;
  years: number | null;
} {
  const kind = CandidateClaimKind.parse(input.kind);
  const origin = CandidateClaimOrigin.parse(input.origin ?? 'manual');
  const value = input.value.trim();
  if (value.length === 0) throw new Error('claim value must not be empty');
  const valueNormalized = normalizeTitle(value);
  if (valueNormalized === null) {
    throw new Error(`claim value "${input.value}" normalizes to nothing and could never match`);
  }
  const confidence = input.confidence ?? (origin === 'parsed' ? 0.5 : 1);
  if (confidence < 0 || confidence > 1) throw new Error('claim confidence must be within 0-1');
  return {
    kind,
    value,
    valueNormalized,
    evidence: input.evidence ?? null,
    origin,
    confidence,
    years: input.years ?? null,
  };
}

export async function createCandidateProfile(
  db: Database,
  input: CreateProfileInput,
): Promise<{ profileId: string; version: number }> {
  const prepared = input.claims.map(prepareClaim);
  const profileId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(candidateProfiles).values({
      id: profileId,
      label: input.label,
      version: 1,
      deletedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
    if (prepared.length > 0) {
      await tx.insert(candidateProfileClaims).values(
        prepared.map((claim) => ({
          id: randomUUID(),
          profileId,
          profileVersion: 1,
          ...claim,
        })),
      );
    }
  });

  return { profileId, version: 1 };
}

/**
 * Applies a correction by writing a NEW profile version rather than editing
 * the current one (§17.1: "users can correct the profile before ranking").
 *
 * A new version rather than an in-place edit because §17.2 forbids
 * overwriting prior assessments when an input changes: every cached ranking
 * names the profile version it scored against, so mutating claims under a
 * fixed version number would leave those rankings pointing at inputs that no
 * longer exist while still claiming to be current. Bumping the version instead
 * leaves old rankings correct about the old version and simply uncached for
 * the new one.
 */
export async function reviseCandidateProfile(
  db: Database,
  input: { profileId: string; claims: readonly ClaimInput[]; now: string },
): Promise<{ version: number }> {
  const prepared = input.claims.map(prepareClaim);

  return db.transaction(async (tx) => {
    const [profile] = await tx
      .select()
      .from(candidateProfiles)
      .where(and(eq(candidateProfiles.id, input.profileId), isNull(candidateProfiles.deletedAt)));
    if (profile === undefined) {
      throw new Error(`reviseCandidateProfile: no active profile with id ${input.profileId}`);
    }

    const version = profile.version + 1;
    await tx
      .update(candidateProfiles)
      .set({ version, updatedAt: input.now })
      .where(eq(candidateProfiles.id, input.profileId));

    if (prepared.length > 0) {
      await tx.insert(candidateProfileClaims).values(
        prepared.map((claim) => ({
          id: randomUUID(),
          profileId: input.profileId,
          profileVersion: version,
          ...claim,
        })),
      );
    }
    return { version };
  });
}

export interface LoadedProfile {
  profileId: string;
  label: string;
  version: number;
  claims: Array<{
    kind: string;
    value: string;
    valueNormalized: string;
    evidence: string | null;
    origin: string;
    confidence: number;
    years: number | null;
  }>;
}

/** Loads a profile at its current version, or null if absent or deleted. */
export async function loadCandidateProfile(
  db: DatabaseOrTransaction,
  profileId: string,
): Promise<LoadedProfile | null> {
  const [profile] = await db
    .select()
    .from(candidateProfiles)
    .where(and(eq(candidateProfiles.id, profileId), isNull(candidateProfiles.deletedAt)));
  if (profile === undefined) return null;

  const claims = await db
    .select({
      kind: candidateProfileClaims.kind,
      value: candidateProfileClaims.value,
      valueNormalized: candidateProfileClaims.valueNormalized,
      evidence: candidateProfileClaims.evidence,
      origin: candidateProfileClaims.origin,
      confidence: candidateProfileClaims.confidence,
      years: candidateProfileClaims.years,
    })
    .from(candidateProfileClaims)
    .where(
      and(
        eq(candidateProfileClaims.profileId, profileId),
        // Only the CURRENT version's claims. Loading every version's claims
        // would silently score against superseded corrections.
        eq(candidateProfileClaims.profileVersion, profile.version),
      ),
    );

  return { profileId: profile.id, label: profile.label, version: profile.version, claims };
}

export interface DeleteProfileResult {
  rankingsDeleted: number;
  claimsDeleted: number;
  profileDeleted: boolean;
}

/**
 * Permanently removes a profile and everything derived from it (§6.2:
 * "provide deletion of raw CV, derived profile, embeddings, and cached
 * assessments").
 *
 * A real DELETE, not a flag. The `deletedAt` column exists so a profile can be
 * withdrawn from ranking immediately, but it is not deletion and must never be
 * mistaken for it — a soft-deleted profile still has every claim and every
 * cached assessment sitting in the database, which is exactly what a deletion
 * request is asking to be rid of.
 *
 * Order matters: rankings reference the profile, and claims reference it too,
 * so both go before the profile row itself.
 */
export async function deleteCandidateProfile(
  db: Database,
  profileId: string,
): Promise<DeleteProfileResult> {
  return db.transaction(async (tx) => {
    const deletedRankings = await tx
      .delete(rankings)
      .where(eq(rankings.profileId, profileId))
      .returning({ id: rankings.id });
    const deletedClaims = await tx
      .delete(candidateProfileClaims)
      .where(eq(candidateProfileClaims.profileId, profileId))
      .returning({ id: candidateProfileClaims.id });
    const deletedProfile = await tx
      .delete(candidateProfiles)
      .where(eq(candidateProfiles.id, profileId))
      .returning({ id: candidateProfiles.id });

    return {
      rankingsDeleted: deletedRankings.length,
      claimsDeleted: deletedClaims.length,
      profileDeleted: deletedProfile.length > 0,
    };
  });
}

/** Profiles that have not been deleted, for listing in a CLI or UI. */
export async function listCandidateProfiles(
  db: DatabaseOrTransaction,
): Promise<Array<{ profileId: string; label: string; version: number; createdAt: string }>> {
  const rows = await db
    .select({
      profileId: candidateProfiles.id,
      label: candidateProfiles.label,
      version: candidateProfiles.version,
      createdAt: candidateProfiles.createdAt,
    })
    .from(candidateProfiles)
    .where(isNull(candidateProfiles.deletedAt));
  return rows;
}
