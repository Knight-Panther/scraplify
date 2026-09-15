/**
 * Reading the review screen's form bodies.
 *
 * Extracted from the server actions so it can be tested, mirroring
 * `decision-input.ts`. Postgres answers a malformed uuid with an error, not
 * an empty result, so every id is checked before it reaches a query.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidReviewInputError extends Error {
  readonly code = 'INVALID_REVIEW_INPUT';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidReviewInputError';
  }
}

function readUuid(form: { get(name: string): FormDataEntryValue | null }, field: string): string {
  const raw = form.get(field);
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!UUID.test(id)) {
    throw new InvalidReviewInputError(`A valid ${field} is required.`);
  }
  return id;
}

export function readCandidateId(form: { get(name: string): FormDataEntryValue | null }): string {
  return readUuid(form, 'candidateId');
}

export function readSurvivorListingId(form: {
  get(name: string): FormDataEntryValue | null;
}): string {
  return readUuid(form, 'survivorListingId');
}

export function readMovingListingId(form: {
  get(name: string): FormDataEntryValue | null;
}): string {
  return readUuid(form, 'movingListingId');
}
