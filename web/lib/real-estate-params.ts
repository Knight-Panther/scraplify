import type { MetroMinutes, RealEstatePlace } from '../../src/realestate/filters.js';
import {
  BUILDING_STATUSES,
  CONDITIONS,
  type DealType,
  FLOOR_TYPES,
  PROJECTS,
  PROPERTY_TYPES,
} from '../../src/realestate/kinds.js';
import type { RealEstateFilters, RealEstateSort } from '../../src/realestate/queries.js';
import {
  applicable,
  CURRENCY_OPTIONS,
  DEAL_CHOICES,
  emptyForm,
  FLOOR_OPTIONS,
  formHref,
  isFormFiltered,
  MAX_PLACES,
  METRO_CODES,
  METRO_MINUTE_OPTIONS,
  PLACE_LEVELS,
  POSTER_OPTIONS,
  REAL_ESTATE_CHUNK,
  type RealEstateForm,
  SORT_OPTIONS,
  UPDATED_OPTIONS,
  VIEW_OPTIONS,
} from './real-estate-form.js';
import { COUNT_CHOICES, type CountGroup, countLabel, LISTING_TYPES } from './real-estate-panels.js';
import { capGraphemes, MAX_TEXT, many, one, type RawSearchParams } from './search-params.js';

export { REAL_ESTATE_CHUNK, type RealEstateForm } from './real-estate-form.js';

/**
 * The Real estate screen's state, held entirely in the address: the same
 * contract as the opportunities and listings screens, for the same reasons.
 * A filtered view is a plain link, the back button works, and every render
 * is a straight server query. The filter bar (Phase 16B) changes the address
 * and the server answers; `real-estate-form.ts` holds the rules both share.
 *
 * Everything here is untrusted input. A value that is not recognised is
 * dropped, never forwarded, so the form always shows what the results
 * reflect.
 */

/** The most rows one page will render; past it the answer is a narrower filter. */
export const REAL_ESTATE_MAX_SHOWN = 2_000;

/** A group key as `src/realestate/grouping.ts` makes them. */
const GROUP_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface RealEstateQuery {
  /** Ready to hand to `searchRealEstate` and `countRealEstate`. */
  filters: Omit<RealEstateFilters, 'limit' | 'offset' | 'sourceId'>;
  /** How many rows this view renders. Grows by REAL_ESTATE_CHUNK via the bottom link. */
  show: number;
  /** The values the form should show: always the accepted ones, never the raw input. */
  form: RealEstateForm;
}

function choice<T extends string>(value: string, options: readonly T[]): T | '' {
  return (options as readonly string[]).includes(value) ? (value as T) : '';
}

/** The values asked for that the list knows, in the list's own order, each once. */
function picks(values: string[], options: readonly string[]): string[] {
  return options.filter((option) => values.includes(option));
}

/** A whole number from 1 to 999,999,999, as typed; anything else is no bound. */
function bound(value: string): number | null {
  return /^[1-9][0-9]{0,8}$/.test(value) ? Number(value) : null;
}

/** A bound as the form shows it. */
const typed = (value: string): string => {
  const n = bound(value);
  return n === null ? '' : String(n);
};

/** A count chip's value in the address: `10+` for the top chip, `0` for none. */
export function countValue(group: CountGroup, count: number): string {
  return count === 0 ? '0' : countLabel(group, count);
}

/** The count chips asked for, in the chips' own order, as the address writes them. */
function countPicks(group: CountGroup, values: string[]): string[] {
  return COUNT_CHOICES[group]
    .map((count) => countValue(group, count))
    .filter((value) => values.includes(value));
}

/** A count chip's number: `10+` is 10, which the query reads as that many or more. */
const countNumber = (value: string): number => Number.parseInt(value, 10);

/** Before Phase 12C a single `5+` meant five rooms or more: the chips from 5 up. */
const LEGACY_ROOMS = COUNT_CHOICES.rooms
  .filter((count) => count >= 5)
  .map((count) => countValue('rooms', count));

/** `level:ref`, a level the Where box names and a whole number. */
function placeValue(value: string): string | null {
  const match = /^([a-z_]+):([1-9][0-9]{0,9})$/.exec(value);
  if (match === null) return null;
  const [, level, ref] = match as unknown as [string, string, string];
  if (!(PLACE_LEVELS as readonly string[]).includes(level)) return null;
  return Number(ref) <= 2_147_483_647 ? `${level}:${ref}` : null;
}

/**
 * The places asked for, each once, at most `MAX_PLACES`. Before Phase 16B the
 * tab took one city and, inside it, one district (`d<ref>`) or sub-district
 * (`s<ref>`): an old link becomes the narrowest place it named.
 */
