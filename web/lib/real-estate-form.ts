import {
  COMMERCIAL_TYPE_CODES,
  type DealType,
  LAND_TYPE_CODES,
  PROPERTY_TYPES,
  type PropertyType,
} from '../../src/realestate/kinds.js';
import { amenitiesFor, OTHER_INFO } from './real-estate-panels.js';

/**
 * The Real estate tab's filters as the address holds them (Phase 16B), with
 * no database or server import, so the filter bar in the browser builds the
 * same addresses the server reads. `real-estate-params.ts` checks a visitor's
 * address against these rules and turns the result into query filters.
 *
 * Every value is a string, as the address writes it. A list is repeated in
 * the address (`rooms=2&rooms=3`).
 */

/** "Buy" is the default (owner-approved mockup, 2026-11-14): prices mean different things across deals. */
export const DEAL_CHOICES = ['sale', 'rent', 'daily', 'pledge', 'all'] as const;
export type DealChoice = (typeof DEAL_CHOICES)[number];
export const DEFAULT_DEAL: DealChoice = 'sale';

export const CURRENCY_OPTIONS = ['usd', 'gel'] as const;
export const FLOOR_OPTIONS = ['not-first', 'not-last', 'middle'] as const;
export const POSTER_OPTIONS = ['business', 'other'] as const;
export const UPDATED_OPTIONS = ['1', '3', '7', '30'] as const;
export const METRO_MINUTE_OPTIONS = ['5', '10', '15', '20'] as const;
/** `all` lists every listing; the default folds look-alikes into one row (Phase 11D). */
export const VIEW_OPTIONS = ['all'] as const;
export const SORT_OPTIONS = [
  'newest',
  'price-asc',
  'price-desc',
  'ppm2-asc',
  'area-desc',
  'metro',
] as const;

/** The most places one address may name, so a hand-made address cannot build a huge query. */
export const MAX_PLACES = 12;

/**
 * Tbilisi's two metro lines, each in its order along the line, with the
 * station names of `src/realestate/places/tbilisi.json` (OpenStreetMap; a
 * test holds the two together). Station Square is on both.
 */
export const METRO_STATIONS = [
  ['akhmeteli', 'ახმეტელის თეატრი', 'Akhmeteli Theatre'],
  ['sarajishvili', 'სარაჯიშვილი', 'Sarajishvili'],
  ['guramishvili', 'გურამიშვილი', 'Guramishvili'],
  ['grmagele', 'ღრმაღელე', 'Ghrmaghele'],
  ['didube', 'დიდუბე', 'Didube'],
  ['gotsiridze', 'გოცირიძე', 'Gotsiridze'],
  ['nadzaladevi', 'ნაძალადევი', 'Nadzaladevi'],
  ['station_square', 'სადგურის მოედანი', 'Station Square'],
  ['marjanishvili', 'მარჯანიშვილი', 'Marjanishvili'],
  ['rustaveli', 'რუსთაველი', 'Rustaveli'],
  ['tavisuplebis_moedani', 'თავისუფლების მოედანი', 'Liberty Square'],
  ['avlabari', 'ავლაბარი', 'Avlabari'],
  ['samasi_aragveli', '300 არაგველი', '300 Aragveli'],
  ['isani', 'ისანი', 'Isani'],
  ['samgori', 'სამგორი', 'Samgori'],
  ['varketili', 'ვარკეთილი', 'Varketili'],
  ['tsereteli', 'წერეთელი', 'Tsereteli'],
  ['tech_uni', 'ტექნიკური უნივერსიტეტი', 'Technical University'],
  ['medical_uni', 'სამედიცინო უნივერსიტეტი', 'Medical University'],
  ['delisi', 'დელისი', 'Delisi'],
  ['vazha_pshavela', 'ვაჟა-ფშაველა', 'Vazha-Pshavela'],
  ['state_uni', 'სახელმწიფო უნივერსიტეტი', 'State University'],
].map(([code, ka, en]) => ({ code: code as string, ka: ka as string, en: en as string }));

