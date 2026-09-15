/**
 * Reading a classification id out of a form body — mirrors
 * `decision-input.ts`'s reasoning exactly: a malformed uuid reaches Postgres
 * as an error, not an empty result, so it is validated here rather than
 * left to the database to reject.
 */

/** Exported for the page's own `?corrected=` searchParam check, not just form bodies. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTaxonomyReviewInputError extends Error {
  readonly code = 'INVALID_TAXONOMY_REVIEW_INPUT';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidTaxonomyReviewInputError';
  }
}

export function readClassificationId(form: {
  get(name: string): FormDataEntryValue | null;
}): string {
  const raw = form.get('classificationId');
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!UUID.test(id)) {
    throw new InvalidTaxonomyReviewInputError('A valid classification id is required.');
  }
  return id;
}
