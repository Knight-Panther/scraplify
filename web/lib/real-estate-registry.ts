import { CONDITIONS, PROJECTS } from '../../src/realestate/kinds.js';
import {
  APPLIES,
  emptyForm,
  METRO_STATIONS,
  offeredAmenities,
  type RealEstateForm,
} from './real-estate-form.js';
import {
  AMENITY_LABELS,
  BUILDING_STATUS_LABELS,
  CONDITION_LABELS,
  FLOOR_TYPE_LABELS,
  LISTING_TYPE_LABELS,
  OTHER_INFO,
  PROJECT_LABELS,
} from './real-estate-panels.js';
import { COMMERCIAL_TYPE_LABELS, KIND_LABELS, LAND_TYPE_LABELS } from './real-estate-row.js';

/**
 * Every filter of the Real estate tab, once (Phase 16B, after the approved
 * mockup's registry): which group of "All filters" it sits in, which kinds it
 * means something for, whether it is set, how to clear it, and what it says
 * when set. The pills, the sheet, the chips above the results and the empty
 * state are all drawn from this list, so they never disagree.
 *
 * No server import: the filter bar reads it in the browser too.
 */

export const FILTER_GROUPS = [
  'Type',
  'Location',
  'Price',
  'Size and layout',
  'Building',
  'Features',
  'Listing',
] as const;
export type FilterGroup = (typeof FILTER_GROUPS)[number];

export type FilterKey =
  | 'deal'
  | 'kind'
  | 'ctype'
  | 'ltype'
  | 'where'
  | 'metro'
  | 'uncertain'
  | 'price'
  | 'rooms'
  | 'area'
  | 'yard'
  | 'kitchen'
  | 'floor'
  | 'bath'
  | 'bal'
  | 'ftype'
  | 'status'
  | 'cond'
  | 'proj'
  | 'am'
  | 'other'
  | 'ptype'
  | 'by'
  | 'since';

/** What a filter's summary may need beyond the form: the names of the places it holds. */
export interface SummaryContext {
  /** `level:ref` to the place's Georgian name. */
  placeNames: ReadonlyMap<string, string>;
}

export interface FilterDef {
  key: FilterKey;
  group: FilterGroup;
  title: (form: RealEstateForm) => string;
  /** A pill's shorter name, where the title is long. */
  short?: string;
  applies: (form: RealEstateForm) => boolean;
  active: (form: RealEstateForm) => boolean;
  clear: (form: RealEstateForm) => RealEstateForm;
  summary: (form: RealEstateForm, context: SummaryContext) => string;
  /** Read from the listing's own page, so it judges only listings whose page was read. */
  detail?: boolean;
  /** Shown by its own control (the deal switch, the kind button, the Where box), never as a chip. */
  noChip?: boolean;
}

const always = () => true;
const nf = new Intl.NumberFormat('en-US');
export const fmt = (n: number): string => nf.format(Math.round(n));

