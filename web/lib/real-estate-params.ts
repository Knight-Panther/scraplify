import type {
  RealEstateFilters,
  RealEstateLocations,
  RealEstateSort,
} from '../../src/realestate/queries.js';
import { capGraphemes, MAX_TEXT, one, type RawSearchParams } from './search-params.js';

/**
 * The Real estate screen's state, held entirely in the address: the same
 * contract as the opportunities and listings screens, for the same reasons.
 * A filtered view is a plain link, the back button works, and every render
 * is a straight server query.
 *
 * Everything here is untrusted input. A value that is not recognised is
 * dropped, never forwarded, so the form always shows what the results
 * reflect.
 */

/** Rows added per "show more". Smaller than Browse's 500: a row here has ten columns. */
export const REAL_ESTATE_CHUNK = 100;
/** The most rows one page will render; past it the answer is a narrower filter. */
export const REAL_ESTATE_MAX_SHOWN = 2_000;

export const DEAL_OPTIONS = ['sale', 'rent'] as const;
export const KIND_OPTIONS = ['flat', 'house', 'cottage'] as const;
export const CURRENCY_OPTIONS = ['usd', 'gel'] as const;
export const ROOM_OPTIONS = ['1', '2', '3', '4', '5+'] as const;
export const FLOOR_OPTIONS = ['not-first', 'not-last', 'middle'] as const;
export const POSTER_OPTIONS = ['business', 'other'] as const;
export const UPDATED_OPTIONS = ['1', '3', '7', '30'] as const;
/** `all` lists every listing; the default folds look-alikes into one row (Phase 11D). */
export const VIEW_OPTIONS = ['all'] as const;
/** A group key as `src/realestate/grouping.ts` makes them. */
const GROUP_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const SORT_OPTIONS = [
  'newest',
  'price-asc',
  'price-desc',
  'ppm2-asc',
  'area-desc',
] as const satisfies readonly RealEstateSort[];

export interface RealEstateForm {
  deal: string;
  kind: string;
  city: string;
  /** `d<ref>` for a whole district, `s<ref>` for one sub-district. */
  area: string;
  cur: string;
  pmin: string;
  pmax: string;
  amin: string;
  amax: string;
  rooms: string;
  floor: string;
  by: string;
  since: string;
  q: string;
  sort: string;
  /** `''` (grouped) or `all`. */
  view: string;
  /** One look-alike group's key, which lists its members. */
  group: string;
}

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

/** A whole number from 1 to 999,999,999, as typed; anything else is no bound. */
function bound(value: string): number | null {
  return /^[1-9][0-9]{0,8}$/.test(value) ? Number(value) : null;
}

