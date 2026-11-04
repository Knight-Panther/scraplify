/**
 * The one list of what a real-estate listing can be: its kind, its deal, and
 * the sub-types ss.ge marks on its results rows. The database enums, the
 * parser, the crawl's lists, the queries and the tab all read these, so a
 * kind or deal is added in one place.
 *
 * Order matters for the enums: Postgres can only append a value, so the kinds
 * and deals stored before Phase 12 stay first, in their original order.
 */

export const PROPERTY_TYPES = ['flat', 'house', 'cottage', 'commercial', 'land', 'hotel'] as const;
/** `daily` is rent by the night; `pledge` is ss.ge's გირავდება. */
export const DEAL_TYPES = ['sale', 'rent', 'daily', 'pledge'] as const;

export type PropertyType = (typeof PROPERTY_TYPES)[number];
export type DealType = (typeof DEAL_TYPES)[number];

/**
 * ss.ge's `commercialRealEstateType` codes, stored as the number (like a
 * location ref) so a code added later is kept rather than dropped. 0 means
 * none and is never stored.
 */
export const COMMERCIAL_TYPE_CODES: Readonly<Record<number, string>> = {
  6: 'warehouse',
  7: 'office',
  13: 'catering',
  14: 'garage',
  21: 'basement',
  22: 'retail',
  31: 'commercial-space',
};

/** ss.ge's `landType` codes, stored as the number for the same reason. */
export const LAND_TYPE_CODES: Readonly<Record<number, string>> = {
  1: 'agricultural',
  2: 'non-agricultural',
  3: 'commercial',
  4: 'special',
  5: 'investment',
  6: 'farm',
};

/*
 * What a listing's own page says (Phase 12B), as keys of our own. ss.ge
 * writes these as Georgian text; each map turns its wording into a key, and
 * text it does not hold is read as unknown, never guessed. The labels are
 * the filter panels' own, read on 2026-11-03.
 */

/** Building status (`realEstateStatus` text). */
export const BUILDING_STATUSES = {
  'ახალი აშენებული': 'new',
  მშენებარე: 'under-construction',
  'ძველი აშენებული': 'old',
} as const satisfies Record<string, string>;

/** Condition (`state` text). */
export const CONDITIONS = {
  სარემონტო: 'needs-renovation',
  'მიმდინარე რემონტი': 'under-renovation',
  'ძველი რემონტით': 'old-renovation',
  გარემონტებული: 'renovated',
  'ახალი რემონტით': 'newly-renovated',
  'მწვანე კარკასი': 'green-frame',
  'შავი კარკასი': 'black-frame',
  'თეთრი კარკასი': 'white-frame',
} as const satisfies Record<string, string>;

/** The building's project, the Soviet and later series flats are known by (`project` text). */
export const PROJECTS = {
  არასტანდარტული: 'non-standard',
  ლენინგრადის: 'leningrad',
  ლვოვის: 'lviv',
  კიევი: 'kyiv',
  'თბილისური ეზო': 'tbilisi-yard',
  მოსკოვის: 'moscow',
  ქალაქური: 'city',
  ჩეხური: 'czech',
  ხრუშჩოვის: 'khrushchev',
  თუხარელის: 'tukhareli',
  ვეძისი: 'vedzisi',
  იუგოსლავიის: 'yugoslav',
  მეტრომშენის: 'metromsheni',
  ყავლაშვილის: 'kavlashvili',
} as const satisfies Record<string, string>;

/** Floor type (`floorTypeText`). */
export const FLOOR_TYPES = {
  დუპლექსი: 'duplex',
  ტრიპლექსი: 'triplex',
  სხვენი: 'attic',
} as const satisfies Record<string, string>;

/** Who posted it (`userEntityType`); any other value is unknown. */
export const POSTER_ENTITIES = {
  Individual: 'individual',
  Broker: 'broker',
  Agency: 'agency',
  Developer: 'developer',
} as const satisfies Record<string, string>;

/**
 * ss.ge's yes-or-no fields on a listing's page, and our key for each. Kept
 * only when the page says exactly `true`; the order here is the order stored.
 */
export const AMENITY_FIELDS = {
  airConditioning: 'air-conditioning',
  balcony: 'balcony',
  basement: 'basement',
  cableTelevision: 'cable-tv',
  drinkingWater: 'drinking-water',
  electricity: 'electricity',
  elevator: 'elevator',
  fridge: 'fridge',
  furniture: 'furniture',
  garage: 'garage',
  glazedWindows: 'double-glazing',
  heating: 'central-heating',
  hotWater: 'hot-water',
  internet: 'internet',
  ironDoor: 'iron-door',
  lastFloor: 'top-floor',
  naturalGas: 'natural-gas',
  securityAlarm: 'alarm',
  sewage: 'sewage',
  storage: 'storage',
  telephone: 'telephone',
  tv: 'tv',
  washingMachine: 'washing-machine',
  water: 'water',
  wiFi: 'wifi',
  withPool: 'pool',
  viewOnYard: 'yard-view',
  viewOnStreet: 'street-view',
  light: 'bright',
  comfortable: 'cozy',
  withBuiltInKitchen: 'built-in-kitchen',
  isPetFriendly: 'pets-allowed',
  hasRemoteViewing: 'video-viewing',
} as const satisfies Record<string, string>;

export type BuildingStatus = (typeof BUILDING_STATUSES)[keyof typeof BUILDING_STATUSES];
export type Condition = (typeof CONDITIONS)[keyof typeof CONDITIONS];
export type Project = (typeof PROJECTS)[keyof typeof PROJECTS];
export type FloorType = (typeof FLOOR_TYPES)[keyof typeof FLOOR_TYPES];
export type PosterEntity = (typeof POSTER_ENTITIES)[keyof typeof POSTER_ENTITIES];
export type AmenityKey = (typeof AMENITY_FIELDS)[keyof typeof AMENITY_FIELDS];

/** The key a vocabulary gives a page's text, or null for text it does not hold (never a guess). */
export function vocabularyKey<M extends Record<string, string>>(
  map: M,
  text: unknown,
): M[keyof M] | null {
  if (typeof text !== 'string') return null;
  const key = text.trim();
  return Object.hasOwn(map, key) ? (map[key] as M[keyof M]) : null;
}
