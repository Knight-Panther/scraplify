import type { RangeCounts } from '../../src/browse/browse-engine.js';
import type { BrowseForm, FilterKey, KindChoice, Range } from '../../src/browse/browse-form.js';

/**
 * How Browse v2 draws each filter (Phase 16C, the approved mockup): its
 * name, icon and group, the pills each kind promotes, and the words around
 * a filter. No server import: the bar in the browser reads it.
 */

export type BrowseIcon =
  | 'any'
  | 'job'
  | 'tender'
  | 'course'
  | 'search'
  | 'pin'
  | 'field'
  | 'money'
  | 'clock'
  | 'sparkle'
  | 'globe'
  | 'list'
  | 'calendar'
  | 'ticket'
  | 'award'
  | 'person'
  | 'house'
  | 'sliders'
  | 'hash'
  | 'wifi'
  | 'state';

/** A filter option, labelled on the server: the board's word, its English, and what picking it would show. */
export interface BrowseOption {
  value: string;
  label: string;
  /** The English beside a Georgian word; empty when the label is already English. */
  hint: string;
  n: number;
  /** A heading the option sits under (cities, then countries). */
  group?: string;
  lang?: 'ka' | 'en';
}

/** "Also show the N that don't state it", per filter. */
export interface LeftOutText {
  n: number;
  /** "275 from jobs.ge, which never states it", largest first. */
  parts: string[];
  kept: boolean;
}

/** Everything the server worked out for the form it answered. */
export interface BrowseData {
  surface: 'local' | 'public';
  total: number;
  /** More rows that would match if listings not stating a fact were kept. */
  extra: number;
  /** Rows shown only because a kept filter's fact is not stated. */
  unstated: number;
  kindCounts: Record<string, number>;
  options: Partial<Record<FilterKey, BrowseOption[]>>;
  ranges: Partial<Record<FilterKey, RangeCounts>>;
  toggles: Partial<Record<FilterKey, number>>;
  leftOut: Partial<Record<FilterKey, LeftOutText>>;
  /** The kind of each picked organisation, for its token's word (employer, buyer, school). */
  orgKinds: Record<string, string>;
  /** The reference rates' date, for the money notes. */
  ratesDate: string;
}

export type Group = 'What' | 'Where' | 'When' | 'Money' | 'Requirements' | 'Listing';
export const GROUPS: readonly Group[] = [
  'What',
  'Where',
  'When',
  'Money',
  'Requirements',
  'Listing',
];

export const GROUP_ICON: Readonly<Record<Group | 'Type' | 'Display', BrowseIcon>> = {
  Type: 'any',
  What: 'field',
  Where: 'pin',
  When: 'calendar',
  Money: 'money',
  Requirements: 'person',
  Listing: 'globe',
  Display: 'sliders',
};

interface FilterUi {
  group: Group;
  title: (kind: KindChoice) => string;
  /** The pill's shorter name, where it has one. */
  short?: string;
  icon: BrowseIcon;
  /** "don't state ___". */
  what?: (kind: KindChoice) => string;
  /** An on/off filter's line. */
  toggle?: string;
  hint?: string;
  /** Which boards state it, beside the title in "All filters". */
  source?: (kind: KindChoice) => string;
  /** A list a pill opens wide (long lists, ranges). */
  wide?: boolean;
  /** Shown folded in "All filters" past this many options. */
  fold?: number;
}

const HR = () => 'hr.ge only';