export function parseRealEstateQuery(
  raw: RawSearchParams,
  places: RealEstateLocations,
  now: number = Date.now(),
): RealEstateQuery {
  const deal = choice(one(raw.deal), DEAL_OPTIONS);
  const kind = choice(one(raw.kind), KIND_OPTIONS);
  const cur = choice(one(raw.cur), CURRENCY_OPTIONS) || 'usd';
  const rooms = choice(one(raw.rooms), ROOM_OPTIONS);
  const floor = choice(one(raw.floor), FLOOR_OPTIONS);
  const by = choice(one(raw.by), POSTER_OPTIONS);
  const since = choice(one(raw.since), UPDATED_OPTIONS);
  const sort = choice(one(raw.sort), SORT_OPTIONS) || 'newest';
  const view = choice(one(raw.view), VIEW_OPTIONS);
  const rawGroup = one(raw.group).toLowerCase();
  const group = GROUP_KEY.test(rawGroup) ? rawGroup : '';
  const q = capGraphemes(one(raw.q), MAX_TEXT);

  const cityRef = bound(one(raw.city));
  const city = places.cities.some((entry) => entry.ref === cityRef) ? cityRef : null;

  // An area only means something inside its city.
  const rawArea = one(raw.area);
  const areaRef = bound(rawArea.slice(1));
  const inCity = places.subdistricts.filter((entry) => entry.cityRef === city);
  let area = '';
  if (city !== null && areaRef !== null) {
    if (rawArea.startsWith('s') && inCity.some((entry) => entry.ref === areaRef)) area = rawArea;
    if (rawArea.startsWith('d') && inCity.some((entry) => entry.districtRef === areaRef)) {
      area = rawArea;
    }
  }

  const pmin = bound(one(raw.pmin));
  const pmax = bound(one(raw.pmax));
  const amin = bound(one(raw.amin));
  const amax = bound(one(raw.amax));

  const parsedShow = Number.parseInt(one(raw.show), 10);
  const show =
    Number.isInteger(parsedShow) && parsedShow > REAL_ESTATE_CHUNK
      ? Math.min(
          Math.ceil(parsedShow / REAL_ESTATE_CHUNK) * REAL_ESTATE_CHUNK,
          REAL_ESTATE_MAX_SHOWN,
        )
      : REAL_ESTATE_CHUNK;

  return {
    filters: {
      currency: cur,
      sort,
      ...(deal === '' ? {} : { dealType: deal }),
      ...(kind === '' ? {} : { propertyType: kind }),
      ...(city === null ? {} : { cityRef: city }),
      ...(area.startsWith('s') ? { subdistrictRef: Number(area.slice(1)) } : {}),
      ...(area.startsWith('d') ? { districtRef: Number(area.slice(1)) } : {}),
      ...(pmin === null ? {} : { priceMin: pmin }),
      ...(pmax === null ? {} : { priceMax: pmax }),
      ...(amin === null ? {} : { areaMin: amin }),
      ...(amax === null ? {} : { areaMax: amax }),
      ...(rooms === '' ? {} : { rooms: Number.parseInt(rooms, 10) }),
      ...(rooms.endsWith('+') ? { roomsOrMore: true } : {}),
      ...(floor === '' ? {} : { floor }),
      ...(by === '' ? {} : { poster: by }),
      ...(since === ''
        ? {}
        : { updatedSince: new Date(now - Number(since) * 24 * 60 * 60 * 1000).toISOString() }),
      ...(q === '' ? {} : { text: q }),
      // A group's own page lists all its members; otherwise grouped unless asked not to be.
      ...(group === '' ? { grouped: view !== 'all' } : { groupKey: group }),
    },
    show,
    form: {
      deal,
      kind,
      city: city === null ? '' : String(city),
      area,
      cur,
      pmin: pmin === null ? '' : String(pmin),
      pmax: pmax === null ? '' : String(pmax),
      amin: amin === null ? '' : String(amin),
      amax: amax === null ? '' : String(amax),
      rooms,
      floor,
      by,
      since,
      q,
      sort,
      view,
      group,
    },
  };
}

/** Whether anything narrows the list: decides what an empty result says. */
export function isFiltered(query: RealEstateQuery): boolean {
  const { cur: _cur, sort: _sort, view: _view, ...narrowing } = query.form;
  return Object.values(narrowing).some((value) => value !== '');
}

/** A link to the same view, with the depth, the grouping or the group changed when asked. */
export function buildRealEstateHref(
  query: RealEstateQuery,
  changes: Partial<{ show: number; view: '' | 'all'; group: string }> = {},
): string {
  const params = new URLSearchParams();
  const form = {
    ...query.form,
    ...(changes.view === undefined ? {} : { view: changes.view }),
    ...(changes.group === undefined ? {} : { group: changes.group }),
  };
  for (const [key, value] of Object.entries(form)) {
    if (value === '') continue;
    // The defaults stay out of the address, so the bare page has a bare address.
    if (key === 'cur' && value === 'usd') continue;
    if (key === 'sort' && value === 'newest') continue;
    params.set(key, value);
  }
  // A change of grouping or group starts the list from its top.
  const show =
    changes.show ?? (changes.view !== undefined || changes.group !== undefined ? 0 : query.show);
  if (show > REAL_ESTATE_CHUNK) params.set('show', String(show));

  const search = params.toString();
  return search === '' ? '/real-estate' : `/real-estate?${search}`;
}
