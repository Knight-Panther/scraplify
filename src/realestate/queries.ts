import { and, asc, desc, eq, gt, gte, inArray, lt, lte, type SQL, sql } from 'drizzle-orm';
import { realEstatePublicListings as listings } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import { listingSearchQuery } from './search.js';

/**
 * What the Real estate tab reads. Everything goes through the
 * `realestate.public_listings` view on every surface: it is all the public
 * database role can see, and it leaves the description out, so no query here
 * can return one.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A listing stays on show this long past the later of its expected end and its last sighting (guideline §9.3). */
export const SHOWN_GRACE_DAYS = 2;
const MAX_LIMIT = 500;
/** Counting stops here; the page says "10,000+" above it. */
export const COUNT_CEILING = 10_000;

export type RealEstateSort = 'newest' | 'price-asc' | 'price-desc' | 'ppm2-asc' | 'area-desc';

export interface RealEstateFilters {
  /** One source's listings only. */
  sourceId?: string;
  dealType?: 'sale' | 'rent';
  propertyType?: 'flat' | 'house' | 'cottage';
  cityRef?: number;
  districtRef?: number;
  subdistrictRef?: number;
  /** The currency the price bounds are in, and the one price sorts use. */
  currency?: 'usd' | 'gel';
  priceMin?: number;
  priceMax?: number;
  areaMin?: number;
  areaMax?: number;
  rooms?: number;
  /** With `rooms`: that many or more. */
  roomsOrMore?: boolean;
  /** `middle` is neither the first floor nor the last. */
  floor?: 'not-first' | 'not-last' | 'middle';
  /** `business` is an agency or a developer; `other` is everything the source does not mark as one. */
  poster?: 'business' | 'other';
  /** Updated on the source at or after this instant. */
  updatedSince?: string;
  text?: string;
  sort?: RealEstateSort;
  limit?: number;
  offset?: number;
}

export interface RealEstateRow {
  id: string;
  canonicalUrl: string;
  dealType: 'sale' | 'rent';
  propertyType: 'flat' | 'house' | 'cottage';
  rooms: number | null;
  bedrooms: number | null;
  areaM2: number | null;
  floor: number | null;
  totalFloors: number | null;
  priceGel: number | null;
  priceUsd: number | null;
  pricePerM2Usd: number | null;
  currencyPosted: 'gel' | 'usd' | null;
  cityName: string | null;
  districtName: string | null;
  subdistrictName: string | null;
  streetName: string | null;
  streetNumber: string | null;
  posterType: 'owner' | 'agent' | 'developer' | 'unknown';
  promoted: boolean;
  sourceUpdatedAt: string;
  firstSeenAt: string;
}

function conditions(filters: RealEstateFilters, now: string): SQL | undefined {
  const shownAfter = new Date(Date.parse(now) - SHOWN_GRACE_DAYS * DAY_MS).toISOString();
  const price = filters.currency === 'gel' ? listings.priceGel : listings.priceUsd;
  const query = filters.text === undefined ? null : listingSearchQuery(filters.text);
  const floor = filters.floor;

  return and(
    // The view holds active listings; this is the part that depends on the time of asking.
    sql`greatest(coalesce(${listings.expectedEndAt}, ${listings.lastSeenAt}), ${listings.lastSeenAt}) > ${shownAfter}`,
    filters.sourceId === undefined ? undefined : eq(listings.sourceId, filters.sourceId),
    filters.dealType === undefined ? undefined : eq(listings.dealType, filters.dealType),
    filters.propertyType === undefined
      ? undefined
      : eq(listings.propertyType, filters.propertyType),
    filters.cityRef === undefined ? undefined : eq(listings.cityRef, filters.cityRef),
    filters.districtRef === undefined ? undefined : eq(listings.districtRef, filters.districtRef),
    filters.subdistrictRef === undefined
      ? undefined
      : eq(listings.subdistrictRef, filters.subdistrictRef),
    // A bound on a missing price or area is false, so those listings drop out.
    filters.priceMin === undefined ? undefined : gte(price, String(filters.priceMin)),
    filters.priceMax === undefined ? undefined : lte(price, String(filters.priceMax)),
    filters.areaMin === undefined ? undefined : gte(listings.areaM2, String(filters.areaMin)),
    filters.areaMax === undefined ? undefined : lte(listings.areaM2, String(filters.areaMax)),
    filters.rooms === undefined
      ? undefined
      : filters.roomsOrMore === true
        ? gte(listings.rooms, filters.rooms)
        : eq(listings.rooms, filters.rooms),
    floor === 'not-first' || floor === 'middle' ? gt(listings.floor, 1) : undefined,
    floor === 'not-last' || floor === 'middle'
      ? lt(listings.floor, listings.totalFloors)
      : undefined,
    filters.poster === 'business'
      ? inArray(listings.posterType, ['agent', 'developer'])
      : filters.poster === 'other'
        ? inArray(listings.posterType, ['owner', 'unknown'])
        : undefined,
    filters.updatedSince === undefined
      ? undefined
      : gte(listings.sourceUpdatedAt, filters.updatedSince),
    // Text that holds no letter or digit asks for nothing, so it narrows nothing.
    query === null ? undefined : sql`${listings.search} @@ to_tsquery('simple', ${query})`,
  );
}

