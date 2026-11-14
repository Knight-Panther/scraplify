import { and, arrayContains, eq, inArray, type SQL, sql } from 'drizzle-orm';
import {
  realEstatePublicPlaces as catalogue,
  realEstatePublicListings as listings,
} from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import {
  BALCONIES_TOP,
  BATHROOMS_TOP,
  conditions,
  implausibleValues,
  isGrouped,
  nearMetro,
  priceColumn,
  type RealEstateFilters,
  ROOMS_TOP,
} from './filters.js';
import { AMENITY_FIELDS } from './kinds.js';

// The place box's types, for a caller that reads both from here (types only: no import cycle).
export type {
  PlaceLabel,
  PlaceSuggestion,
  PlaceSuggestions,
  SuggestGroup,
} from './place-suggest.js';

/**
 * The option counts the Real estate filter panels show (Phase 16B): for each
 * option, how many listings picking it would show, given every other filter.
 * So a facet is counted over the filters without its own (the exception: the
 * "every one ticked" lists, `amenities` and `listingType`, whose options add
 * to what is ticked). Built on `conditions`, so what matches is the tab's own
 * rule, never a second copy.
 */

export const FACET_KEYS = [
  'kind',
  'commercialType',
  'landType',
  'rooms',
  'bathrooms',
  'balconies',
  'buildingStatus',
  'condition',
  'project',
  'floorType',
  'amenities',
  'listingType',
  'metroStations',
  'price',
  'uncertain',
  'metroCoverage',
] as const;
export type FacetKey = (typeof FACET_KEYS)[number];

export type FacetResult =
  /** Option value, as the address writes it, to its count. */
  | { type: 'counts'; counts: Record<string, number> }
  /** `edges.length === counts.length + 1`; both empty when there are too few prices. */
  | { type: 'histogram'; edges: number[]; counts: number[] }
  | { type: 'uncertain'; count: number }
  | { type: 'metroCoverage'; total: number; unknown: number; outside: number };

/** The price histogram: log-spaced bins between the 2nd and 98th percentile of the prices. */
const PRICE_BINS = 36;
/** Fewer prices than this say nothing about a distribution. */
const PRICE_MIN_ROWS = 5;
/** Tbilisi's name in C6, as `place-lookup.ts` reads it. */
const TBILISI = 'თბილისი';

export function without(
  filters: RealEstateFilters,
  keys: (keyof RealEstateFilters)[],
): RealEstateFilters {
  const rest: RealEstateFilters = { ...filters };
  for (const key of keys) delete rest[key];
  return rest;
}

/**
 * The count of the rows where `match` holds: properties when the tab folds
 * look-alikes (the same unit `countRealEstate` uses), else listings.
 */
export function unit(filters: RealEstateFilters, match: SQL | undefined = undefined): SQL<number> {
  const where = match ?? sql`true`;
  return isGrouped(filters)
    ? sql<number>`(count(*) filter (where ${listings.groupKey} is null and ${where}) + count(distinct ${listings.groupKey}) filter (where ${where}))::int`
    : sql<number>`(count(*) filter (where ${where}))::int`;
}

/** Each distinct value of `key` among the rows `filters` match, with its count. */
async function countsBy(
  db: DatabaseOrTransaction,
  filters: RealEstateFilters,
  now: string,
  key: SQL,
  extra: SQL | undefined = undefined,
): Promise<FacetResult> {
  const rows = await db
    .select({ key: sql<string>`${key}`, total: unit(filters) })
    .from(listings)
    .where(and(conditions(filters, now), sql`${key} is not null`, extra))
    .groupBy(sql`1`);
  return { type: 'counts', counts: Object.fromEntries(rows.map((row) => [row.key, row.total])) };
}

/** One scan counting each named condition among the rows `filters` match. */
async function countsEach(
  db: DatabaseOrTransaction,
  filters: RealEstateFilters,
  now: string,
  options: readonly (readonly [string, SQL | undefined])[],
): Promise<FacetResult> {
  if (options.length === 0) return { type: 'counts', counts: {} };
  const fields = Object.fromEntries(
    options.map(([, match], at) => [`c${at}`, unit(filters, match)]),
  );
  const [row] = await db.select(fields).from(listings).where(conditions(filters, now));
  return {
    type: 'counts',
    counts: Object.fromEntries(options.map(([value], at) => [value, Number(row?.[`c${at}`] ?? 0)])),
  };
}

/** A count column as the address writes it: the last choice is "that many or more". */
const topped = (column: SQL, top: number) =>
  sql`case when ${column} >= ${sql.raw(String(top))} then ${sql.raw(`'${top}+'`)} else ${column}::text end`;

/** A listing in Tbilisi, by C6's city of that name; false when its city is unknown. */
const inTbilisi = (db: DatabaseOrTransaction) =>
  sql`coalesce(${inArray(
    listings.cityRef,
    db
      .select({ ref: catalogue.ref })
      .from(catalogue)
      .where(and(eq(catalogue.level, 'city'), eq(catalogue.nameKa, TBILISI))),
  )}, false)`;

