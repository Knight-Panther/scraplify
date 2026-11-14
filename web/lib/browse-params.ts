import {
  BROWSE_CHUNK,
  BROWSE_KINDS,
  type BrowseForm,
  type BrowseKind,
  CLOSING_OPTIONS,
  CREDIT_OPTIONS,
  DURATION_OPTIONS,
  emptyForm,
  KIND_TYPES,
  LIST_PARAMS,
  normalize,
  ONLINE_OPTIONS,
  RANGE_PARAMS,
  type Range,
  SINCE_OPTIONS,
  SORTS,
  SUBMISSION_OPTIONS,
} from '../../src/browse/browse-form.js';
import { sourceListingStatusEnum } from '../../src/db/schema/source-listings.js';
import { PROGRAMME_KIND_ORDER } from './kind-labels.js';
import { capGraphemes, MAX_TEXT, many, one, type RawSearchParams } from './search-params.js';

/**
 * Browse's address read into a form (Phase 16C). Everything here is
 * untrusted input: a value outside its list is dropped, never forwarded, and
 * each list is capped, so a hand-made address cannot make the server work
 * hard or show a filter the screen cannot draw.
 *
 * Older addresses keep working: `source=` is a board, `type=` a kind (or, for
 * a set no kind matches, such as the landing page's vacancies and tenders, a
 * filter of its own), and the old `closing`, `since`, `cross`, `status`,
 * `sort` and `show` values are still valid.
 */

/** The most values one list may hold, and the longest one value. */
const MAX_VALUES = 40;
const MAX_VALUE_TEXT = 160;

const STATUSES: readonly string[] = sourceListingStatusEnum.enumValues;
const TYPES: readonly string[] = ['job', 'tender', ...PROGRAMME_KIND_ORDER];

const listOf = (value: string | string[] | undefined, valid: (v: string) => boolean) =>
  many(value)
    .map((v) => capGraphemes(v, MAX_VALUE_TEXT))
    .filter(valid)
    .slice(0, MAX_VALUES);

const oneOf = (value: string | string[] | undefined, options: readonly string[]) => {
  const v = one(value);
  return options.includes(v) ? v : '';
};

function amount(value: string | string[] | undefined): number | null {
  const v = one(value);
  if (!/^\d{1,9}$/.test(v)) return null;
  return Number(v);
}

const ANY = () => true;
const LIST_RULES: Readonly<Record<(typeof LIST_PARAMS)[number], (v: string) => boolean>> = {
  org: ANY,
  place: (v) => /^[gc]:./u.test(v),
  field: (v) => /^[jtc]:./u.test(v),
  ind: ANY,
  emp: ANY,
  method: ANY,
  wf: ANY,
  clang: ANY,
  starts: (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v),
  dur: (v) => (DURATION_OPTIONS as readonly string[]).includes(v),
  sched: ANY,
  ects: (v) => (CREDIT_OPTIONS as readonly string[]).includes(v),
  sen: ANY,
  lang: ANY,
  ben: ANY,
  board: (v) => /^[a-z0-9-]{2,60}$/.test(v),
  status: (v) => STATUSES.includes(v),
};

export function parseBrowseQuery(raw: RawSearchParams, surface: 'local' | 'public'): BrowseForm {
  const form = emptyForm();
  const kind = one(raw.kind);
  form.kind = (BROWSE_KINDS as readonly string[]).includes(kind) ? (kind as BrowseKind) : '';
  form.q = capGraphemes(one(raw.q), MAX_TEXT);
  for (const key of LIST_PARAMS) form[key] = listOf(raw[key], LIST_RULES[key]);

  // An older address named one board as `source`.
  const source = one(raw.source);
  if (source !== '' && LIST_RULES.board(source) && !form.board.includes(source)) {
    form.board.push(source);
  }

  // An older address named exact types; a set one kind lists is that kind.
  const types = listOf(raw.type, (v) => TYPES.includes(v));
  const asKind = BROWSE_KINDS.find(
    (k) => KIND_TYPES[k].length === types.length && KIND_TYPES[k].every((t) => types.includes(t)),
  );
  if (form.kind === '' && asKind !== undefined) form.kind = asKind;
  else if (form.kind === '') form.types = types;

  form.subm = oneOf(raw.subm, SUBMISSION_OPTIONS);
  form.online = oneOf(raw.online, ONLINE_OPTIONS);
  form.closing = oneOf(raw.closing, CLOSING_OPTIONS);
  form.since = oneOf(raw.since, SINCE_OPTIONS);
  form.edu = capGraphemes(one(raw.edu), MAX_VALUE_TEXT);
  for (const [key, min, max] of RANGE_PARAMS) {
    const range: Range = { min: amount(raw[min]), max: amount(raw[max]) };
    // A range written backwards means the same span.
    if (range.min !== null && range.max !== null && range.min > range.max) {
      form[key] = { min: range.max, max: range.min };
    } else form[key] = range;
  }
  form.bonus = one(raw.bonus) === '1';
  form.nolic = one(raw.nolic) === '1';
  form.stud = one(raw.stud) === '1';
  form.cross = one(raw.cross) === '1';
  form.keep = many(raw.keep).slice(0, MAX_VALUES);

  const sort = one(raw.sort);
  form.sort = (SORTS as readonly string[]).includes(sort) ? (sort as BrowseForm['sort']) : 'recent';
  // Rounded up to a whole chunk, so "Show more" never asks for fewer rows than are shown.
  const show = Number.parseInt(one(raw.show), 10);
  form.show =
    Number.isInteger(show) && show > BROWSE_CHUNK
      ? Math.min(Math.ceil(show / BROWSE_CHUNK) * BROWSE_CHUNK, 100_000)
      : BROWSE_CHUNK;

  return normalize(form, surface);
}
