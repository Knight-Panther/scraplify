import { suggestCounts } from '../../../../../src/browse/browse-engine.js';
import { BROWSE_CHUNK, formSearch } from '../../../../../src/browse/browse-form.js';
import type { BrowseItem } from '../../../../../src/browse/browse-index.js';
import { romanizedName } from '../../../../../src/realestate/place-lookup.js';
import type { Suggestion } from '../../../../components/browse/search-box.js';
import { optionWords } from '../../../../lib/browse-data.js';
import { browseItems } from '../../../../lib/browse-index-cache.js';
import { parseBrowseQuery } from '../../../../lib/browse-params.js';
import { cachedByKey } from '../../../../lib/cached.js';
import { capGraphemes, type RawSearchParams } from '../../../../lib/search-params.js';
import { currentSurface } from '../../../../lib/surface.js';

/**
 * The Browse search box's suggestions (Phase 16C): cities, countries,
 * fields, employers, buyers and schools matching what was typed, each with
 * what picking it would show under the rest of the filters. Read from the
 * same in-memory index as the page, so the public process sees only the
 * public views' rows.
 */

export const dynamic = 'force-dynamic';

const PER_GROUP = 5;
const GROUP_ORDER = [
  'Job fields',
  'Tender categories',
  'Fields of study',
  'Cities in Georgia',
  'Countries',
  'Employers',
  'Buyers',
  'Schools',
  'Organisations',
] as const;

/** The counts depend on the form, not the typed text: kept briefly per form while someone types. */
const counts = cachedByKey<ReturnType<typeof suggestCounts>>(30_000, 200);

/** Lower case, NFC, punctuation as spaces: how a typed text and a name are compared. */
const norm = (text: string) =>
  text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[.,()\-–—'"/&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Organisation names with their Latin spelling, so "silknet" finds "სილქნეტი". */
const orgIndex = new WeakMap<readonly BrowseItem[], Map<string, string>>();
function orgSearchText(items: readonly BrowseItem[], org: string): string {
  let map = orgIndex.get(items);
  if (map === undefined) {
    map = new Map();
    orgIndex.set(items, map);
  }
  let text = map.get(org);
  if (text === undefined) {
    text = `${norm(org)} ${norm(romanizedName(org))}`;
    map.set(org, text);
  }
  return text;
}

const FIELD_GROUP = { j: 'Job fields', t: 'Tender categories', c: 'Fields of study' } as const;
const FIELD_KIND = { j: 'job', t: 'tender', c: 'course' } as const;
const ORG_GROUP = { job: 'Employers', tender: 'Buyers', course: 'Schools' } as const;

export async function GET(request: Request): Promise<Response> {
  const surface = currentSurface() === 'public' ? 'public' : 'local';
  const url = new URL(request.url);
  const raw: RawSearchParams = {};
  for (const key of new Set(url.searchParams.keys())) raw[key] = url.searchParams.getAll(key);
  const form = parseBrowseQuery(raw, surface);
  const typed = norm(capGraphemes(url.searchParams.get('typed') ?? '', 80));

  const items = await browseItems(surface);
  const nowMs = Date.now();
  // Keyed on the checked form, never the raw address: an unknown parameter or a
  // second `typed` cannot make a new entry, so equal requests share one answer.
  const formKey = `${surface}|${formSearch({ ...form, show: BROWSE_CHUNK })}`;
  const c = await counts(formKey, async () =>
    suggestCounts(items, { ...form, show: 0 }, { nowMs, surface }),
  );

  const chosen = new Set([
    ...form.place.map((v) => `place|${v}`),
    ...form.field.map((v) => `field|${v}`),
    ...form.org.map((v) => `org|${v}`),
  ]);
  const groups = new Map<string, Suggestion[]>();
  const add = (group: string, s: Suggestion) => {
    if (chosen.has(`${s.type}|${s.value}`)) return;
    const list = groups.get(group) ?? [];
    list.push(s);
    groups.set(group, list);
  };

  for (const [value, n] of c.places) {
    const words = optionWords('place', value);
    if (typed !== '' && !norm(`${words.label} ${words.hint}`).includes(typed)) continue;
    add(words.group ?? 'Places', {
      type: 'place',
      value,
      kind: value.startsWith('g:') ? 'job' : 'course',
      label: words.label,
      hint: words.hint,
      lang: words.lang ?? 'en',
      n,
    });
  }
  for (const [value, n] of c.fields) {
    const prefix = value.slice(0, 1) as 'j' | 't' | 'c';
    const words = optionWords('field', value);
    if (typed !== '' && !norm(`${words.label} ${words.hint}`).includes(typed)) continue;
    add(FIELD_GROUP[prefix], {
      type: 'field',
      value,
      kind: FIELD_KIND[prefix],
      label: words.label,
      hint: words.hint,
      lang: words.lang ?? 'en',
      n,
    });
  }
  if (typed !== '') {
    for (const [org, { n, kind }] of c.orgs) {
      if (!orgSearchText(items, org).includes(typed)) continue;
      add(kind === null ? 'Organisations' : ORG_GROUP[kind], {
        type: 'org',
        value: org,
        kind,
        label: org,
        hint: '',
        lang: /[Ⴀ-ჿ]/u.test(org) ? 'ka' : 'en',
        n,
      });
    }
  }

  const byCount = (a: Suggestion, b: Suggestion) => b.n - a.n;
  let answer: { title: string; entries: Suggestion[] }[];
  if (typed === '') {
    // Nothing typed: the most common places and fields under the current filters.
    const popular = [...groups.entries()]
      .flatMap(([, list]) => list.sort(byCount).slice(0, 3))
      .sort(byCount)
      .slice(0, 9);
    answer = popular.length === 0 ? [] : [{ title: 'Popular', entries: popular }];
  } else {
    answer = GROUP_ORDER.map((title) => ({
      title,
      entries: (groups.get(title) ?? []).sort(byCount).slice(0, PER_GROUP),
    })).filter((g) => g.entries.length > 0);
  }
  return Response.json({ groups: answer }, { headers: { 'Cache-Control': 'no-store' } });
}