async function priceHistogram(
  db: DatabaseOrTransaction,
  filters: RealEstateFilters,
  now: string,
): Promise<FacetResult> {
  const base = without(filters, ['priceMin', 'priceMax']);
  const price = sql`${priceColumn(filters)}::float8`;
  const where = and(conditions(base, now), sql`${price} > 0`, sql`not ${implausibleValues}`);
  const [range] = await db
    .select({
      total: sql<number>`count(*)::int`,
      low: sql<number | null>`percentile_cont(0.02) within group (order by ${price})`,
      high: sql<number | null>`percentile_cont(0.98) within group (order by ${price})`,
    })
    .from(listings)
    .where(where);
  if (range === undefined || range.total < PRICE_MIN_ROWS || range.low === null) {
    return { type: 'histogram', edges: [], counts: [] };
  }
  let low = Number(range.low);
  let high = Number(range.high);
  // Every price the same: a sliver of a range, so the bins still have edges.
  if (high <= low) {
    low *= 0.98;
    high *= 1.02;
  }
  const logLow = Math.log(low);
  const logHigh = Math.log(high);
  const step = (logHigh - logLow) / PRICE_BINS;
  const edges = Array.from(
    { length: PRICE_BINS + 1 },
    (_, at) => Math.round(Math.exp(logLow + step * at) * 100) / 100,
  );
  // The 2% in each tail goes into the end bins, so the bins add up to the listings.
  const bucket = sql<number>`least(greatest(width_bucket(ln(${price}), ${logLow}::float8, ${logHigh}::float8, ${PRICE_BINS}::int), 1), ${PRICE_BINS}::int)`;
  const rows = await db
    .select({ bucket, total: sql<number>`count(*)::int` })
    .from(listings)
    .where(where)
    .groupBy(sql`1`);
  const counts = new Array<number>(PRICE_BINS).fill(0);
  for (const row of rows) counts[Number(row.bucket) - 1] = row.total;
  return { type: 'histogram', edges, counts };
}

/**
 * How many listings picking each option of one filter panel would show, given
 * every other filter, at the time `now`. See the file's note for the rule;
 * the units are properties when `filters` folds look-alikes, else listings.
 */
export async function facetCounts(
  db: DatabaseOrTransaction,
  filters: RealEstateFilters,
  now: string,
  facet: FacetKey,
): Promise<FacetResult> {
  switch (facet) {
    case 'kind':
      return countsBy(
        db,
        without(filters, ['propertyType', 'commercialTypes', 'landTypes']),
        now,
        sql`${listings.propertyType}`,
      );
    case 'commercialType':
      return countsBy(
        db,
        without(filters, ['commercialTypes']),
        now,
        sql`${listings.commercialType}::text`,
      );
    case 'landType':
      return countsBy(db, without(filters, ['landTypes']), now, sql`${listings.landType}::text`);
    case 'rooms':
      return countsBy(
        db,
        without(filters, ['roomsIn']),
        now,
        topped(sql`${listings.rooms}`, ROOMS_TOP),
        sql`${listings.rooms} >= 1`,
      );
    case 'bathrooms':
      return countsBy(
        db,
        without(filters, ['bathrooms']),
        now,
        topped(sql`${listings.bathrooms}`, BATHROOMS_TOP),
      );
    case 'balconies':
      return countsBy(
        db,
        without(filters, ['balconies']),
        now,
        topped(sql`${listings.balconies}`, BALCONIES_TOP),
      );
    case 'buildingStatus':
      return countsBy(
        db,
        without(filters, ['buildingStatuses']),
        now,
        sql`${listings.buildingStatus}`,
      );
    case 'condition':
      return countsBy(db, without(filters, ['conditions']), now, sql`${listings.condition}`);
    case 'project':
      return countsBy(db, without(filters, ['projects']), now, sql`${listings.project}`);
    case 'floorType':
      return countsBy(db, without(filters, ['floorTypes']), now, sql`${listings.floorType}`);
    case 'amenities':
      // Every one ticked still applies; an option adds to them.
      return countsEach(
        db,
        filters,
        now,
        [...new Set(Object.values(AMENITY_FIELDS))].map(
          (key) => [key, arrayContains(listings.amenities, [key])] as const,
        ),
      );
    case 'listingType':
      // The same tests as `conditions` makes of developerOnly, withPhotos, ownerOnly and exclusiveOnly.
      return countsEach(db, filters, now, [
        ['developer', eq(listings.posterType, 'developer')],
        ['photos', sql`${listings.imageCount} > 0`],
        ['owner', eq(listings.posterEntity, 'individual')],
        ['exclusive', eq(listings.exclusive, true)],
      ]);
    case 'metroStations': {
      const stations = await db
        .selectDistinct({ code: catalogue.code })
        .from(catalogue)
        .where(eq(catalogue.level, 'metro_station'));
      const maxMinutes = filters.metro?.maxMinutes;
      return countsEach(
        db,
        without(filters, ['metro']),
        now,
        stations
          .flatMap((station) => (station.code === null ? [] : [station.code]))
          .map(
            (code) =>
              [
                code,
                nearMetro(
                  maxMinutes === undefined
                    ? { stations: [code] }
                    : { maxMinutes, stations: [code] },
                ),
              ] as const,
          ),
      );
    }
    case 'price':
      return priceHistogram(db, filters, now);
    case 'uncertain': {
      const base = without(filters, ['excludeUncertain']);
      const [row] = await db
        .select({ count: unit(base, sql`${listings.locationUncertain}`) })
        .from(listings)
        .where(conditions(base, now));
      return { type: 'uncertain', count: row?.count ?? 0 };
    }
    case 'metroCoverage': {
      const base = without(filters, ['metro']);
      const city = inTbilisi(db);
      const [row] = await db
        .select({
          total: unit(base),
          unknown: unit(base, sql`${city} and ${listings.metroBasis} is null`),
          outside: unit(base, sql`not ${city}`),
        })
        .from(listings)
        .where(conditions(base, now));
      return {
        type: 'metroCoverage',
        total: row?.total ?? 0,
        unknown: row?.unknown ?? 0,
        outside: row?.outside ?? 0,
      };
    }
  }
}
