import type { BrowseView, LeftOut } from '../../src/browse/browse-engine.js';
import type { BrowseForm, FilterKey } from '../../src/browse/browse-form.js';
import type { BrowseData, BrowseOption, LeftOutText } from './browse-registry.js';
import { fmt } from './browse-registry.js';
import {
  CPV_DIVISION_EN,
  cityEnglish,
  FIELD_EN,
  monthLabel,
  ORDERED_KEYS,
  SOURCE_NAMES,
  VOCAB,
} from './browse-vocab.js';
import { listingStatusLabel } from './labels.js';

/**
 * The engine's answer (`src/browse/browse-engine.ts`) in words: each option
 * labelled in the board's language with English beside it, in the order a
 * reader expects, and each "left out" count said by board (Phase 16C).
 */

const FIXED: Readonly<Partial<Record<FilterKey, Readonly<Record<string, string>>>>> = {
  closing: {
    '': 'Any time',
    '3': 'In 3 days',
    '7': 'In 7 days',
    '14': 'In 14 days',
    '30': 'In 30 days',
  },
  since: {
    '': 'Any time',
    '1': 'Last 24 hours',
    '3': 'Last 3 days',
    '7': 'Last 7 days',
    '30': 'Last 30 days',
  },
  subm: { '': 'Any', platform: 'On etenders.ge', off_platform: 'Elsewhere, as the notice says' },
  online: { '': 'Any', online: 'Online', onsite: 'On site or hybrid' },
  dur: { w1: 'A week or less', w2: '1–2 weeks', w4: '2–4 weeks', w5: 'Over 4 weeks' },
  ects: { '0': 'None', lo: '1–5', mid: '6–8', hi: '10 or more' },
  edu: { '': 'Any' },
};
const FIXED_ORDER: Readonly<Partial<Record<FilterKey, readonly string[]>>> = {
  dur: ['w1', 'w2', 'w4', 'w5'],
  ects: ['0', 'lo', 'mid', 'hi'],
};

const isGeorgian = (text: string) => /[Ⴀ-ჿ]/u.test(text);

/** An option's words: the label, its English, and the language of the label. */
export function optionWords(key: FilterKey, value: string): Omit<BrowseOption, 'value' | 'n'> {
  const fixed = FIXED[key]?.[value];
  if (fixed !== undefined) return { label: fixed, hint: '', lang: 'en' };
  switch (key) {
    case 'place':
      if (value.startsWith('g:')) {
        const city = value.slice(2);
        return { label: city, hint: cityEnglish(city), lang: 'ka', group: 'Cities in Georgia' };
      }
      return { label: value.slice(2), hint: '', lang: 'en', group: 'Countries' };
    case 'field': {
      const name = value.slice(2);
      if (value.startsWith('j:'))
        return { label: name, hint: FIELD_EN.get(name) ?? '', lang: 'ka' };
      if (value.startsWith('t:')) {
        return { label: CPV_DIVISION_EN.get(name) ?? `CPV division ${name}`, hint: '', lang: 'en' };
      }
      return { label: name, hint: '', lang: 'en' };
    }
    case 'starts':
      return { label: monthLabel(value), hint: '', lang: 'en' };
    case 'board':
      return { label: SOURCE_NAMES[value] ?? value, hint: '', lang: 'en' };
    case 'status':
      return { label: listingStatusLabel(value).short, hint: '', lang: 'en' };
    default: {
      const en = VOCAB[key]?.get(value) ?? '';
      return isGeorgian(value)
        ? { label: value, hint: en, lang: 'ka' }
        : { label: value, hint: '', lang: 'en' };
    }
  }
}

/** A filter's options in the order a reader expects: the board's own order where it has one. */
function ordered(key: FilterKey, options: [string, number][]): [string, number][] {
  const fixed = FIXED_ORDER[key];
  if (fixed !== undefined) {
    const n = new Map(options);
    return fixed.map((v) => [v, n.get(v) ?? 0]);
  }
  if (!ORDERED_KEYS.has(key)) return options;
  const vocab = [...(VOCAB[key]?.keys() ?? [])];
  const rank = (v: string) => {
    if (v === '') return -1;
    const i = vocab.indexOf(v);
    return i === -1 ? vocab.length : i;
  };
  return options
    .map((o, index) => ({ o, index }))
    .sort((a, b) => rank(a.o[0]) - rank(b.o[0]) || a.index - b.index)
    .map(({ o }) => o);
}

function boardsName(boards: readonly string[]): string {
  const names = boards.map((b) => SOURCE_NAMES[b] ?? b);
  return names.length > 1 ? `both ${names.join(' and ')}` : (names[0] ?? '');
}

function leftOutText(out: LeftOut): LeftOutText {
  const top = out.parts.slice(0, 3);
  const rest = out.parts.slice(3).reduce((sum, p) => sum + p.n, 0);
  const parts = top.map(
    (p) => `${fmt(p.n)} from ${boardsName(p.boards)}${p.never ? ', which never states it' : ''}`,
  );
  if (rest > 0) parts.push(`${fmt(rest)} more from other boards`);
  return { n: out.n, parts, kept: out.kept };
}

export function browseData(
  view: BrowseView,
  surface: 'local' | 'public',
  orgKinds: Record<string, string>,
  /** The day of the rates the rows were converted at (`browseRatesDate`). */
  ratesDate: string,
): BrowseData {
  const options: BrowseData['options'] = {};
  for (const [key, counts] of Object.entries(view.options) as [
    FilterKey,
    { options: [string, number][] },
  ][]) {
    options[key] = ordered(key, counts.options).map(([value, n]) => ({
      value,
      n,
      ...optionWords(key, value),
    }));
  }
  const leftOut: BrowseData['leftOut'] = {};
  for (const [key, out] of Object.entries(view.leftOut) as [FilterKey, LeftOut][]) {
    leftOut[key] = leftOutText(out);
  }
  return {
    surface,
    total: view.total,
    extra: view.extra,
    unstated: view.unstated.length,
    kindCounts: view.kindCounts,
    options,
    ranges: view.ranges,
    toggles: view.toggles,
    leftOut,
    orgKinds,
    ratesDate,
  };
}

/** Whether the form asks for anything beyond its kind and order. */
export function isFiltered(form: BrowseForm): boolean {
  return (
    form.q !== '' ||
    form.org.length > 0 ||
    Object.keys(form).some((k) => {
      if (k === 'kind' || k === 'sort' || k === 'show' || k === 'keep' || k === 'q') return false;
      const v = form[k as keyof BrowseForm];
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') return v !== '';
      if (typeof v === 'object' && v !== null) return v.min !== null || v.max !== null;
      return false;
    })
  );
}