export const FILTER_UI: Readonly<Partial<Record<FilterKey, FilterUi>>> = {
  field: {
    group: 'What',
    title: (k) =>
      ({ job: 'Field', tender: 'Category', course: 'Field of study' })[k as 'job'] ?? 'Field',
    icon: 'field',
    what: (k) =>
      ({ job: 'a field', tender: 'a category', course: 'a field of study' })[k as 'job'] ??
      'a field',
    source: (k) =>
      k === 'job' ? 'hr.ge; guessed for jobs.ge' : k === 'tender' ? 'CPV division' : '',
    wide: true,
    fold: 14,
  },
  ind: {
    group: 'What',
    title: () => 'Industry',
    icon: 'field',
    what: () => 'an industry',
    source: HR,
    fold: 10,
  },
  emp: {
    group: 'What',
    title: () => 'Contract',
    icon: 'list',
    what: () => 'a contract type',
    source: HR,
    fold: 6,
  },
  method: { group: 'What', title: () => 'Procedure', icon: 'list', what: () => 'a procedure' },
  subm: { group: 'What', title: () => 'Where bids go', icon: 'globe', what: () => 'where bids go' },
  clang: { group: 'What', title: () => 'Taught in', icon: 'globe', what: () => 'a language' },
  place: {
    group: 'Where',
    title: (k) => (k === 'job' ? 'City' : k === 'course' ? 'Country' : 'Place'),
    icon: 'pin',
    what: (k) => (k === 'job' ? 'a city' : k === 'course' ? 'a country' : 'a place'),
    source: (k) => (k === 'job' ? 'hr.ge only' : k === '' ? 'hr.ge jobs and courses' : ''),
    wide: true,
    fold: 14,
  },
  wf: {
    group: 'Where',
    title: () => 'Where you work',
    icon: 'house',
    what: () => 'where the work is',
    source: HR,
  },
  online: { group: 'Where', title: () => 'Format', icon: 'wifi' },
  closing: {
    group: 'When',
    title: () => 'Deadline',
    short: 'Closing',
    icon: 'clock',
    what: () => 'a deadline',
  },
  since: { group: 'When', title: () => 'First seen', short: 'New', icon: 'sparkle' },
  starts: { group: 'When', title: () => 'Starts', icon: 'calendar', what: () => 'a start date' },
  dur: { group: 'When', title: () => 'Length', icon: 'calendar', what: () => 'its length' },
  sched: {
    group: 'When',
    title: () => 'Hours',
    icon: 'clock',
    what: () => 'its hours',
    source: HR,
  },
  salary: {
    group: 'Money',
    title: () => 'Salary',
    icon: 'money',
    what: () => 'a salary',
    source: HR,
    wide: true,
  },
  bonus: {
    group: 'Money',
    title: () => 'Bonus',
    icon: 'money',
    what: () => 'whether there is a bonus',
    toggle: 'Only vacancies with a bonus',
    source: HR,
  },
  value: {
    group: 'Money',
    title: () => 'Estimated value',
    short: 'Value',
    icon: 'money',
    what: () => 'a value',
    wide: true,
  },
  fee: { group: 'Money', title: () => 'Fee', icon: 'ticket', what: () => 'a fee', wide: true },
  ects: { group: 'Money', title: () => 'Credits', icon: 'award', what: () => 'credits' },
  sen: {
    group: 'Requirements',
    title: () => 'Seniority',
    icon: 'person',
    what: () => 'a level',
    source: HR,
  },
  edu: {
    group: 'Requirements',
    title: () => 'Your education',
    icon: 'person',
    what: () => 'an education level',
    hint: 'Vacancies that accept this level.',
    source: HR,
  },
  lang: {
    group: 'Requirements',
    title: () => 'Languages you speak',
    icon: 'globe',
    what: () => 'its languages',
    hint: 'Vacancies that ask for no language beyond the ones ticked.',
    source: HR,
  },
  nolic: {
    group: 'Requirements',
    title: () => 'Driving licence',
    icon: 'person',
    what: () => 'a licence',
    toggle: 'Hide vacancies that need a driving licence',
    source: HR,
  },
  stud: {
    group: 'Requirements',
    title: () => 'Students',
    icon: 'course',
    what: () => 'whether it suits students',
    toggle: 'Only vacancies marked as suiting students',
    source: HR,
  },
  ben: {
    group: 'Requirements',
    title: () => 'Benefits',
    icon: 'sparkle',
    what: () => 'its benefits',
    hint: 'A vacancy must offer every one ticked.',
    source: HR,
    fold: 6,
  },
  board: { group: 'Listing', title: () => 'Board', icon: 'globe' },
  types: { group: 'Listing', title: () => 'Kinds', icon: 'any' },
  cross: {
    group: 'Listing',
    title: () => 'Cross-posted',
    icon: 'globe',
    toggle: 'Only those on more than one board',
  },
  status: { group: 'Listing', title: () => 'State', icon: 'state' },
};