function placesOf(raw: RawSearchParams): string[] {
  const asked = many(raw.pl).map(placeValue);
  const city = bound(one(raw.city));
  const area = one(raw.area);
  const areaRef = bound(area.slice(1));
  if (city !== null) {
    if (areaRef !== null && area.startsWith('s')) asked.push(`subdistrict:${areaRef}`);
    else if (areaRef !== null && area.startsWith('d')) asked.push(`district:${areaRef}`);
    else asked.push(`city:${city}`);
  }
  return [...new Set(asked.filter((value) => value !== null))].slice(0, MAX_PLACES);
}

export function placeOf(value: string): RealEstatePlace {
  const [level, ref] = value.split(':') as [RealEstatePlace['level'], string];
  return { level, ref: Number(ref) };
}

export function parseRealEstateQuery(
  raw: RawSearchParams,
  now: number = Date.now(),
): RealEstateQuery {
  const kind = choice(one(raw.kind), PROPERTY_TYPES);
  // Before 16B a missing deal meant every deal; now it is "Buy", and every deal says so.
  const deal = choice(one(raw.deal), DEAL_CHOICES) || 'sale';
  const metroMinutes = choice(one(raw.mm), METRO_MINUTE_OPTIONS);
  const rawGroup = one(raw.group).toLowerCase();
  const house = kind === 'house' || kind === 'cottage';

  // A house's area on ss.ge is its house area: the two agree on all 775
  // houses whose own page gives both (production, 2026-11-14), and the list's
  // covers every house. So an old house-area link reads as the area.
  const amin = typed(one(raw.amin)) || (house ? typed(one(raw.hmin)) : '');
  const amax = typed(one(raw.amax)) || (house ? typed(one(raw.hmax)) : '');

  const form = applicable({
    ...emptyForm(),
    deal,
    kind,
    ct: many(raw.ct),
    lt: many(raw.lt),
    pl: placesOf(raw),
    mm: metroMinutes,
    ms: picks(many(raw.ms), METRO_CODES),
    unc: one(raw.unc) === '1' ? '1' : '',
    cur: choice(one(raw.cur), CURRENCY_OPTIONS) || 'usd',
    pm2: one(raw.pm2) === '1' ? '1' : '',
    pmin: typed(one(raw.pmin)),
    pmax: typed(one(raw.pmax)),
    amin,
    amax,
    rooms: countPicks(
      'rooms',
      many(raw.rooms).flatMap((value) => (value === '5+' ? LEGACY_ROOMS : [value])),
    ),
    floor: choice(one(raw.floor), FLOOR_OPTIONS),
    fmin: typed(one(raw.fmin)),
    fmax: typed(one(raw.fmax)),
    ymin: typed(one(raw.ymin)),
    ymax: typed(one(raw.ymax)),
    kmin: typed(one(raw.kmin)),
    kmax: typed(one(raw.kmax)),
    st: picks(many(raw.st), Object.values(BUILDING_STATUSES)),
    cond: picks(many(raw.cond), Object.values(CONDITIONS)),
    proj: picks(many(raw.proj), Object.values(PROJECTS)),
    ftype: picks(many(raw.ftype), Object.values(FLOOR_TYPES)),
    bal: countPicks('balconies', many(raw.bal)),
    bath: countPicks('bathrooms', many(raw.bath)),
    ptype: picks(many(raw.ptype), LISTING_TYPES),
    am: [...new Set(many(raw.am))],
    by: choice(one(raw.by), POSTER_OPTIONS),
    since: choice(one(raw.since), UPDATED_OPTIONS),
    q: capGraphemes(one(raw.q), MAX_TEXT),
    sort: choice(one(raw.sort), SORT_OPTIONS) || 'newest',
    view: choice(one(raw.view), VIEW_OPTIONS),
    group: GROUP_KEY.test(rawGroup) ? rawGroup : '',
  });
  const parsedShow = Number.parseInt(one(raw.show), 10);
  const show =
    Number.isInteger(parsedShow) && parsedShow > REAL_ESTATE_CHUNK
      ? Math.min(
          Math.ceil(parsedShow / REAL_ESTATE_CHUNK) * REAL_ESTATE_CHUNK,
          REAL_ESTATE_MAX_SHOWN,
        )
      : REAL_ESTATE_CHUNK;

  return { filters: filtersOf(form, now), show, form };
}

/** A number the form holds, or nothing. */
const n = (value: string): number | undefined => (value === '' ? undefined : Number(value));

