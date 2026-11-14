/**
 * Browse's filters as one value (Phase 16C, the approved Browse v2 mockup),
 * with no database or server import, so the filter bar in the browser and the
 * server agree on what applies where and on how one change reshapes the rest.
 *
 * The address is the state: `web/lib/browse-params.ts` reads a visitor's
 * address into this form and writes a form back into an address, and the
 * engine (`browse-engine.ts`) answers a form with rows and counts.
 */

export const BROWSE_KINDS = ['job', 'tender', 'course'] as const;
export type BrowseKind = (typeof BROWSE_KINDS)[number];
/** `''` is every kind. */
export type KindChoice = '' | BrowseKind;

/**
 * The opportunity types each kind lists. "Courses" is the summer-school
 * source's kind ("course / school", Phase 15B); the other programme kinds
 * (scholarships, grants and the rest) show under "All" until they have a
 * screen of their own (Phase 15E).
 */
export const KIND_TYPES: Readonly<Record<BrowseKind, readonly string[]>> = {
  job: ['job'],
  tender: ['tender'],
  course: ['summer_school'],
};

export function kindOfType(type: string): BrowseKind | null {
  for (const kind of BROWSE_KINDS) if (KIND_TYPES[kind].includes(type)) return kind;
  return null;
}

export interface Range {
  min: number | null;
  max: number | null;
}

export const SORTS = ['recent', 'deadline', 'title', 'salary', 'starts', 'fee'] as const;
export type BrowseSort = (typeof SORTS)[number];

/** Sorts that only mean something for one kind. */
const SORT_KIND: Readonly<Partial<Record<BrowseSort, BrowseKind>>> = {
  salary: 'job',
  starts: 'course',
  fee: 'course',
};

export function sortsFor(kind: KindChoice): BrowseSort[] {
  return SORTS.filter((sort) => {
    const only = SORT_KIND[sort];
    return only === undefined || only === kind;
  });
}

/** Days ahead, for "Closing". */
export const CLOSING_OPTIONS = ['3', '7', '14', '30'] as const;
/** Days back, for "New". */
export const SINCE_OPTIONS = ['1', '3', '7', '30'] as const;
export const ONLINE_OPTIONS = ['online', 'onsite'] as const;
export const SUBMISSION_OPTIONS = ['platform', 'off_platform'] as const;
/** Course length bands, in days. */
export const DURATION_OPTIONS = ['w1', 'w2', 'w4', 'w5'] as const;
/** Credit bands, in ECTS. */
export const CREDIT_OPTIONS = ['0', 'lo', 'mid', 'hi'] as const;

export interface BrowseForm {
  kind: KindChoice;
  /** Words, every one of which must match (`search-terms.ts`). */
  q: string;
  /** Employers, buyers or schools picked in the search box; any of them. */
  org: string[];
  /** `g:<city>` (a city in Georgia, from hr.ge) or `c:<country>` (a course's country). */
  place: string[];
  /** `j:<hr.ge field>`, `t:<CPV division>` or `c:<field of study>`. */
  field: string[];
  ind: string[];
  emp: string[];
  method: string[];
  subm: string;
  /** Where you work (hr.ge's on site, hybrid, from home, in the field). */
  wf: string[];
  online: string;
  clang: string[];
  closing: string;
  since: string;
  /** Months, `YYYY-MM`. */
  starts: string[];
  dur: string[];
  sched: string[];
  salary: Range;
  bonus: boolean;
  value: Range;
  fee: Range;
  ects: string[];
  sen: string[];
  edu: string;
  lang: string[];
  nolic: boolean;
  stud: boolean;
  ben: string[];
  board: string[];
  cross: boolean;
  /** Listing states; the local edition only (every public row is open). */
  status: string[];
  /** Exact opportunity types, from an older address (`type=job&type=tender`). */
  types: string[];
  /** Filters whose listings that do not state the fact are kept, after the matches. */
  keep: string[];
  sort: BrowseSort;
  show: number;
}

/** How many rows a page shows at first, and how many "Show more" adds. */
export const BROWSE_CHUNK = 40;

const range = (): Range => ({ min: null, max: null });