export function titleOf(key: FilterKey, kind: KindChoice): string {
  return FILTER_UI[key]?.title(kind) ?? key;
}

/** The pills under the search, by kind: what people narrow by first for that kind. */
export const PROMOTED: Readonly<Record<KindChoice, readonly FilterKey[]>> = {
  '': ['place', 'closing', 'since', 'board'],
  job: ['field', 'place', 'salary', 'since', 'closing'],
  tender: ['field', 'closing', 'method', 'since'],
  course: ['starts', 'place', 'field', 'fee', 'ects'],
};

export const KIND_TABS: readonly (readonly [KindChoice, string, BrowseIcon])[] = [
  ['', 'All', 'any'],
  ['job', 'Jobs', 'job'],
  ['tender', 'Tenders', 'tender'],
  ['course', 'Courses', 'course'],
];

const KIND_WORDS: Readonly<Record<KindChoice, [string, string]>> = {
  '': ['opportunity', 'opportunities'],
  job: ['vacancy', 'vacancies'],
  tender: ['tender', 'tenders'],
  course: ['course', 'courses'],
};
export const kindWord = (kind: KindChoice, n: number) => KIND_WORDS[kind][n === 1 ? 0 : 1];

const nf = new Intl.NumberFormat('en-US');
export const fmt = (n: number) => nf.format(Math.round(n));

export function moneyShort(value: number, sign: string): string {
  if (value >= 1e6) return `${sign}${(value / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1e4) return `${sign}${Math.round(value / 1e3)}k`;
  return `${sign}${fmt(value)}`;
}

export function rangeText(r: Range, sign: string): string {
  if (r.min === null && r.max === null) return '';
  if (r.min === null) return `up to ${moneyShort(r.max ?? 0, sign)}`;
  if (r.max === null) return `${moneyShort(r.min, sign)}+`;
  return `${moneyShort(r.min, sign)}–${moneyShort(r.max, sign)}`;
}

export const RANGE_SIGN: Readonly<Partial<Record<FilterKey, string>>> = {
  salary: '₾',
  value: '₾',
  fee: '€',
};

/** The words under a range panel. */
export function unitNote(key: FilterKey, ratesDate: string): string {
  if (key === 'salary')
    return 'A month, in lari, as hr.ge states it; “from 1,500” counts as 1,500 and up.';
  if (key === 'value') {
    return `The buyer’s estimate, in lari; an estimate in another currency is converted at the National Bank’s rate of ${ratesDate}, for grouping only.`;
  }
  return `Tuition in euros. A fee in another currency is converted at the National Bank’s rates of ${ratesDate}, for grouping only; each row shows the school’s own amount.`;
}

/** A filter's value in a few words, for its pill and its chip. */
export function summaryOf(
  key: FilterKey,
  form: BrowseForm,
  label: (key: FilterKey, value: string) => string,
): string {
  const list = (values: readonly string[]) => values.map((v) => label(key, v)).join(', ');
  switch (key) {
    case 'salary':
      return `${rangeText(form.salary, '₾')} a month`;
    case 'value':
      return rangeText(form.value, '₾');
    case 'fee':
      return rangeText(form.fee, '€');
    case 'bonus':
      return 'with a bonus';
    case 'nolic':
      return 'not needed';
    case 'stud':
      return 'suits students';
    case 'cross':
      return 'on more than one board';
    case 'ects':
      return `${list(form.ects)} ECTS`;
    case 'closing':
    case 'since':
    case 'subm':
    case 'online':
    case 'edu':
      return label(key, form[key]).toLowerCase();
    case 'q':
      return `“${form.q}”`;
    default: {
      const value = form[key as keyof BrowseForm];
      return Array.isArray(value) ? list(value as string[]) : '';
    }
  }
}