/** `120k`, `1.2M`: short enough for a pill. */
export function shortMoney(value: number, currency: string): string {
  const sign = currency === 'gel' ? '₾' : '$';
  if (value >= 1e6)
    return `${sign}${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (value >= 1e4) return `${sign}${Math.round(value / 1e3)}k`;
  return `${sign}${fmt(value)}`;
}

/** "50–80 m²", "up to 50 m²", "120 m² and more". */
export function rangeText(min: string, max: string, unit: string): string {
  if (min === '') return `up to ${fmt(Number(max))}${unit}`;
  if (max === '') return `${fmt(Number(min))}${unit} and more`;
  return `${fmt(Number(min))}–${fmt(Number(max))}${unit}`;
}

export function priceText(min: string, max: string, currency: string, perM2: boolean): string {
  const tail = perM2 ? '/m²' : '';
  if (min === '') return `up to ${shortMoney(Number(max), currency)}${tail}`;
  if (max === '') return `${shortMoney(Number(min), currency)}${tail}+`;
  return `${shortMoney(Number(min), currency)}–${shortMoney(Number(max), currency)}${tail}`;
}

const listOf = (values: readonly string[], labels: Readonly<Record<string, string>>) =>
  values.map((value) => labels[value] ?? value).join(', ');

const countText = (values: readonly string[]) =>
  values.map((value) => (value === '0' ? 'none' : value)).join(', ');

export const FLOOR_RULE_LABELS: Readonly<Record<string, string>> = {
  'not-first': 'Not the first',
  'not-last': 'Not the last',
  middle: 'Neither first nor last',
};
export const POSTER_LABELS: Readonly<Record<string, string>> = {
  other: 'Not marked as a business',
  business: 'Agency or developer',
};
export const UPDATED_LABELS: Readonly<Record<string, string>> = {
  '1': 'Last 24 hours',
  '3': 'Last 3 days',
  '7': 'Last 7 days',
  '30': 'Last 30 days',
};
export const KIND_NAMES: Readonly<Record<string, string>> = KIND_LABELS;
export const DEAL_NAMES: Readonly<Record<string, string>> = {
  sale: 'Buy',
  rent: 'Rent',
  daily: 'Daily',
  pledge: 'Pledge',
  all: 'All',
};
/** What the price means under each deal, for the price panel's heading. */
export const PRICE_UNIT: Readonly<Record<string, string>> = {
  sale: '',
  rent: ' a month',
  daily: ' a night',
  pledge: '',
  all: '',
};

const isHouse = (form: RealEstateForm) => form.kind === 'house' || form.kind === 'cottage';
const amenityKeys = (form: RealEstateForm) =>
  form.am.filter((key) => !OTHER_INFO.includes(key as never));
const otherKeys = (form: RealEstateForm) =>
  form.am.filter((key) => OTHER_INFO.includes(key as never));
const STATION_NAMES = new Map(METRO_STATIONS.map((station) => [station.code, station]));

const range = (min: keyof RealEstateForm, max: keyof RealEstateForm, unit: string) => ({
  active: (form: RealEstateForm) => form[min] !== '' || form[max] !== '',
  clear: (form: RealEstateForm) => ({ ...form, [min]: '', [max]: '' }),
  summary: (form: RealEstateForm) => rangeText(form[min] as string, form[max] as string, unit),
});

const list = (
  key: 'ct' | 'lt' | 'rooms' | 'bath' | 'bal' | 'ftype' | 'st' | 'cond' | 'proj' | 'ptype',
) => ({
  active: (form: RealEstateForm) => form[key].length > 0,
  clear: (form: RealEstateForm) => ({ ...form, [key]: [] }),
});

const single = (key: 'by' | 'since', labels: Readonly<Record<string, string>>) => ({
  active: (form: RealEstateForm) => form[key] !== '',
  clear: (form: RealEstateForm) => ({ ...form, [key]: '' }),
  summary: (form: RealEstateForm) => (labels[form[key]] ?? '').toLowerCase(),
});

export const FILTERS: readonly FilterDef[] = [
  {
    key: 'deal',
    group: 'Type',
    title: () => 'Deal',
    applies: always,
    active: (form) => form.deal !== 'sale',
    clear: (form) => ({ ...form, deal: 'sale' }),
    summary: (form) => DEAL_NAMES[form.deal] ?? '',
    noChip: true,
  },
  {
    key: 'kind',
    group: 'Type',
    title: () => 'Kind',
    applies: always,
    active: (form) => form.kind !== '',
    clear: (form) => ({ ...form, kind: '' }),
    summary: (form) => KIND_NAMES[form.kind] ?? '',
    noChip: true,
  },
  {
    key: 'ctype',
    group: 'Type',
    title: () => 'Space type',
    applies: (form) => APPLIES.ct(form.kind),
    ...list('ct'),
    summary: (form) => listOf(form.ct, COMMERCIAL_TYPE_LABELS),
  },
  {
    key: 'ltype',
    group: 'Type',
    title: () => 'Land type',
    applies: (form) => APPLIES.lt(form.kind),
    ...list('lt'),
    summary: (form) => listOf(form.lt, LAND_TYPE_LABELS),
  },
  {
    key: 'where',
    group: 'Location',
    title: () => 'Where',
    applies: always,
    active: (form) => form.pl.length > 0 || form.q !== '',
    clear: (form) => ({ ...form, pl: [], q: '' }),
    summary: (form, { placeNames }) =>
      [...form.pl.map((value) => placeNames.get(value) ?? ''), form.q].filter(Boolean).join(', '),
    noChip: true,
  },
  {
    key: 'metro',
    group: 'Location',
    title: () => 'Near the metro',
    short: 'Metro',
    applies: always,
    active: (form) => form.mm !== '' || form.ms.length > 0,
    clear: (form) => ({ ...form, mm: '', ms: [] }),
    summary: (form) => {
      const time = `≤ ${form.mm === '' ? '20' : form.mm} min`;
      if (form.ms.length === 0) return `${time}, any station`;
      if (form.ms.length === 1)
        return `${time} of ${STATION_NAMES.get(form.ms[0] as string)?.en ?? ''}`;
      return `${time} of ${form.ms.length} stations`;
    },
  },
  {
    key: 'uncertain',
    group: 'Location',
    title: () => 'Location quality',
    applies: always,
    active: (form) => form.unc === '1',
    clear: (form) => ({ ...form, unc: '' }),
    summary: () => 'doubtful locations hidden',
  },
  {
    key: 'price',
    group: 'Price',
    title: (form) => `Price${PRICE_UNIT[form.deal] ?? ''}`,
    short: 'Price',
    applies: always,
    active: (form) => form.pmin !== '' || form.pmax !== '',
    clear: (form) => ({ ...form, pmin: '', pmax: '' }),
    summary: (form) => priceText(form.pmin, form.pmax, form.cur, form.pm2 === '1'),
  },
  {
    key: 'rooms',
    group: 'Size and layout',
    title: () => 'Rooms',
    applies: (form) => APPLIES.rooms(form.kind),
    ...list('rooms'),
    summary: (form) => form.rooms.join(', '),
  },
  {
    key: 'area',
    group: 'Size and layout',
    // A house's area on ss.ge is its house area (real-estate-params.ts).
    title: (form) => (isHouse(form) ? 'House area' : 'Area'),
    applies: always,
    ...range('amin', 'amax', ' m²'),
  },
  {
    key: 'yard',
    group: 'Size and layout',
    title: () => 'Yard area',
    applies: (form) => APPLIES.yard(form.kind),
    ...range('ymin', 'ymax', ' m²'),
    detail: true,
  },
  {
    key: 'kitchen',
    group: 'Size and layout',
    title: () => 'Kitchen area',
    applies: (form) => APPLIES.kitchen(form.kind),
    ...range('kmin', 'kmax', ' m²'),
    detail: true,
  },
  {
    key: 'floor',
    group: 'Size and layout',
    title: () => 'Floor',
    applies: (form) => APPLIES.floor(form.kind),
    active: (form) => form.floor !== '' || form.fmin !== '' || form.fmax !== '',
    clear: (form) => ({ ...form, floor: '', fmin: '', fmax: '' }),
    summary: (form) =>
      [
        form.floor === '' ? null : (FLOOR_RULE_LABELS[form.floor] ?? '').toLowerCase(),
        form.fmin === '' && form.fmax === '' ? null : rangeText(form.fmin, form.fmax, ''),
      ]
        .filter(Boolean)
        .join(', '),
  },
  {
    key: 'bath',
    group: 'Size and layout',
    title: () => 'Bathrooms',
    applies: (form) => APPLIES.bath(form.kind),
    ...list('bath'),
    summary: (form) => countText(form.bath),
    detail: true,
  },
  {
    key: 'bal',
    group: 'Size and layout',
    title: () => 'Balconies',
    applies: (form) => APPLIES.bal(form.kind),
    ...list('bal'),
    summary: (form) => countText(form.bal),
    detail: true,
  },
  {
    key: 'ftype',
    group: 'Size and layout',
    title: () => 'Floor type',
    applies: (form) => APPLIES.ftype(form.kind),
    ...list('ftype'),
    summary: (form) => listOf(form.ftype, FLOOR_TYPE_LABELS),
    detail: true,
  },
  {
    key: 'status',
    group: 'Building',
    title: () => 'Status',
    applies: (form) => APPLIES.st(form.kind),
    ...list('st'),
    summary: (form) => listOf(form.st, BUILDING_STATUS_LABELS),
    detail: true,
  },
  {
    key: 'cond',
    group: 'Building',
    title: () => 'Condition',
    applies: (form) => APPLIES.cond(form.kind),
    ...list('cond'),
    summary: (form) => listOf(form.cond, CONDITION_LABELS),
    detail: true,
  },
  {
    key: 'proj',
    group: 'Building',
    title: () => 'Project',
    applies: (form) => APPLIES.proj(form.kind),
    ...list('proj'),
    summary: (form) => listOf(form.proj, PROJECT_LABELS),
    detail: true,
  },
  {
    key: 'am',
    group: 'Features',
    title: () => 'Amenities',
    applies: (form) => APPLIES.am(form.kind),
    active: (form) => amenityKeys(form).length > 0,
    clear: (form) => ({ ...form, am: otherKeys(form) }),
    summary: (form) => listOf(amenityKeys(form), AMENITY_LABELS),
    detail: true,
  },
  {
    key: 'other',
    group: 'Features',
    title: () => 'Other information',
    applies: (form) => APPLIES.other(form.kind),
    active: (form) => otherKeys(form).length > 0,
    clear: (form) => ({ ...form, am: amenityKeys(form) }),
    summary: (form) => listOf(otherKeys(form), AMENITY_LABELS),
    detail: true,
  },
  {
    key: 'ptype',
    group: 'Listing',
    title: () => 'Listing type',
    applies: always,
    ...list('ptype'),
    summary: (form) => listOf(form.ptype, LISTING_TYPE_LABELS),
  },
  {
    key: 'by',
    group: 'Listing',
    title: () => 'Posted by',
    applies: always,
    ...single('by', POSTER_LABELS),
  },
  {
    key: 'since',
    group: 'Listing',
    title: () => 'Updated',
    applies: always,
    ...single('since', UPDATED_LABELS),
  },
];

export const FILTER: Readonly<Record<FilterKey, FilterDef>> = Object.fromEntries(
  FILTERS.map((filter) => [filter.key, filter]),
) as Record<FilterKey, FilterDef>;

/** Set, offered for the form's kind, and shown as a chip above the results. */
export function chipFilters(form: RealEstateForm): FilterDef[] {
  return FILTERS.filter((filter) => !filter.noChip && filter.applies(form) && filter.active(form));
}

/** The filters on a listing's own page that are set: the page then says how many listings it could judge. */
export function detailFiltersOn(form: RealEstateForm): FilterDef[] {
  return FILTERS.filter(
    (filter) =>
      (filter.detail === true || (filter.key === 'ptype' && form.ptype.includes('owner'))) &&
      filter.applies(form) &&
      filter.active(form),
  );
}

/** The pills under the search, by kind: what people narrow by first for that kind (plan 16B). */
export const PROMOTED: Readonly<Record<string, readonly FilterKey[]>> = {
  '': ['price', 'rooms', 'metro', 'area'],
  flat: ['price', 'rooms', 'metro', 'area', 'floor'],
  house: ['price', 'rooms', 'metro', 'area', 'yard'],
  cottage: ['price', 'rooms', 'area', 'yard'],
  commercial: ['price', 'ctype', 'metro', 'area'],
  land: ['price', 'ltype', 'area'],
  hotel: ['price', 'rooms', 'area', 'metro'],
};

/** The quick ranges under an area's two boxes, by kind: a plot is measured in hundreds of m². */
export function areaPresets(form: RealEstateForm): readonly (readonly [string, string])[] {
  switch (form.kind) {
    case 'house':
    case 'cottage':
      return [
        ['', '100'],
        ['100', '200'],
        ['200', '350'],
        ['350', ''],
      ];
    case 'land':
      return [
        ['', '600'],
        ['600', '1000'],
        ['1000', '5000'],
        ['5000', ''],
      ];
    case 'commercial':
      return [
        ['', '50'],
        ['50', '150'],
        ['150', '500'],
        ['500', ''],
      ];
    case 'hotel':
      return [
        ['', '300'],
        ['300', '600'],
        ['600', '1500'],
        ['1500', ''],
      ];
    default:
      return [
        ['', '50'],
        ['50', '80'],
        ['80', '120'],
        ['120', ''],
      ];
  }
}

export const YARD_PRESETS = [
  ['', '200'],
  ['200', '600'],
  ['600', '1500'],
  ['1500', ''],
] as const;
export const KITCHEN_PRESETS = [
  ['', '8'],
  ['8', '12'],
  ['12', '18'],
  ['18', ''],
] as const;

/** Quick price ranges, in dollars, by deal; per m² only where the mockup has them. */
export function pricePresets(
  deal: string,
  perM2: boolean,
): readonly (readonly [number | null, number | null])[] {
  if (perM2) {
    if (deal === 'sale')
      return [
        [null, 1000],
        [1000, 1500],
        [1500, 2000],
        [2000, null],
      ];
    if (deal === 'rent')
      return [
        [null, 8],
        [8, 12],
        [12, 18],
        [18, null],
      ];
    return [];
  }
  switch (deal) {
    case 'sale':
      return [
        [null, 70000],
        [70000, 100000],
        [100000, 150000],
        [150000, 250000],
        [250000, null],
      ];
    case 'rent':
      return [
        [null, 500],
        [500, 800],
        [800, 1200],
        [1200, 2000],
        [2000, null],
      ];
    case 'daily':
      return [
        [null, 30],
        [30, 60],
        [60, 150],
        [150, null],
      ];
    case 'pledge':
      return [
        [null, 15000],
        [15000, 30000],
        [30000, null],
      ];
    default:
      return [];
  }
}

/** The form with everything but the deal, the kind, the order and the grouping cleared ("Clear all"). */
export function clearAll(form: RealEstateForm): RealEstateForm {
  return { ...emptyForm(), deal: form.deal, kind: form.kind, sort: form.sort, view: form.view };
}

/** The choices of each list filter, `[value, label]`, in the order shown. */
export function optionsOf(
  key: FilterKey,
  form: RealEstateForm,
): readonly (readonly [string, string])[] {
  const entries = (labels: Readonly<Record<string, string>>) =>
    Object.entries(labels).map(([value, label]) => [value, label] as const);
  switch (key) {
    case 'ctype':
      return [31, 22, 7, 6, 13, 14, 21].map(
        (code) => [String(code), COMMERCIAL_TYPE_LABELS[code] ?? ''] as const,
      );
    case 'ltype':
      return [2, 1, 3, 5, 4, 6].map(
        (code) => [String(code), LAND_TYPE_LABELS[code] ?? ''] as const,
      );
    case 'rooms':
      return ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10+'].map(
        (value) => [value, value] as const,
      );
    case 'bath':
    case 'bal':
      return ['1', '2', '3', '4', '5+', '0'].map(
        (value) => [value, value === '0' ? 'None' : value] as const,
      );
    case 'ftype':
      return entries(FLOOR_TYPE_LABELS);
    case 'status':
      return [
        ['new', BUILDING_STATUS_LABELS.new],
        ['under-construction', BUILDING_STATUS_LABELS['under-construction']],
        ['old', BUILDING_STATUS_LABELS.old],
      ];
    case 'cond':
      return Object.values(CONDITIONS).map((value) => [value, CONDITION_LABELS[value]] as const);
    case 'proj':
      return Object.values(PROJECTS).map((value) => [value, PROJECT_LABELS[value]] as const);
    case 'am':
      return offeredAmenities(form.kind, form.deal)
        .filter((value) => !OTHER_INFO.includes(value as never))
        .map((value) => [value, AMENITY_LABELS[value as keyof typeof AMENITY_LABELS]] as const);
    case 'other':
      return OTHER_INFO.map((value) => [value, AMENITY_LABELS[value]] as const);
    case 'ptype':
      return [
        ['owner', LISTING_TYPE_LABELS.owner],
        ['developer', LISTING_TYPE_LABELS.developer],
        ['photos', LISTING_TYPE_LABELS.photos],
        ['exclusive', LISTING_TYPE_LABELS.exclusive],
      ];
    case 'by':
      return [['', 'Anyone'], ...entries(POSTER_LABELS)];
    case 'since':
      return [['', 'Any time'], ...entries(UPDATED_LABELS)];
    default:
      return [];
  }
}