export const METRO_LINES = [
  {
    line: 1,
    name: 'Line 1 · Akhmeteli–Varketili',
    codes: METRO_STATIONS.slice(0, 16).map((station) => station.code),
  },
  {
    line: 2,
    name: 'Line 2 · Saburtalo',
    codes: ['station_square', ...METRO_STATIONS.slice(16).map((station) => station.code)],
  },
] as const;

export const METRO_CODES: readonly string[] = METRO_STATIONS.map((station) => station.code);

/** The line a station is drawn in: Station Square takes line 1's colour, as the map does. */
export function stationLine(code: string): 1 | 2 {
  return METRO_LINES[0].codes.includes(code) ? 1 : 2;
}

/**
 * The places the Where box names, `level:ref`, as `realestate.public_places`
 * (C6) knows them. Metro stations go through `ms` instead, with a walking time.
 */
export const PLACE_LEVELS = [
  'city',
  'municipality',
  'district',
  'subdistrict',
  'neighbourhood',
  'official_district',
  'street',
] as const;
export type FormPlaceLevel = (typeof PLACE_LEVELS)[number];

export interface RealEstateForm {
  deal: string;
  kind: string;
  /** Commercial space types (ss.ge codes), only with the kind `commercial`. */
  ct: string[];
  /** Land types (ss.ge codes), only with the kind `land`. */
  lt: string[];
  /** Places, `level:ref`: any of them. */
  pl: string[];
  /** Near the metro: at most this many minutes' walk (`METRO_MINUTE_OPTIONS`). */
  mm: string;
  /** Near any of these stations (codes); with no `mm`, within 20 minutes. */
  ms: string[];
  /** `1` hides listings whose location contradicts itself. */
  unc: string;
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
  fmin: string;
  fmax: string;
  ymin: string;
  ymax: string;
  kmin: string;
  kmax: string;
  st: string[];
  cond: string[];
  proj: string[];
  ftype: string[];
  /** `1` to `4`, `5+` for five or more, `0` for none; bathrooms the same. */
  bal: string[];
  bath: string[];
  /** `LISTING_TYPES`: every one ticked. */
  ptype: string[];
  /** Amenities, and a flat's "other information", which are amenity keys too: every one ticked. */
  am: string[];
  by: string;
  since: string;
  /** Words looked for in the listing: its address, title and description. */
  q: string;
  sort: string;
  /** `''` (grouped) or `all`. */
  view: string;
  /** One look-alike group's key, which lists its members. */
  group: string;
}

export function emptyForm(): RealEstateForm {
  return {
    deal: DEFAULT_DEAL,
    kind: '',
    ct: [],
    lt: [],
    pl: [],
    mm: '',
    ms: [],
    unc: '',
    cur: 'usd',
    pm2: '',
    pmin: '',
    pmax: '',
    amin: '',
    amax: '',
    rooms: [],
    floor: '',
    fmin: '',
    fmax: '',
    ymin: '',
    ymax: '',
    kmin: '',
    kmax: '',
    st: [],
    cond: [],
    proj: [],
    ftype: [],
    bal: [],
    bath: [],
    ptype: [],
    am: [],
    by: '',
    since: '',
    q: '',
    sort: 'newest',
    view: '',
    group: '',
  };
}

const kindIs =
  (...kinds: string[]) =>
  (kind: string) =>
    kinds.includes(kind);

/**
 * Which kinds each filter means something for, as the mockup has it. A floor
 * is stated on 97.5% of flats and 1.4% of commercial spaces, almost never for
 * a house, a plot or a hotel (2026-11-14), so Floor is offered for those two
 * (and with no kind). The "every one" lists, the deal, the places, the metro,
 * the price and the area hold for every kind.
 */
export const APPLIES = {
  ct: kindIs('commercial'),
  lt: kindIs('land'),
  rooms: kindIs('', 'flat', 'house', 'cottage', 'hotel'),
  floor: kindIs('', 'flat', 'commercial'),
  yard: kindIs('house', 'cottage'),
  kitchen: kindIs('flat'),
  bath: kindIs('flat'),
  bal: kindIs('flat'),
  ftype: kindIs('flat'),
  proj: kindIs('flat'),
  st: (kind: string) => kind !== 'land',
  cond: (kind: string) => kind !== 'land',
  am: (kind: string) => kind !== '',
  other: kindIs('flat'),
} as const;