export function emptyForm(): BrowseForm {
  return {
    kind: '',
    q: '',
    org: [],
    place: [],
    field: [],
    ind: [],
    emp: [],
    method: [],
    subm: '',
    wf: [],
    online: '',
    clang: [],
    closing: '',
    since: '',
    starts: [],
    dur: [],
    sched: [],
    salary: range(),
    bonus: false,
    value: range(),
    fee: range(),
    ects: [],
    sen: [],
    edu: '',
    lang: [],
    nolic: false,
    stud: false,
    ben: [],
    board: [],
    cross: false,
    status: [],
    types: [],
    keep: [],
    sort: 'recent',
    show: BROWSE_CHUNK,
  };
}

/** Every filter, by the key the engine, the bar and the chips share. */
export const FILTER_KEYS = [
  'q',
  'org',
  'types',
  'field',
  'ind',
  'emp',
  'method',
  'subm',
  'clang',
  'place',
  'wf',
  'online',
  'closing',
  'since',
  'starts',
  'dur',
  'sched',
  'salary',
  'bonus',
  'value',
  'fee',
  'ects',
  'sen',
  'edu',
  'lang',
  'nolic',
  'stud',
  'ben',
  'board',
  'cross',
  'status',
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

/** The kinds a filter applies to; absent means every kind, "All" included. */
const KINDS_OF: Readonly<Partial<Record<FilterKey, readonly KindChoice[]>>> = {
  field: ['job', 'tender', 'course'],
  ind: ['job'],
  emp: ['job'],
  method: ['tender'],
  subm: ['tender'],
  clang: ['course'],
  place: ['', 'job', 'course'],
  wf: ['job'],
  online: ['course'],
  starts: ['course'],
  dur: ['course'],
  sched: ['job'],
  salary: ['job'],
  bonus: ['job'],
  value: ['tender'],
  fee: ['course'],
  ects: ['course'],
  sen: ['job'],
  edu: ['job'],
  lang: ['job'],
  nolic: ['job'],
  stud: ['job'],
  ben: ['job'],
};

/**
 * Filters on a fact only some listings state. Such a filter never hides the
 * others silently: it says how many it leaves out, and `keep` brings them back.
 */
export const STATED_KEYS: ReadonlySet<FilterKey> = new Set<FilterKey>([
  'field',
  'ind',
  'emp',
  'method',
  'subm',
  'clang',
  'place',
  'wf',
  'closing',
  'starts',
  'dur',
  'sched',
  'salary',
  'bonus',
  'value',
  'fee',
  'ects',
  'sen',
  'edu',
  'lang',
  'nolic',
  'stud',
  'ben',
]);

export function applies(key: FilterKey, kind: KindChoice, surface: 'local' | 'public'): boolean {
  if (key === 'status') return surface === 'local';
  const kinds = KINDS_OF[key];
  return kinds === undefined || kinds.includes(kind);
}

const on = (r: Range) => r.min !== null || r.max !== null;

export function isActive(key: FilterKey, form: BrowseForm): boolean {
  switch (key) {
    case 'q':
      return form.q !== '';
    case 'subm':
    case 'online':
    case 'closing':
    case 'since':
    case 'edu':
      return form[key] !== '';
    case 'salary':
    case 'value':
    case 'fee':
      return on(form[key]);
    case 'bonus':
    case 'nolic':
    case 'stud':
    case 'cross':
      return form[key];
    default:
      return form[key].length > 0;
  }
}

/** The form with one filter cleared, and its "keep" with it. */
export function clearFilter(form: BrowseForm, key: FilterKey): BrowseForm {
  const blank = emptyForm();
  return {
    ...form,
    [key]: blank[key],
    keep: form.keep.filter((k) => k !== key),
  };
}

/** Every filter that is set and applies, in the registry's order. */
export function activeKeys(form: BrowseForm, surface: 'local' | 'public'): FilterKey[] {
  return FILTER_KEYS.filter((key) => applies(key, form.kind, surface) && isActive(key, form));
}

/**
 * The form under another kind: what no longer applies is dropped, so nothing
 * hidden keeps narrowing; a place keeps only what the kind can have (a city
 * for jobs, a country for courses); a field always goes, since fields differ
 * by kind; an older address's exact types give way to the kind.
 */
export function asKind(
  form: BrowseForm,
  kind: KindChoice,
  surface: 'local' | 'public',
): BrowseForm {
  if (form.kind === kind) return form;
  const next: BrowseForm = { ...form, kind, field: [], types: [] };
  next.place = form.place.filter((p) =>
    kind === 'job' ? p.startsWith('g:') : kind === 'course' ? p.startsWith('c:') : true,
  );
  let out = next;
  for (const key of FILTER_KEYS) {
    if (!applies(key, kind, surface) && isActive(key, out)) out = clearFilter(out, key);
  }
  out = { ...out, keep: out.keep.filter((k) => applies(k as FilterKey, kind, surface)) };
  if (!sortsFor(kind).includes(out.sort)) out = { ...out, sort: 'recent' };
  return out;
}

/** Every filter cleared; the kind and the order stay, as "Clear all" leaves them. */
export function clearAll(form: BrowseForm): BrowseForm {
  return { ...emptyForm(), kind: form.kind, sort: form.sort };
}

/**
 * The form with what its kind does not offer dropped, so an address can hold
 * only filters that mean something together (a salary with "Tenders" goes).
 */
export function normalize(form: BrowseForm, surface: 'local' | 'public'): BrowseForm {
  let out: BrowseForm = {
    ...form,
    place: form.place.filter((p) =>
      form.kind === 'job' ? p.startsWith('g:') : form.kind === 'course' ? p.startsWith('c:') : true,
    ),
    field: form.field.filter((f) =>
      form.kind === 'job'
        ? f.startsWith('j:')
        : form.kind === 'tender'
          ? f.startsWith('t:')
          : form.kind === 'course'
            ? f.startsWith('c:')
            : false,
    ),
  };
  for (const key of FILTER_KEYS) {
    if (!applies(key, out.kind, surface) && isActive(key, out)) out = clearFilter(out, key);
  }
  const keep = [
    ...new Set(
      out.keep.filter(
        (k) =>
          STATED_KEYS.has(k as FilterKey) &&
          applies(k as FilterKey, out.kind, surface) &&
          isActive(k as FilterKey, out),
      ),
    ),
  ].sort();
  return { ...out, keep, sort: sortsFor(out.kind).includes(out.sort) ? out.sort : 'recent' };
}

const RANGE_PARAMS = [
  ['salary', 'smin', 'smax'],
  ['value', 'vmin', 'vmax'],
  ['fee', 'fmin', 'fmax'],
] as const;
export { RANGE_PARAMS };

const LIST_PARAMS = [
  'org',
  'place',
  'field',
  'ind',
  'emp',
  'method',
  'wf',
  'clang',
  'starts',
  'dur',
  'sched',
  'ects',
  'sen',
  'lang',
  'ben',
  'board',
  'status',
] as const satisfies readonly (keyof BrowseForm)[];
export { LIST_PARAMS };

/** The address's query for a form, with no leading `?`. One choice has one address: lists are sorted. */
export function formSearch(form: BrowseForm): string {
  const params = new URLSearchParams();
  if (form.kind !== '') params.set('kind', form.kind);
  if (form.q !== '') params.set('q', form.q);
  for (const key of LIST_PARAMS) {
    for (const value of [...form[key]].sort()) params.append(key, value);
  }
  for (const type of [...form.types].sort()) params.append('type', type);
  if (form.subm !== '') params.set('subm', form.subm);
  if (form.online !== '') params.set('online', form.online);
  if (form.closing !== '') params.set('closing', form.closing);
  if (form.since !== '') params.set('since', form.since);
  if (form.edu !== '') params.set('edu', form.edu);
  for (const [key, min, max] of RANGE_PARAMS) {
    if (form[key].min !== null) params.set(min, String(form[key].min));
    if (form[key].max !== null) params.set(max, String(form[key].max));
  }
  if (form.bonus) params.set('bonus', '1');
  if (form.nolic) params.set('nolic', '1');
  if (form.stud) params.set('stud', '1');
  if (form.cross) params.set('cross', '1');
  for (const key of [...form.keep].sort()) params.append('keep', key);
  if (form.sort !== 'recent') params.set('sort', form.sort);
  if (form.show > BROWSE_CHUNK) params.set('show', String(form.show));
  return params.toString();
}

export function formHref(form: BrowseForm): string {
  const search = formSearch(form);
  return search === '' ? '/opportunities' : `/opportunities?${search}`;
}
