import type {
  AmenityKey,
  BuildingStatus,
  Condition,
  DealType,
  FloorType,
  Project,
  PropertyType,
} from '../../src/realestate/kinds.js';
import { BALCONIES_TOP, BATHROOMS_TOP, ROOMS_TOP } from '../../src/realestate/queries.js';

/**
 * What each kind's "more filters" panel offers, as ss.ge's own "მეტი ფილტრი"
 * did on 2026-11-03 (add.md, "Recon facts"; cottage for rent rechecked
 * 2026-11-04), and the words the page shows for each choice. The address
 * accepts a value only if the applied kind's panel offers it, and the page
 * draws the groups in this order.
 */

export type PanelGroup =
  | 'status'
  | 'area'
  | 'house-area'
  | 'yard-area'
  | 'rooms'
  | 'condition'
  | 'kitchen-area'
  | 'floor'
  | 'floor-type'
  | 'balconies'
  | 'bathrooms'
  | 'project'
  | 'other-info'
  | 'listing-type'
  | 'amenities';

const HOUSE: readonly PanelGroup[] = [
  'status',
  'house-area',
  'yard-area',
  'rooms',
  'condition',
  'listing-type',
  'amenities',
];

export const PANELS: Readonly<Record<PropertyType, readonly PanelGroup[]>> = {
  flat: [
    'status',
    'area',
    'rooms',
    'condition',
    'kitchen-area',
    'floor',
    'floor-type',
    'balconies',
    'bathrooms',
    'project',
    'other-info',
    'listing-type',
    'amenities',
  ],
  house: HOUSE,
  cottage: HOUSE,
  commercial: ['area', 'status', 'condition', 'listing-type', 'amenities'],
  land: ['area', 'listing-type', 'amenities'],
  hotel: ['status', 'area', 'rooms', 'condition', 'listing-type', 'amenities'],
};

const HOUSE_AMENITIES = {
  sale: [
    'central-heating',
    'natural-gas',
    'balcony',
    'garage',
    'storage',
    'basement',
    'drinking-water',
    'furniture',
    'built-in-kitchen',
    'pool',
    'video-viewing',
  ],
  other: [
    'central-heating',
    'natural-gas',
    'balcony',
    'garage',
    'storage',
    'elevator',
    'basement',
    'air-conditioning',
    'cable-tv',
    'drinking-water',
    'fridge',
    'furniture',
    'double-glazing',
    'hot-water',
    'internet',
    'iron-door',
    'alarm',
    'telephone',
    'tv',
    'washing-machine',
    'pool',
    'video-viewing',
    'pets-allowed',
  ],
} as const satisfies { sale: readonly AmenityKey[]; other: readonly AmenityKey[] };

const LAND_AMENITIES = ['natural-gas', 'electricity', 'sewage', 'water', 'video-viewing'] as const;
const HOTEL_AMENITIES = [
  'balcony',
  'air-conditioning',
  'fridge',
  'furniture',
  'built-in-kitchen',
  'hot-water',
  'tv',
  'wifi',
  'video-viewing',
] as const;

/** Amenities ss.ge offers per kind: for sale, and for every other deal (pledge uses the rent panel). */
export const AMENITIES: Readonly<
  Record<
    PropertyType,
    { readonly sale: readonly AmenityKey[]; readonly other: readonly AmenityKey[] }
  >
> = {
  flat: {
    sale: [
      'central-heating',
      'natural-gas',
      'balcony',
      'garage',
      'top-floor',
      'storage',
      'elevator',
      'basement',
      'furniture',
      'built-in-kitchen',
      'video-viewing',
    ],
    other: [
      'central-heating',
      'natural-gas',
      'balcony',
      'garage',
      'storage',
      'elevator',
      'basement',
      'air-conditioning',
      'cable-tv',
      'fridge',
      'furniture',
      'double-glazing',
      'hot-water',
      'internet',
      'iron-door',
      'alarm',
      'telephone',
      'tv',
      'washing-machine',
      'video-viewing',
      'pets-allowed',
    ],
  },
  house: HOUSE_AMENITIES,
  cottage: HOUSE_AMENITIES,
  commercial: {
    sale: [
      'central-heating',
      'natural-gas',
      'balcony',
      'garage',
      'storage',
      'basement',
      'air-conditioning',
      'cable-tv',
      'fridge',
      'furniture',
      'built-in-kitchen',
      'double-glazing',
      'internet',
      'iron-door',
      'alarm',
      'telephone',
      'tv',
      'video-viewing',
    ],
    other: [
      'central-heating',
      'natural-gas',
      'balcony',
      'garage',
      'storage',
      'basement',
      'air-conditioning',
      'cable-tv',
      'fridge',
      'furniture',
      'double-glazing',
      'internet',
      'iron-door',
      'alarm',
      'telephone',
      'tv',
      'video-viewing',
      'pets-allowed',
    ],
  },
  land: { sale: LAND_AMENITIES, other: LAND_AMENITIES },
  hotel: { sale: HOTEL_AMENITIES, other: HOTEL_AMENITIES },
};

/** ss.ge's "other information" on flats: amenity keys, offered as their own group. */
export const OTHER_INFO: readonly AmenityKey[] = ['yard-view', 'street-view', 'bright', 'cozy'];