/** The amenities the chosen kind and deal offer; a flat's "other information" are amenity keys too. */
export function offeredAmenities(kind: string, deal: string): string[] {
  if (!(PROPERTY_TYPES as readonly string[]).includes(kind)) return [];
  const dealType = deal === 'all' || deal === '' ? undefined : (deal as DealType);
  return [
    ...amenitiesFor(kind as PropertyType, dealType),
    ...(APPLIES.other(kind) ? OTHER_INFO : []),
  ];
}

/**
 * The form with every value its kind does not offer dropped, so nothing
 * hidden keeps narrowing: the bar and the sheet call this after a change of
 * kind or deal, and the server after reading an address.
 */
export function applicable(form: RealEstateForm): RealEstateForm {
  const { kind } = form;
  const keep = <T>(applies: boolean, value: T, empty: T): T => (applies ? value : empty);
  const offered = offeredAmenities(kind, form.deal);
  // Lists in their own order, so one choice has one address.
  const known = (applies: boolean, chosen: string[], options: readonly string[]) =>
    applies ? options.filter((option) => chosen.includes(option)) : [];
  return {
    ...form,
    ct: known(APPLIES.ct(kind), form.ct, Object.keys(COMMERCIAL_TYPE_CODES)),
    lt: known(APPLIES.lt(kind), form.lt, Object.keys(LAND_TYPE_CODES)),
    rooms: keep(APPLIES.rooms(kind), form.rooms, []),
    floor: keep(APPLIES.floor(kind), form.floor, ''),
    fmin: keep(APPLIES.floor(kind), form.fmin, ''),
    fmax: keep(APPLIES.floor(kind), form.fmax, ''),
    ymin: keep(APPLIES.yard(kind), form.ymin, ''),
    ymax: keep(APPLIES.yard(kind), form.ymax, ''),
    kmin: keep(APPLIES.kitchen(kind), form.kmin, ''),
    kmax: keep(APPLIES.kitchen(kind), form.kmax, ''),
    bath: keep(APPLIES.bath(kind), form.bath, []),
    bal: keep(APPLIES.bal(kind), form.bal, []),
    ftype: keep(APPLIES.ftype(kind), form.ftype, []),
    proj: keep(APPLIES.proj(kind), form.proj, []),
    st: keep(APPLIES.st(kind), form.st, []),
    cond: keep(APPLIES.cond(kind), form.cond, []),
    am: offered.filter((key) => form.am.includes(key)),
  };
}

/** The defaults stay out of the address, so the bare page has a bare address. */
const DEFAULTS: Partial<Record<keyof RealEstateForm, string>> = {
  deal: DEFAULT_DEAL,
  cur: 'usd',
  sort: 'newest',
};

/** The rows one page holds at first; "show more" adds as many again. */
export const REAL_ESTATE_CHUNK = 100;

/** The address's query, in the form's own key order. `show` past the first chunk is kept. */
export function formSearch(form: RealEstateForm, show = 0): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form) as [keyof RealEstateForm, string | string[]][]) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
      continue;
    }
    if (value === '' || DEFAULTS[key] === value) continue;
    params.set(key, value);
  }
  if (show > REAL_ESTATE_CHUNK) params.set('show', String(show));
  return params.toString();
}

export function formHref(form: RealEstateForm, show = 0): string {
  const search = formSearch(form, show);
  return search === '' ? '/real-estate' : `/real-estate?${search}`;
}

/** Whether anything narrows the list beyond the deal: decides what an empty result says. */
export function isFormFiltered(form: RealEstateForm): boolean {
  const { deal: _deal, cur: _cur, pm2: _pm2, sort: _sort, view: _view, ...narrowing } = form;
  return Object.values(narrowing).some((value) => value.length > 0);
}