/** Every order ends in the id, so paging never repeats or drops a row when keys tie. */
function ordering(filters: RealEstateFilters): SQL[] {
  const price = filters.currency === 'gel' ? listings.priceGel : listings.priceUsd;
  switch (filters.sort) {
    case 'price-asc':
      return [sql`${price} asc nulls last`, asc(listings.id)];
    case 'price-desc':
      return [sql`${price} desc nulls last`, asc(listings.id)];
    case 'ppm2-asc':
      return [sql`${listings.pricePerM2Usd} asc nulls last`, asc(listings.id)];
    case 'area-desc':
      return [sql`${listings.areaM2} desc nulls last`, asc(listings.id)];
    default:
      return [desc(listings.sourceUpdatedAt), asc(listings.id)];
  }
}

const amount = (value: string | null): number | null => (value === null ? null : Number(value));

/** Listings on show at `now`, filtered and ordered. Never more than 500 at a time. */
export async function searchRealEstate(
  db: DatabaseOrTransaction,
  filters: RealEstateFilters,
  now: string,
): Promise<RealEstateRow[]> {
  const rows = await db
    .select({
      id: listings.id,
      canonicalUrl: listings.canonicalUrl,
      dealType: listings.dealType,
      propertyType: listings.propertyType,
      rooms: listings.rooms,
      bedrooms: listings.bedrooms,
      areaM2: listings.areaM2,
      floor: listings.floor,
      totalFloors: listings.totalFloors,
      priceGel: listings.priceGel,
      priceUsd: listings.priceUsd,
      pricePerM2Usd: listings.pricePerM2Usd,
      currencyPosted: listings.currencyPosted,
      cityName: listings.cityName,
      districtName: listings.districtName,
      subdistrictName: listings.subdistrictName,
      streetName: listings.streetName,
      streetNumber: listings.streetNumber,
      posterType: listings.posterType,
      promoted: listings.promoted,
      sourceUpdatedAt: listings.sourceUpdatedAt,
      firstSeenAt: listings.firstSeenAt,
    })
    .from(listings)
    .where(conditions(filters, now))
    .orderBy(...ordering(filters))
    .limit(Math.min(Math.max(filters.limit ?? 100, 1), MAX_LIMIT))
    .offset(Math.max(filters.offset ?? 0, 0));

  return rows.map((row) => ({
    ...row,
    areaM2: amount(row.areaM2),
    priceGel: amount(row.priceGel),
    priceUsd: amount(row.priceUsd),
    pricePerM2Usd: amount(row.pricePerM2Usd),
  }));
}

/**
 * How many listings match, counted no further than one past `ceiling`: a
 * result of `ceiling + 1` means "more than that". An exact count of a broad
 * filter would read most of the table for a number nobody acts on.
 */
export async function countRealEstate(
  db: DatabaseOrTransaction,
  filters: RealEstateFilters,
  now: string,
  ceiling: number = COUNT_CEILING,
): Promise<number> {
  const capped = db
    .select({ id: listings.id })
    .from(listings)
    .where(conditions(filters, now))
    .limit(ceiling + 1)
    .as('capped');
  const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(capped);
  return row?.total ?? 0;
}

export interface PlaceCount {
  ref: number;
  name: string;
  count: number;
}

export interface SubdistrictCount extends PlaceCount {
  cityRef: number;
  districtRef: number | null;
  districtName: string | null;
}

export interface RealEstateLocations {
  /** Cities with listings on show, the busiest first. */
  cities: PlaceCount[];
  /** Sub-districts with listings on show, the busiest first. */
  subdistricts: SubdistrictCount[];
}

/** The places the location filters can offer: only those with something on show. */
export async function realEstateLocations(
  db: DatabaseOrTransaction,
  filters: Pick<RealEstateFilters, 'sourceId'>,
  now: string,
): Promise<RealEstateLocations> {
  const total = sql<number>`count(*)::int`;
  const rows = await db
    .select({
      cityRef: listings.cityRef,
      cityName: sql<string | null>`max(${listings.cityName})`,
      districtRef: listings.districtRef,
      districtName: sql<string | null>`max(${listings.districtName})`,
      subdistrictRef: listings.subdistrictRef,
      subdistrictName: sql<string | null>`max(${listings.subdistrictName})`,
      total,
    })
    .from(listings)
    .where(conditions(filters, now))
    .groupBy(listings.cityRef, listings.districtRef, listings.subdistrictRef);

  const cities = new Map<number, PlaceCount>();
  const subdistricts: SubdistrictCount[] = [];
  for (const row of rows) {
    if (row.cityRef === null || row.cityName === null) continue;
    const city = cities.get(row.cityRef) ?? { ref: row.cityRef, name: row.cityName, count: 0 };
    city.count += row.total;
    cities.set(row.cityRef, city);
    if (row.subdistrictRef !== null && row.subdistrictName !== null) {
      subdistricts.push({
        ref: row.subdistrictRef,
        name: row.subdistrictName,
        count: row.total,
        cityRef: row.cityRef,
        districtRef: row.districtRef,
        districtName: row.districtName,
      });
    }
  }
  const busiestFirst = (a: PlaceCount, b: PlaceCount) => b.count - a.count || a.ref - b.ref;
  return {
    cities: [...cities.values()].sort(busiestFirst),
    subdistricts: subdistricts.sort(busiestFirst),
  };
}
