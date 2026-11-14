import type { BrowseItem } from './browse-index.js';
import {
  activeKeys,
  applies,
  asKind,
  type BrowseForm,
  type BrowseKind,
  type FilterKey,
  isActive,
  type KindChoice,
  type Range,
  STATED_KEYS,
} from './browse-form.js';
import { searchTerms } from './search-terms.js';

/**
 * Browse v2's answers, worked out from the in-memory index
 * (`browse-index.ts`): which rows a form shows and in what order, how many
 * each option of each filter would show, how many a filter leaves out for
 * not stating what it asks (and from which board), and what dropping one
 * filter would show when nothing matches.
 *
 * Pure: no database, no clock of its own (`nowMs` comes in), so every rule is
 * tested directly (`browse-engine.test.ts`).
 */

export interface EngineContext {
  nowMs: number;
  surface: 'local' | 'public';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A rule of the form: whether a row states the fact, and whether it fits. */
interface Check {
  key: FilterKey;
  known: ((item: BrowseItem) => boolean) | null;
  test: (item: BrowseItem) => boolean;
}

/** Salary's low and high ends, for an overlap: "from 1,500" is 1,500 and up. */
const salaryLow = (s: [number | null, number | null]) => s[0] ?? s[1] ?? 0;
const salaryHigh = (s: [number | null, number | null]) => s[1] ?? s[0] ?? 0;

export function inRange(value: number | null, range: Range): boolean {
  return (
    value !== null &&
    (range.min === null || value >= range.min) &&
    (range.max === null || value <= range.max)
  );
}

/** Course length bands. */
export const DURATION_TEST: Readonly<Record<string, (days: number) => boolean>> = {
  w1: (d) => d <= 7,
  w2: (d) => d > 7 && d <= 14,
  w4: (d) => d > 14 && d <= 31,
  w5: (d) => d > 31,
};

/** Credit bands. */
export const CREDIT_TEST: Readonly<Record<string, (ects: number) => boolean>> = {
  '0': (e) => e === 0,
  lo: (e) => e > 0 && e <= 5,
  mid: (e) => e > 5 && e <= 8,
  hi: (e) => e >= 10,
};

/** A member a public visitor may be shown as open right now (`publicEligibleMemberSql`). */
function eligibleMember(member: BrowseItem['members'][number], nowMs: number): boolean {
  return member.status === 'active' && (member.deadlineMs === null || member.deadlineMs >= nowMs);
}

export function isEligible(item: BrowseItem, ctx: EngineContext): boolean {
  return ctx.surface === 'local' || item.members.some((m) => eligibleMember(m, ctx.nowMs));
}

function closingTest(days: number, ctx: EngineContext) {
  const to = ctx.nowMs + days * DAY_MS;
  // One member must both close in the window and, in public, be open: two
  // members cannot each meet half (`publicOpportunityConditions` says why).
  return (item: BrowseItem) =>
    item.members.some(
      (m) =>
        m.deadlineMs !== null &&
        m.deadlineMs >= ctx.nowMs &&
        m.deadlineMs <= to &&
        (ctx.surface === 'local' || eligibleMember(m, ctx.nowMs)),
    );
}

/** Compiled search words: every one must match some member's text. */
export function textTest(q: string): ((item: BrowseItem) => boolean) | null {
  const terms = searchTerms(q).map((term) => new RegExp(term.pattern, 'iu'));
  if (terms.length === 0) return null;
  return (item) => terms.every((term) => term.test(item.hay));
}

/** The rule for one filter as the form sets it. Exported for the option counts and tests. */
export function checkFor(key: FilterKey, form: BrowseForm, ctx: EngineContext): Check {
  const has = (list: readonly string[]) => (values: readonly string[]) =>
    values.some((v) => list.includes(v));
  switch (key) {
    case 'q': {
      const test = textTest(form.q);
      return { key, known: null, test: test ?? (() => true) };
    }
    case 'org':
      return { key, known: null, test: (i) => has(form.org)(i.orgs) };
    case 'types':
      return { key, known: null, test: (i) => form.types.includes(i.type) };
    case 'field':
      return { key, known: (i) => i.fields.length > 0, test: (i) => has(form.field)(i.fields) };
    case 'ind':
      return {
        key,
        known: (i) => i.industries.length > 0,
        test: (i) => has(form.ind)(i.industries),
      };
    case 'emp':
      return {
        key,
        known: (i) => i.contract !== null,
        test: (i) => i.contract !== null && form.emp.includes(i.contract),
      };
    case 'method':
      return {
        key,
        known: (i) => i.method !== null,
        test: (i) => i.method !== null && form.method.includes(i.method),
      };
    case 'subm':
      return { key, known: (i) => i.submission !== null, test: (i) => i.submission === form.subm };
    case 'clang':
      return { key, known: (i) => i.teaching.length > 0, test: (i) => has(form.clang)(i.teaching) };
    case 'place':
      return { key, known: (i) => i.places.length > 0, test: (i) => has(form.place)(i.places) };
    case 'wf':
      return {
        key,
        known: (i) => i.workplace !== null,
        test: (i) => i.workplace !== null && form.wf.includes(i.workplace),
      };
    case 'online':
      return {
        key,
        known: null,
        test: (i) => (form.online === 'online' ? i.online : !i.online),
      };
    case 'closing':
      return {
        key,
        known: (i) => i.deadlineMs !== null,
        test: closingTest(Number(form.closing), ctx),
      };
    case 'since': {
      const from = ctx.nowMs - Number(form.since) * DAY_MS;
      return { key, known: null, test: (i) => i.firstSeenMs >= from };
    }
    case 'starts':
      return {
        key,
        known: (i) => i.start !== null,
        test: (i) => i.start !== null && form.starts.includes(i.start.slice(0, 7)),
      };
    case 'dur':
      return {
        key,
        known: (i) => i.days !== null,
        test: (i) => i.days !== null && form.dur.some((d) => DURATION_TEST[d]?.(i.days ?? 0)),
      };
    case 'sched':
      return {
        key,
        known: (i) => i.hours !== null,
        test: (i) => i.hours !== null && form.sched.includes(i.hours),
      };
    case 'salary':
      return {
        key,
        known: (i) => i.salary !== null,
        test: (i) =>
          i.salary !== null &&
          (form.salary.min === null || salaryHigh(i.salary) >= form.salary.min) &&
          (form.salary.max === null || salaryLow(i.salary) <= form.salary.max),
      };
    case 'bonus':
      return { key, known: (i) => i.bonus !== null, test: (i) => i.bonus === true };
    case 'value':
      return {
        key,
        known: (i) => i.valueGel !== null,
        test: (i) => inRange(i.valueGel, form.value),
      };
    case 'fee':
      return { key, known: (i) => i.feeEur !== null, test: (i) => inRange(i.feeEur, form.fee) };
    case 'ects':
      return {
        key,
        known: (i) => i.credits !== null,
        test: (i) => i.credits !== null && form.ects.some((e) => CREDIT_TEST[e]?.(i.credits ?? 0)),
      };
    case 'sen':
      return {
        key,
        known: (i) => i.seniority.length > 0,
        test: (i) => has(form.sen)(i.seniority),
      };
    case 'edu':
      return {
        key,
        known: (i) => i.education.length > 0,
        test: (i) => i.education.includes(form.edu),
      };
    case 'lang':
      // No language beyond the ones ticked: a vacancy asking for none fits any choice.
      return {
        key,
        known: (i) => i.languages !== null,
        test: (i) => i.languages !== null && i.languages.every((l) => form.lang.includes(l)),
      };
    case 'nolic':
      return {
        key,
        known: (i) => i.licences !== null,
        test: (i) => i.licences !== null && i.licences.length === 0,
      };
    case 'stud':
      return { key, known: (i) => i.students !== null, test: (i) => i.students === true };
    case 'ben':
      // Every benefit ticked must be offered.
      return {
        key,
        known: (i) => i.benefits !== null,
        test: (i) => i.benefits !== null && form.ben.every((b) => i.benefits?.includes(b)),
      };
    case 'board':
      return { key, known: null, test: (i) => has(form.board)(i.boards) };
    case 'cross':
      return { key, known: null, test: (i) => i.boards.length > 1 };
    case 'status':
      return { key, known: null, test: (i) => form.status.includes(i.status) };
  }
}

function compile(form: BrowseForm, ctx: EngineContext): Check[] {
  return activeKeys(form, ctx.surface).map((key) => {
    const check = checkFor(key, form, ctx);
    // A fact only some listings state is a "stated" filter; the others always know.
    return STATED_KEYS.has(key) ? check : { ...check, known: null };
  });
}

/** Rows of the kind, open now on the public site. */
export function scope(items: readonly BrowseItem[], kind: KindChoice, ctx: EngineContext) {
  return items.filter((item) => (kind === '' || item.kind === kind) && isEligible(item, ctx));
}

interface Pass {
  /** Rows that pass every filter; with `keep`, rows not stating a kept fact too. */
  matches: BrowseItem[];
  /** Matches that pass only because a kept filter's fact is not stated. */
  unstated: Set<string>;
  /** Rows that fail exactly one filter, by that filter. */
  onlyFails: Map<FilterKey, BrowseItem[]>;
  /** Of those, the ones failing only for not stating the fact. */
  onlyUnknown: Map<FilterKey, BrowseItem[]>;
  /** Rows failing only for not stating facts (any number of filters, none kept). */
  lenient: number;
}

function run(rows: readonly BrowseItem[], checks: readonly Check[], keep: readonly string[]): Pass {
  const pass: Pass = {
    matches: [],
    unstated: new Set(),
    onlyFails: new Map(),
    onlyUnknown: new Map(),
    lenient: 0,
  };
  for (const item of rows) {
    let fails = 0;
    let failKey: FilterKey | null = null;
    let failUnknown = false;
    let allUnknown = true;
    let kept = false;
    for (const check of checks) {
      const known = check.known === null || check.known(item);
      if (!known) {
        if (keep.includes(check.key)) {
          kept = true;
          continue;
        }
        fails++;
        failKey = check.key;
        failUnknown = true;
      } else if (!check.test(item)) {
        fails++;
        failKey = check.key;
        failUnknown = false;
        allUnknown = false;
      } else continue;
      if (fails > 1 && !allUnknown) break;
    }
    if (fails === 0) {
      pass.matches.push(item);
      if (kept) pass.unstated.add(item.id);
      continue;
    }
    if (allUnknown) pass.lenient++;
    if (fails === 1 && failKey !== null) {
      push(pass.onlyFails, failKey, item);
      if (failUnknown) push(pass.onlyUnknown, failKey, item);
    }
  }
  return pass;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** How many rows a form shows. */
export function countMatches(
  items: readonly BrowseItem[],
  form: BrowseForm,
  ctx: EngineContext,
): number {
  return run(scope(items, form.kind, ctx), compile(form, ctx), form.keep).matches.length;
}

/* ---------------------------------------------------------------- order */

const later = (a: number | null, b: number | null) =>
  (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY);
const TITLE_ORDER = new Intl.Collator('ka');

function comparator(form: BrowseForm): (a: BrowseItem, b: BrowseItem) => number {
  const byId = (a: BrowseItem, b: BrowseItem) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const newest = (a: BrowseItem, b: BrowseItem) => b.firstSeenMs - a.firstSeenMs || byId(a, b);
  switch (form.sort) {
    case 'deadline':
      return (a, b) => later(a.deadlineMs, b.deadlineMs) || byId(a, b);
    case 'title':
      return (a, b) => TITLE_ORDER.compare(a.title, b.title) || byId(a, b);
    case 'salary':
      return (a, b) =>
        (b.salary === null ? -1 : salaryHigh(b.salary)) -
          (a.salary === null ? -1 : salaryHigh(a.salary)) || newest(a, b);
    case 'starts':
      return (a, b) => (a.start ?? '9999').localeCompare(b.start ?? '9999') || newest(a, b);
    case 'fee':
      return (a, b) => later(a.feeEur, b.feeEur) || newest(a, b);
    default:
      return newest;
  }
}

/* ---------------------------------------------------------------- counts */

export interface OptionCounts {
  /** Every value the scope holds (most common first), with what picking it would show. */
  options: [string, number][];
}

export interface RangeCounts {
  /** Histogram of the stated values (log scale), when there are enough. */
  edges: number[];
  counts: number[];
  /** What each preset would show, by `min-max`. */
  presets: Record<string, number>;
}

export interface LeftOut {
  /** Rows the filter leaves out for not stating the fact. */
  n: number;
  /** By board set, largest first: boards, count, whether that board never states it. */
  parts: { boards: string[]; n: number; never: boolean }[];
  /** True when the reader keeps them (they are in the list, after the matches). */
  kept: boolean;
}

export interface BrowseView {
  rows: BrowseItem[];
  /** Ids of rows shown only because a kept filter's fact is not stated. */
  unstated: string[];
  total: number;
  /** Rows that would match if every non-stating listing were kept. */
  extra: number;
  /** What each kind would show, after the filters that do not fit it are dropped. */
  kindCounts: Record<string, number>;
  /** Option counts for list filters, by key. */
  options: Partial<Record<FilterKey, OptionCounts>>;
  ranges: Partial<Record<FilterKey, RangeCounts>>;
  /** What each on/off filter would show switched on. */
  toggles: Partial<Record<FilterKey, number>>;
  leftOut: Partial<Record<FilterKey, LeftOut>>;
  /** With nothing matching: what dropping each filter would show. */
  drops: { key: FilterKey; n: number }[];
}

/** Values a row holds for a list filter, for its option counts. */
function valuesOf(key: FilterKey, item: BrowseItem): readonly string[] {
  switch (key) {
    case 'place':
      return item.places;
    case 'field':
      return item.fields;
    case 'ind':
      return item.industries;
    case 'emp':
      return item.contract === null ? [] : [item.contract];
    case 'method':
      return item.method === null ? [] : [item.method];
    case 'subm':
      return item.submission === null ? [] : [item.submission];
    case 'clang':
      return item.teaching;
    case 'wf':
      return item.workplace === null ? [] : [item.workplace];
    case 'starts':
      return item.start === null ? [] : [item.start.slice(0, 7)];
    case 'sched':
      return item.hours === null ? [] : [item.hours];
    case 'sen':
      return item.seniority;
    case 'edu':
      return item.education;
    case 'ben':
      return item.benefits ?? [];
    case 'board':
      return item.boards;
    case 'status':
      return [item.status];
    case 'lang':
      return item.languages ?? [];
    case 'dur':
      return item.days === null
        ? []
        : Object.keys(DURATION_TEST).filter((d) => DURATION_TEST[d]?.(item.days ?? 0));
    case 'ects':
      return item.credits === null
        ? []
        : Object.keys(CREDIT_TEST).filter((e) => CREDIT_TEST[e]?.(item.credits ?? 0));
    case 'online':
      return [item.online ? 'online' : 'onsite'];
    default:
      return [];
  }
}

const LIST_KEYS: readonly FilterKey[] = [
  'place',
  'field',
  'ind',
  'emp',
  'method',
  'subm',
  'clang',
  'wf',
  'online',
  'starts',
  'dur',
  'sched',
  'ects',
  'sen',
  'edu',
  'lang',
  'ben',
  'board',
  'status',
];
const WINDOW_KEYS: readonly FilterKey[] = ['closing', 'since'];
const TOGGLE_KEYS: readonly FilterKey[] = ['bonus', 'nolic', 'stud', 'cross'];
const RANGE_KEYS: readonly FilterKey[] = ['salary', 'value', 'fee'];

export const RANGE_PRESETS: Readonly<Partial<Record<FilterKey, readonly Range[]>>> = {
  salary: [
    { min: 1000, max: null },
    { min: 1500, max: null },
    { min: 2000, max: null },
    { min: 3000, max: null },
  ],
  value: [
    { min: null, max: 50_000 },
    { min: 50_000, max: 200_000 },
    { min: 200_000, max: 1_000_000 },
    { min: 1_000_000, max: null },
  ],
  fee: [
    { min: null, max: 500 },
    { min: 500, max: 1000 },
    { min: 1000, max: 2500 },
    { min: 2500, max: null },
  ],
};

export const presetKey = (r: Range) => `${r.min ?? ''}-${r.max ?? ''}`;

const rangeValue = (key: FilterKey, item: BrowseItem): number | null =>
  key === 'salary'
    ? item.salary === null
      ? null
      : salaryLow(item.salary)
    : key === 'value'
      ? item.valueGel
      : item.feeEur;

const HISTOGRAM_BINS = 30;

function histogram(values: number[]): { edges: number[]; counts: number[] } {
  const positive = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (positive.length < 8) return { edges: [], counts: [] };
  const lo = Math.log(positive[Math.floor(positive.length * 0.02)] ?? 1);
  const hi = Math.log(positive[Math.floor(positive.length * 0.98)] ?? 1);
  if (!(hi > lo)) return { edges: [], counts: [] };
  const edges = Array.from({ length: HISTOGRAM_BINS + 1 }, (_, i) =>
    Math.exp(lo + ((hi - lo) * i) / HISTOGRAM_BINS),
  );
  const counts = new Array<number>(HISTOGRAM_BINS).fill(0);
  for (const v of positive) {
    const bin = Math.floor(((Math.log(v) - lo) / (hi - lo)) * HISTOGRAM_BINS);
    const at = Math.min(HISTOGRAM_BINS - 1, Math.max(0, bin));
    counts[at] = (counts[at] ?? 0) + 1;
  }
  return { edges, counts };
}

/**
 * The page's answer to a form: its rows in order (the matches, then any kept
 * rows that do not state a kept fact) and every count the bar shows.
 */
export function browseView(
  items: readonly BrowseItem[],
  form: BrowseForm,
  ctx: EngineContext,
): BrowseView {
  const scoped = scope(items, form.kind, ctx);
  const checks = compile(form, ctx);
  const pass = run(scoped, checks, form.keep);

  const order = comparator(form);
  const known = pass.matches.filter((i) => !pass.unstated.has(i.id)).sort(order);
  const unstated = pass.matches.filter((i) => pass.unstated.has(i.id)).sort(order);

  // A filter's base: the rows passing every other filter.
  const baseFor = (key: FilterKey): BrowseItem[] =>
    isActive(key, form) ? [...pass.matches, ...(pass.onlyFails.get(key) ?? [])] : pass.matches;

  const options: BrowseView['options'] = {};
  for (const key of LIST_KEYS) {
    if (!applies(key, form.kind, ctx.surface)) continue;
    options[key] = { options: optionCounts(key, form, scoped, baseFor(key)) };
  }
  for (const key of WINDOW_KEYS) {
    const base = baseFor(key);
    const values = key === 'closing' ? ['3', '7', '14', '30'] : ['1', '3', '7', '30'];
    options[key] = {
      options: [
        ['', base.length],
        ...values.map((v): [string, number] => {
          const test = checkFor(key, { ...form, [key]: v }, ctx);
          return [v, base.filter((i) => (test.known?.(i) ?? true) && test.test(i)).length];
        }),
      ],
    };
  }

  const ranges: BrowseView['ranges'] = {};
  for (const key of RANGE_KEYS) {
    if (!applies(key, form.kind, ctx.surface)) continue;
    const base = baseFor(key);
    const stated = base.map((i) => rangeValue(key, i)).filter((v): v is number => v !== null);
    const presets: Record<string, number> = {};
    for (const preset of RANGE_PRESETS[key] ?? []) {
      const test = checkFor(key, { ...form, [key]: preset }, ctx);
      presets[presetKey(preset)] = base.filter(
        (i) => test.known?.(i) !== false && test.test(i),
      ).length;
    }
    ranges[key] = { ...histogram(stated), presets };
  }

  const toggles: BrowseView['toggles'] = {};
  for (const key of TOGGLE_KEYS) {
    if (!applies(key, form.kind, ctx.surface)) continue;
    const test = checkFor(key, { ...form, [key]: true }, ctx);
    toggles[key] = baseFor(key).filter((i) => test.known?.(i) !== false && test.test(i)).length;
  }

  const leftOut: BrowseView['leftOut'] = {};
  for (const check of checks) {
    if (check.known === null) continue;
    const kept = form.keep.includes(check.key);
    const out = kept
      ? pass.matches.filter((i) => !check.known?.(i))
      : (pass.onlyUnknown.get(check.key) ?? []);
    if (out.length === 0) continue;
    leftOut[check.key] = { n: out.length, parts: kept ? [] : partsOf(out, check, scoped), kept };
  }

  const drops =
    pass.matches.length > 0
      ? []
      : activeKeys(form, ctx.surface)
          .map((key) => ({ key, n: pass.onlyFails.get(key)?.length ?? 0 }))
          .filter((d) => d.n > 0)
          .sort((a, b) => b.n - a.n)
          .slice(0, 4);

  const kindCounts: Record<string, number> = {};
  for (const kind of ['', 'job', 'tender', 'course'] as const) {
    kindCounts[kind] =
      kind === form.kind
        ? pass.matches.length
        : countMatches(items, asKind(form, kind, ctx.surface), ctx);
  }

  return {
    rows: [...known, ...unstated],
    unstated: unstated.map((i) => i.id),
    total: pass.matches.length,
    extra: pass.lenient,
    kindCounts,
    options,
    ranges,
    toggles,
    leftOut,
    drops,
  };
}

/** Who a filter leaves out, by board: "275 from jobs.ge, which never states it". */
function partsOf(out: readonly BrowseItem[], check: Check, scoped: readonly BrowseItem[]) {
  const by = new Map<string, number>();
  for (const item of out) {
    const k = item.boards.join(' + ');
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => {
      const boards = key.split(' + ');
      const only = boards.length === 1 ? boards[0] : undefined;
      const never =
        only !== undefined &&
        !scoped.some(
          (i) => i.boards.length === 1 && i.boards[0] === only && check.known?.(i) === true,
        );
      return { boards, n, never };
    });
}

function optionCounts(
  key: FilterKey,
  form: BrowseForm,
  scoped: readonly BrowseItem[],
  base: readonly BrowseItem[],
): [string, number][] {
  // The values on offer and their order: the whole scope, most common first.
  const universe = new Map<string, number>();
  for (const item of scoped)
    for (const v of valuesOf(key, item)) universe.set(v, (universe.get(v) ?? 0) + 1);
  const chosen = chosenOf(key, form);
  for (const v of chosen) if (!universe.has(v)) universe.set(v, 0);
  const order = [...universe.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);

  const counts = new Map<string, number>();
  if (key === 'lang') {
    // No language beyond those ticked: what adding this one would allow.
    for (const v of order) {
      const allowed = new Set([...form.lang, v]);
      counts.set(
        v,
        base.filter((i) => i.languages !== null && i.languages.every((l) => allowed.has(l))).length,
      );
    }
  } else if (key === 'ben') {
    // Every one ticked: what adding this one would leave.
    const kept = base.filter(
      (i) => i.benefits !== null && form.ben.every((b) => i.benefits?.includes(b)),
    );
    for (const item of kept)
      for (const v of item.benefits ?? []) counts.set(v, (counts.get(v) ?? 0) + 1);
  } else {
    for (const item of base)
      for (const v of valuesOf(key, item)) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const out: [string, number][] = order.map((v) => [v, counts.get(v) ?? 0]);
  // A single choice also offers "any": everything its base holds.
  if (key === 'subm' || key === 'edu' || key === 'online') out.unshift(['', base.length]);
  return out;
}

function chosenOf(key: FilterKey, form: BrowseForm): string[] {
  const value = form[key as keyof BrowseForm];
  if (Array.isArray(value)) return value as string[];
  return typeof value === 'string' && value !== '' ? [value] : [];
}

/* ---------------------------------------------------------------- search box */

export interface SuggestCounts {
  /** Place value → rows it would show (with the kind it implies). */
  places: Map<string, number>;
  fields: Map<string, number>;
  /** Organisation → rows, and the kind most of its rows are. */
  orgs: Map<string, { n: number; kind: BrowseKind | null }>;
}

/**
 * Counts for the search box's suggestions, under the rest of the form: a
 * place as the kind it implies would show it (a city switches a course
 * search to jobs), a field under its own kind, an organisation with the
 * other organisations set aside.
 */
export function suggestCounts(
  items: readonly BrowseItem[],
  form: BrowseForm,
  ctx: EngineContext,
): SuggestCounts {
  const out: SuggestCounts = { places: new Map(), fields: new Map(), orgs: new Map() };
  const tally = (
    target: Map<string, number>,
    f: BrowseForm,
    values: (i: BrowseItem) => readonly string[],
  ) => {
    for (const item of run(scope(items, f.kind, ctx), compile(f, ctx), f.keep).matches) {
      for (const v of values(item)) target.set(v, (target.get(v) ?? 0) + 1);
    }
  };
  // A city is a job's place; a country a course's. Under "Tenders" a place leaves the kind.
  const placeKinds: KindChoice[] = form.kind === 'tender' ? [''] : [form.kind];
  for (const kind of placeKinds) {
    tally(out.places, { ...asKind(form, kind, ctx.surface), place: [] }, (i) => i.places);
  }
  if (form.kind === '' || form.kind === 'tender') {
    // A city picked under "All" or "Tenders" keeps the kind it implies, jobs.
    const jobs = new Map<string, number>();
    tally(jobs, { ...asKind(form, 'job', ctx.surface), place: [] }, (i) => i.places);
    for (const [v, n] of jobs) if (!out.places.has(v)) out.places.set(v, n);
  }
  for (const kind of ['job', 'tender', 'course'] as const) {
    tally(out.fields, { ...asKind(form, kind, ctx.surface), field: [] }, (i) => i.fields);
  }
  const byKind = new Map<string, Map<string, number>>();
  for (const item of run(
    scope(items, form.kind, ctx),
    compile({ ...form, org: [] }, ctx),
    form.keep,
  ).matches) {
    for (const org of item.orgs) {
      const kinds = byKind.get(org) ?? new Map<string, number>();
      kinds.set(item.kind ?? '', (kinds.get(item.kind ?? '') ?? 0) + 1);
      byKind.set(org, kinds);
    }
  }
  for (const [org, kinds] of byKind) {
    let n = 0;
    let top: [string, number] = ['', 0];
    for (const entry of kinds) {
      n += entry[1];
      if (entry[1] > top[1]) top = entry;
    }
    out.orgs.set(org, { n, kind: top[0] === '' ? null : (top[0] as BrowseKind) });
  }
  return out;
}