/** The query filters a checked form asks for. */
export function filtersOf(
  form: RealEstateForm,
  now: number,
): Omit<RealEstateFilters, 'limit' | 'offset' | 'sourceId'> {
  const metro = form.mm !== '' || form.ms.length > 0;
  const filters: Record<string, unknown> = {
    currency: form.cur as 'usd' | 'gel',
    sort: form.sort as RealEstateSort,
    dealType: form.deal === 'all' ? undefined : (form.deal as DealType),
    propertyType: form.kind === '' ? undefined : (form.kind as RealEstateFilters['propertyType']),
    commercialTypes: form.ct.length === 0 ? undefined : form.ct.map(Number),
    landTypes: form.lt.length === 0 ? undefined : form.lt.map(Number),
    places: form.pl.length === 0 ? undefined : form.pl.map(placeOf),
    metro: metro
      ? {
          ...(form.mm === '' ? {} : { maxMinutes: Number(form.mm) as MetroMinutes }),
          ...(form.ms.length === 0 ? {} : { stations: form.ms }),
        }
      : undefined,
    excludeUncertain: form.unc === '1' ? true : undefined,
    priceMin: n(form.pmin),
    priceMax: n(form.pmax),
    pricePerM2: form.pm2 === '1' ? true : undefined,
    areaMin: n(form.amin),
    areaMax: n(form.amax),
    roomsIn: form.rooms.length === 0 ? undefined : form.rooms.map(countNumber),
    floor: form.floor === '' ? undefined : (form.floor as RealEstateFilters['floor']),
    floorMin: n(form.fmin),
    floorMax: n(form.fmax),
    poster: form.by === '' ? undefined : (form.by as RealEstateFilters['poster']),
    updatedSince:
      form.since === ''
        ? undefined
        : new Date(now - Number(form.since) * 24 * 60 * 60 * 1000).toISOString(),
    buildingStatuses:
      form.st.length === 0 ? undefined : (form.st as RealEstateFilters['buildingStatuses']),
    yardAreaMin: n(form.ymin),
    yardAreaMax: n(form.ymax),
    conditions: form.cond.length === 0 ? undefined : (form.cond as RealEstateFilters['conditions']),
    kitchenAreaMin: n(form.kmin),
    kitchenAreaMax: n(form.kmax),
    floorTypes:
      form.ftype.length === 0 ? undefined : (form.ftype as RealEstateFilters['floorTypes']),
    balconies: form.bal.length === 0 ? undefined : form.bal.map(countNumber),
    bathrooms: form.bath.length === 0 ? undefined : form.bath.map(countNumber),
    projects: form.proj.length === 0 ? undefined : (form.proj as RealEstateFilters['projects']),
    developerOnly: form.ptype.includes('developer') ? true : undefined,
    withPhotos: form.ptype.includes('photos') ? true : undefined,
    ownerOnly: form.ptype.includes('owner') ? true : undefined,
    exclusiveOnly: form.ptype.includes('exclusive') ? true : undefined,
    amenities: form.am.length === 0 ? undefined : (form.am as RealEstateFilters['amenities']),
    text: form.q === '' ? undefined : form.q,
    // A group's own page lists all its members; otherwise grouped unless asked not to be.
    ...(form.group === '' ? { grouped: form.view !== 'all' } : { groupKey: form.group }),
  };
  // Nothing undefined in the object, so a cache key never depends on a key that says nothing.
  for (const key of Object.keys(filters)) {
    if (filters[key] === undefined) delete filters[key];
  }
  return filters as Omit<RealEstateFilters, 'limit' | 'offset' | 'sourceId'>;
}

/** Whether anything narrows the list: decides what an empty result says. */
export function isFiltered(query: RealEstateQuery): boolean {
  return isFormFiltered(query.form);
}

/** A link to the same view, with the depth, the grouping or the group changed when asked. */
export function buildRealEstateHref(
  query: RealEstateQuery,
  changes: Partial<{ show: number; view: '' | 'all'; group: string }> = {},
): string {
  const form = {
    ...query.form,
    ...(changes.view === undefined ? {} : { view: changes.view }),
    ...(changes.group === undefined ? {} : { group: changes.group }),
  };
  // A change of grouping or group starts the list from its top.
  const show =
    changes.show ?? (changes.view !== undefined || changes.group !== undefined ? 0 : query.show);
  return formHref(form, show);
}

/** The same form without the places C6 does not know, once the page has asked it. */
export function keepPlaces(
  query: RealEstateQuery,
  known: ReadonlySet<string>,
  now: number,
): RealEstateQuery {
  const pl = query.form.pl.filter((value) => known.has(value));
  if (pl.length === query.form.pl.length) return query;
  const form = { ...query.form, pl };
  return { ...query, form, filters: filtersOf(form, now) };
}

/**
 * A filter set's key for the tab's cached counts: the parsed filters, without
 * the order and paging no count depends on, and with "updated within" (an
 * instant worked out from each request's clock) floored to `bucketMs`. So two
 * visitors asking the same filters within one cache window share one count.
 * Built from parsed, validated filters only, never from the raw address.
 */
export function countCacheKey(filters: RealEstateFilters, bucketMs: number): string {
  const { sort: _sort, limit: _limit, offset: _offset, updatedSince, ...rest } = filters;
  const key: Record<string, unknown> = { ...rest };
  if (updatedSince !== undefined) {
    key.updatedSince = Math.floor(Date.parse(updatedSince) / bucketMs);
  }
  return JSON.stringify(Object.entries(key).sort(([a], [b]) => a.localeCompare(b)));
}
