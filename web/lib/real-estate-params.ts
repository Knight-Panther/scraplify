import {
  BUILDING_STATUSES,
  COMMERCIAL_TYPE_CODES,
  CONDITIONS,
  DEAL_TYPES,
  FLOOR_TYPES,
  LAND_TYPE_CODES,
  PROJECTS,
  PROPERTY_TYPES,
} from '../../src/realestate/kinds.js';
import type {
  RealEstateFilters,
  RealEstateLocations,
  RealEstateSort,
} from '../../src/realestate/queries.js';
import {
  amenitiesFor,
  COUNT_CHOICES,
  type CountGroup,
  countLabel,
  LISTING_TYPES,
  OTHER_INFO,
  PANELS,
  type PanelGroup,
} from './real-estate-panels.js';
import { capGraphemes, MAX_TEXT, many, one, type RawSearchParams } from './search-params.js';

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

export const DEAL_OPTIONS = DEAL_TYPES;
export const KIND_OPTIONS = PROPERTY_TYPES;
export const CURRENCY_OPTIONS = ['usd', 'gel'] as const;
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
  /** Commercial space types (ss.ge codes), only with the kind `commercial`. Repeated in the address. */
  ct: string[];
  /** Land types (ss.ge codes), only with the kind `land`. Repeated in the address. */
  lt: string[];
  city: string;
  /** Building status. Repeated, like every list below. */
  st: string[];
  /** `d<ref>` for a whole district, `s<ref>` for one sub-district. */
  area: string;
  cur: string;
  /** `1` when the price bounds are per m². */
  pm2: string;
  pmin: string;
  pmax: string;
  amin: string;
  amax: string;
  /** `1` to `9`, and `10+` for ten or more. */
  rooms: string[];
  floor: string;
  by: string;
  since: string;
  // The rest is the chosen kind's "more filters" panel (`PANELS`), in the order it draws them.
  hmin: string;
  hmax: string;
  ymin: string;
  ymax: string;
  cond: string[];
  kmin: string;
  kmax: string;
  fmin: string;
  fmax: string;
  ftype: string[];
  /** `1` to `4`, `5+` for five or more, `0` for none; bathrooms the same. */
  bal: string[];
  bath: string[];
  proj: string[];
  /** `LISTING_TYPES`. */
  ptype: string[];
  /** Amenities, and a flat's "other information", which are amenity keys too. */
  am: string[];
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

/** The codes asked for that the list knows, in the list's own order, so one choice has one address. */
function codes(values: string[], known: Readonly<Record<number, string>>): string[] {
  return Object.keys(known).filter((code) => values.includes(code));
}

/** A whole number from 1 to 999,999,999, as typed; anything else is no bound. */
function bound(value: string): number | null {
  return /^[1-9][0-9]{0,8}$/.test(value) ? Number(value) : null;
}

/** A bound as the form shows it. */
const typed = (value: number | null): string => (value === null ? '' : String(value));

/** The options asked for, in the options' own order, each once. */
function picks<T extends string>(values: string[], options: readonly T[]): T[] {
  return options.filter((option) => values.includes(option));
}

/** A count chip's value in the address: `10+` for the top chip, `0` for none. */
export function countValue(group: CountGroup, count: number): string {
  return count === 0 ? '0' : countLabel(group, count);
}

/** The count chips asked for, in the chips' own order. */
function counts(group: CountGroup, values: string[]): number[] {
  return COUNT_CHOICES[group].filter((count) => values.includes(countValue(group, count)));
}

/** Before Phase 12C a single `5+` meant five rooms or more: the chips from 5 up. */
const LEGACY_ROOMS = COUNT_CHOICES.rooms
  .filter((count) => count >= 5)
  .map((count) => countValue('rooms', count));

