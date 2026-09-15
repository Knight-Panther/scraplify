import { CandidateClaimKind } from '../../src/domain/candidate.js';
import type { ClaimInput } from '../../src/ranking/profile-store.js';

/**
 * Reading `/profile` and `/profile/[id]`'s form bodies — mirrors
 * `decision-input.ts`/`taxonomy-review-input.ts`'s reasoning: a malformed uuid
 * reaches Postgres as an error rather than an empty result, so ids are
 * validated here rather than left to the database to reject.
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidProfileInputError extends Error {
  readonly code = 'INVALID_PROFILE_INPUT';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidProfileInputError';
  }
}

export function readProfileId(form: { get(name: string): FormDataEntryValue | null }): string {
  const raw = form.get('profileId');
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!UUID.test(id)) {
    throw new InvalidProfileInputError('A valid profile id is required.');
  }
  return id;
}

const MAX_LABEL = 120;

export function readLabel(form: { get(name: string): FormDataEntryValue | null }): string {
  const raw = form.get('label');
  const label = typeof raw === 'string' ? raw.trim() : '';
  if (label === '') {
    throw new InvalidProfileInputError('A label for this profile is required.');
  }
  return label.slice(0, MAX_LABEL);
}

/**
 * §23.2 permits sending CV content to a third-party API only "when the user
 * knowingly requests it" — this app has no user-account system to attach a
 * persisted per-user consent record to, so a required per-submission
 * acknowledgment is the honest equivalent here, checked on every upload.
 */
export function readConsent(form: { get(name: string): FormDataEntryValue | null }): boolean {
  return form.get('consent') === 'on';
}

export function readCvFile(form: { get(name: string): FormDataEntryValue | null }): File {
  const value = form.get('file');
  if (!(value instanceof File) || value.size === 0) {
    throw new InvalidProfileInputError('A CV file is required.');
  }
  return value;
}

/**
 * Reads the corrected claim set out of `/profile/[id]`'s single save form.
 *
 * Every remaining (non-deleted) row is written `origin: 'confirmed'` for a
 * row that already existed (identified by carrying a hidden `existing`
 * marker) or `'manual'` for a row added on this screen — a human reviewed
 * the whole set and pressed Save, which is what §17.1's "corrected before
 * ranking" asks for; this does not try to detect which individual fields
 * were actually edited versus left untouched.
 */
export function readCorrectedClaims(form: {
  get(name: string): FormDataEntryValue | null;
}): ClaimInput[] {
  const rowCountRaw = form.get('rowCount');
  const rowCount = typeof rowCountRaw === 'string' ? Number.parseInt(rowCountRaw, 10) : Number.NaN;
  if (!Number.isInteger(rowCount) || rowCount < 0) {
    throw new InvalidProfileInputError('Malformed correction form.');
  }

  const claims: ClaimInput[] = [];

  for (let i = 0; i < rowCount; i++) {
    if (form.get(`claims[${i}].delete`) === 'on') continue;

    const valueRaw = form.get(`claims[${i}].value`);
    const value = typeof valueRaw === 'string' ? valueRaw.trim() : '';
    if (value === '') continue; // A blank "add a claim" slot left unused.

    const kindRaw = form.get(`claims[${i}].kind`);
    const kindParsed = CandidateClaimKind.safeParse(kindRaw);
    if (!kindParsed.success) {
      throw new InvalidProfileInputError(`Row ${i} has an unrecognized claim kind.`);
    }

    const existing = form.get(`claims[${i}].existing`) === '1';
    const evidenceRaw = existing ? form.get(`claims[${i}].evidence`) : null;
    const evidence = typeof evidenceRaw === 'string' && evidenceRaw !== '' ? evidenceRaw : null;

    const yearsRaw = form.get(`claims[${i}].years`);
    const yearsText = typeof yearsRaw === 'string' ? yearsRaw.trim() : '';
    const years = yearsText === '' ? null : Number(yearsText);
    if (years !== null && (!Number.isFinite(years) || years < 0)) {
      throw new InvalidProfileInputError(`Row ${i} has an invalid years value.`);
    }

    claims.push({
      kind: kindParsed.data,
      value,
      evidence,
      origin: existing ? 'confirmed' : 'manual',
      years,
    });
  }

  return claims;
}
