/**
 * Reading a decision out of a form body.
 *
 * Extracted from the server actions so it can be tested. Both rules here are
 * ones this project has been bitten by elsewhere: an id that is not a uuid
 * reaches Postgres as an error rather than an empty result, and cutting
 * Georgian text by index produces half a character.
 */

/** Postgres answers a malformed uuid with an error, not an empty result. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Notes are the reader's own words and are never parsed, but they are stored
 * and re-rendered, so an unbounded one is a free way to fill a column and a
 * page. 500 graphemes is far past any real note.
 */
export const MAX_NOTE = 500;

/**
 * Cut by GRAPHEME, never by index.
 *
 * `georgian-typography.md` rule 7 forbids index-based truncation of this
 * corpus outright: Georgian characters are multi-byte, so `slice` counts UTF-16
 * code units and can cut one in half. In a note that is a mangled word the
 * reader wrote; the same defect in the search box was a P1 during Stage 5.
 */
const SEGMENTER = new Intl.Segmenter('ka', { granularity: 'grapheme' });

export function capNote(note: string, max: number = MAX_NOTE): string {
  // Code units are an upper bound on graphemes, so a short string needs no work.
  if (note.length <= max) return note;
  let out = '';
  let taken = 0;
  for (const { segment } of SEGMENTER.segment(note)) {
    if (taken === max) break;
    out += segment;
    taken += 1;
  }
  return out;
}

export class InvalidDecisionInputError extends Error {
  readonly code = 'INVALID_DECISION_INPUT';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidDecisionInputError';
  }
}

export function readOpportunityId(form: { get(name: string): FormDataEntryValue | null }): string {
  const raw = form.get('opportunityId');
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!UUID.test(id)) {
    throw new InvalidDecisionInputError('A valid opportunity id is required.');
  }
  return id;
}

/**
 * `undefined` when the form carried no note field at all — "leave whatever is
 * stored alone" — as distinct from an empty field, which means "clear it".
 *
 * Collapsing the two would wipe a note every time a decision was changed from
 * a control that has no note input, which is the ordinary case in a list.
 */
export function readNote(form: {
  has(name: string): boolean;
  get(name: string): FormDataEntryValue | null;
}): string | null | undefined {
  if (!form.has('note')) return undefined;
  const raw = form.get('note');
  const note = typeof raw === 'string' ? capNote(raw).trim() : '';
  return note === '' ? null : note;
}