/**
 * The amenities a kind's panel offers for a deal. With no deal chosen, those
 * of any deal: the deal's own panel order, then what only a sale offers.
 */
export function amenitiesFor(
  kind: PropertyType,
  deal: DealType | undefined,
): readonly AmenityKey[] {
  const { sale, other } = AMENITIES[kind];
  if (deal === 'sale') return sale;
  if (deal !== undefined) return other;
  return [...other, ...sale.filter((key) => !other.includes(key))];
}

export type CountGroup = 'rooms' | 'bathrooms' | 'balconies';

const COUNT_TOPS: Readonly<Record<CountGroup, number>> = {
  rooms: ROOMS_TOP,
  bathrooms: BATHROOMS_TOP,
  balconies: BALCONIES_TOP,
};

/** The chips of each count, in ss.ge's order: the top one means that many or more, 0 is none. */
export const COUNT_CHOICES: Readonly<Record<CountGroup, readonly number[]>> = {
  rooms: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  bathrooms: [1, 2, 3, 4, 5, 0],
  balconies: [1, 2, 3, 4, 5, 0],
};

export function countLabel(group: CountGroup, count: number): string {
  if (count === 0) return 'None';
  const top = COUNT_TOPS[group];
  return count >= top ? `${top}+` : String(count);
}

/** ss.ge's "განცხადების ტიპი", in its order. Developer, photos and exclusive come from results rows. */
export const LISTING_TYPES = ['developer', 'photos', 'owner', 'exclusive'] as const;
export type ListingType = (typeof LISTING_TYPES)[number];

/*
 * Words. ss.ge's own English where it has some; where its English calls two
 * groups "Status" or reads awkwardly ("View on the yard", "Last floor"), plain
 * English instead. Projects drop the word "project": they sit under "Project".
 */

export const GROUP_LABELS: Readonly<Record<PanelGroup, string>> = {
  status: 'Status',
  area: 'Area',
  'house-area': 'House area',
  'yard-area': 'Yard area',
  rooms: 'Rooms',
  condition: 'Condition',
  'kitchen-area': 'Kitchen area',
  floor: 'Floor',
  'floor-type': 'Floor type',
  balconies: 'Balconies',
  bathrooms: 'Bathrooms',
  project: 'Project',
  'other-info': 'Other information',
  'listing-type': 'Listing type',
  amenities: 'Amenities',
};

export const BUILDING_STATUS_LABELS: Readonly<Record<BuildingStatus, string>> = {
  new: 'New building',
  'under-construction': 'Under construction',
  old: 'Old building',
};

export const CONDITION_LABELS: Readonly<Record<Condition, string>> = {
  'needs-renovation': 'Not renovated',
  'under-renovation': 'Under renovation',
  'old-renovation': 'Old renovated',
  renovated: 'Renovated',
  'newly-renovated': 'Newly renovated',
  'green-frame': 'Green frame',
  'black-frame': 'Black frame',
  'white-frame': 'White frame',
};

export const PROJECT_LABELS: Readonly<Record<Project, string>> = {
  'non-standard': 'Non-standard',
  leningrad: 'Leningrad',
  lviv: 'Lviv',
  kyiv: 'Kyiv',
  'tbilisi-yard': 'Tbilisi yard',
  moscow: 'Moscow',
  city: 'Urban',
  czech: 'Czech',
  khrushchev: 'Khrushchev',
  tukhareli: 'Tukhareli',
  vedzisi: 'Vedzisi',
  yugoslav: 'Yugoslav',
  metromsheni: 'Metro construction',
  kavlashvili: 'Kavlashvili',
};

export const FLOOR_TYPE_LABELS: Readonly<Record<FloorType, string>> = {
  duplex: 'Duplex',
  triplex: 'Triplex',
  attic: 'Attic',
};

export const AMENITY_LABELS: Readonly<Record<AmenityKey, string>> = {
  'air-conditioning': 'Air conditioning',
  balcony: 'Balcony',
  basement: 'Basement',
  'cable-tv': 'Cable TV',
  'drinking-water': 'Drinking water',
  electricity: 'Electricity',
  elevator: 'Elevator',
  fridge: 'Fridge',
  furniture: 'Furniture',
  garage: 'Garage',
  'double-glazing': 'Double glazing',
  'central-heating': 'Central heating',
  'hot-water': 'Hot water',
  internet: 'Internet',
  'iron-door': 'Metal door',
  'top-floor': 'Top floor',
  'natural-gas': 'Natural gas',
  alarm: 'Alarm',
  sewage: 'Sewage',
  storage: 'Storage room',
  telephone: 'Telephone',
  tv: 'TV',
  'washing-machine': 'Washing machine',
  water: 'Water',
  wifi: 'Wi-Fi',
  pool: 'Pool',
  'yard-view': 'Yard view',
  'street-view': 'Street view',
  bright: 'Bright',
  cozy: 'Cozy',
  'built-in-kitchen': 'Built-in kitchen',
  'pets-allowed': 'Pet friendly',
  'video-viewing': 'Video call',
};

export const LISTING_TYPE_LABELS: Readonly<Record<ListingType, string>> = {
  developer: 'Developer only',
  photos: 'With photos',
  owner: 'Owner only',
  exclusive: 'Exclusive',
};