export function parseRealEstateQuery(
  raw: RawSearchParams,
  places: RealEstateLocations,
  now: number = Date.now(),
): RealEstateQuery {
  const deal = choice(one(raw.deal), DEAL_OPTIONS);
  const kind = choice(one(raw.kind), KIND_OPTIONS);
  // A sub-type only means something under its own kind, the way ss.ge swaps its panel.
  const ct = kind === 'commercial' ? codes(many(raw.ct), COMMERCIAL_TYPE_CODES) : [];
  const lt = kind === 'land' ? codes(many(raw.lt), LAND_TYPE_CODES) : [];
  const cur = choice(one(raw.cur), CURRENCY_OPTIONS) || 'usd';
  const pm2 = one(raw.pm2) === '1' ? '1' : '';

  // The "more filters" panel is the applied kind's: no kind, no panel.
  const panel: readonly PanelGroup[] = kind === '' ? [] : PANELS[kind];
  const offers = (group: PanelGroup) => panel.includes(group);
  const listed = <T extends string>(group: PanelGroup, key: string, options: readonly T[]) =>
    offers(group) ? picks(many(raw[key]), options) : [];
  const ranged = (group: PanelGroup, key: string) => (offers(group) ? bound(one(raw[key])) : null);

  const st = listed('status', 'st', Object.values(BUILDING_STATUSES));
  const cond = listed('condition', 'cond', Object.values(CONDITIONS));
  const proj = listed('project', 'proj', Object.values(PROJECTS));
  const ftype = listed('floor-type', 'ftype', Object.values(FLOOR_TYPES));
  const ptype = listed('listing-type', 'ptype', LISTING_TYPES);
  const am =
    kind === ''
      ? []
      : picks(many(raw.am), [
          ...(offers('amenities') ? amenitiesFor(kind, deal === '' ? undefined : deal) : []),
          ...(offers('other-info') ? OTHER_INFO : []),
        ]);
  const bath = offers('bathrooms') ? counts('bathrooms', many(raw.bath)) : [];
  const bal = offers('balconies') ? counts('balconies', many(raw.bal)) : [];
  // Rooms sit in the main bar, so they hold with no kind too.
  const rooms =
    kind === '' || offers('rooms')
      ? counts(
          'rooms',
          many(raw.rooms).flatMap((value) => (value === '5+' ? LEGACY_ROOMS : [value])),
        )
      : [];
  const fmin = ranged('floor', 'fmin');
  const fmax = ranged('floor', 'fmax');
  const kmin = ranged('kitchen-area', 'kmin');
  const kmax = ranged('kitchen-area', 'kmax');
  const hmin = ranged('house-area', 'hmin');
  const hmax = ranged('house-area', 'hmax');
  const ymin = ranged('yard-area', 'ymin');
  const ymax = ranged('yard-area', 'ymax');

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
      ...(ct.length === 0 ? {} : { commercialTypes: ct.map(Number) }),
      ...(lt.length === 0 ? {} : { landTypes: lt.map(Number) }),
      ...(city === null ? {} : { cityRef: city }),
      ...(area.startsWith('s') ? { subdistrictRef: Number(area.slice(1)) } : {}),
      ...(area.startsWith('d') ? { districtRef: Number(area.slice(1)) } : {}),
      ...(pmin === null ? {} : { priceMin: pmin }),
      ...(pmax === null ? {} : { priceMax: pmax }),
      ...(amin === null ? {} : { areaMin: amin }),
      ...(amax === null ? {} : { areaMax: amax }),
      ...(pm2 === '' ? {} : { pricePerM2: true }),
      ...(rooms.length === 0 ? {} : { roomsIn: rooms }),
      ...(floor === '' ? {} : { floor }),
      ...(by === '' ? {} : { poster: by }),
      ...(since === ''
        ? {}
        : { updatedSince: new Date(now - Number(since) * 24 * 60 * 60 * 1000).toISOString() }),
      ...(st.length === 0 ? {} : { buildingStatuses: st }),
      ...(hmin === null ? {} : { houseAreaMin: hmin }),
      ...(hmax === null ? {} : { houseAreaMax: hmax }),
      ...(ymin === null ? {} : { yardAreaMin: ymin }),
      ...(ymax === null ? {} : { yardAreaMax: ymax }),
      ...(cond.length === 0 ? {} : { conditions: cond }),
      ...(kmin === null ? {} : { kitchenAreaMin: kmin }),
      ...(kmax === null ? {} : { kitchenAreaMax: kmax }),
      ...(fmin === null ? {} : { floorMin: fmin }),
      ...(fmax === null ? {} : { floorMax: fmax }),
      ...(ftype.length === 0 ? {} : { floorTypes: ftype }),
      ...(bal.length === 0 ? {} : { balconies: bal }),
      ...(bath.length === 0 ? {} : { bathrooms: bath }),
      ...(proj.length === 0 ? {} : { projects: proj }),
      ...(ptype.includes('developer') ? { developerOnly: true } : {}),
      ...(ptype.includes('photos') ? { withPhotos: true } : {}),
      ...(ptype.includes('owner') ? { ownerOnly: true } : {}),
      ...(ptype.includes('exclusive') ? { exclusiveOnly: true } : {}),
      ...(am.length === 0 ? {} : { amenities: am }),
      ...(q === '' ? {} : { text: q }),
      // A group's own page lists all its members; otherwise grouped unless asked not to be.
      ...(group === '' ? { grouped: view !== 'all' } : { groupKey: group }),
    },
    show,
    // The order here is the address's order.
    form: {
      deal,
      kind,
      st,
      ct,
      lt,
      city: city === null ? '' : String(city),
      area,
      cur,
      pm2,
      pmin: typed(pmin),
      pmax: typed(pmax),
      amin: typed(amin),
      amax: typed(amax),
      rooms: rooms.map((count) => countValue('rooms', count)),
      floor,
      by,
      since,
      hmin: typed(hmin),
      hmax: typed(hmax),
      ymin: typed(ymin),
      ymax: typed(ymax),
      cond,
      kmin: typed(kmin),
      kmax: typed(kmax),
      fmin: typed(fmin),
      fmax: typed(fmax),
      ftype,
      bal: bal.map((count) => countValue('balconies', count)),
      bath: bath.map((count) => countValue('bathrooms', count)),
      proj,
      ptype,
      am,
      q,
      sort,
      view,
      group,
    },
  };
}

/** Whether anything narrows the list: decides what an empty result says. */
export function isFiltered(query: RealEstateQuery): boolean {
  const { cur: _cur, pm2: _pm2, sort: _sort, view: _view, ...narrowing } = query.form;
  return Object.values(narrowing).some((value) => value.length > 0);
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
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
      continue;
    }
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
