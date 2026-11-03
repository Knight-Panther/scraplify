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
