import { and, inArray, isNotNull, type SQL, sql } from 'drizzle-orm';
import { realEstatePublicListings as listings } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import {
  conditions,
  isGrouped,
  ordering,
  type RealEstateFilters,
  shownRows,
  withoutDetailFilters,
} from './filters.js';
import type { BuildingStatus, Condition, DealType, PropertyType } from './kinds.js';

export {
  BALCONIES_TOP,
  BATHROOMS_TOP,
  hasDetailFilter,
  type RealEstateFilters,
  type RealEstateSort,
  ROOMS_TOP,
  SHOWN_GRACE_DAYS,
} from './filters.js';

/**
 * What the Real estate tab reads. Everything goes through the
 * `realestate.public_listings` view on every surface: it is all the public
 * database role can see, and it leaves the description out, so no query here
 * can return one. Which listings match and in what order is `filters.ts`.
 */

const MAX_LIMIT = 500;
/** Counting stops here; the page says "10,000+" above it. */
export const COUNT_CEILING = 10_000;

export interface RealEstateRow {
  id: string;
  canonicalUrl: string;
  dealType: DealType;
  propertyType: PropertyType;
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
  /** ss.ge's code for a commercial space's type, or null. */
  commercialType: number | null;
  /** ss.ge's code for a plot's land type, or null. */
  landType: number | null;
  sourceUpdatedAt: string;
  firstSeenAt: string;
  /** Its look-alike group, or null. */
  groupKey: string | null;
  /** Grouped: how many listings matching the filters the row stands for. Otherwise 1. */
  alikeCount: number;
  /** From the listing's own page (Phase 12B); null until it is read, or when it does not say. */
  buildingStatus: BuildingStatus | null;
  condition: Condition | null;
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
      commercialType: listings.commercialType,
      landType: listings.landType,
      sourceUpdatedAt: listings.sourceUpdatedAt,
      firstSeenAt: listings.firstSeenAt,
      groupKey: listings.groupKey,
      buildingStatus: listings.buildingStatus,
      condition: listings.condition,
    })
    .from(listings)
    .where(shownRows(filters, now))
    .orderBy(...ordering(filters))
    .limit(Math.min(Math.max(filters.limit ?? 100, 1), MAX_LIMIT))
    .offset(Math.max(filters.offset ?? 0, 0));

  // How many matching listings each folded row stands for: only the groups
  // on this page, through the group key's index.
  const alike = new Map<string, number>();
  const keys = isGrouped(filters)
    ? [...new Set(rows.map((row) => row.groupKey).filter((key) => key !== null))]
    : [];
  if (keys.length > 0) {
    const counts = await db
      .select({ groupKey: listings.groupKey, total: sql<number>`count(*)::int` })
      .from(listings)
      .where(and(conditions(filters, now), inArray(listings.groupKey, keys)))
      .groupBy(listings.groupKey);
    for (const { groupKey, total } of counts) {
      if (groupKey !== null) alike.set(groupKey, Number(total));
    }
  }

  return rows.map((row) => ({
    ...row,
    areaM2: amount(row.areaM2),
    priceGel: amount(row.priceGel),
    priceUsd: amount(row.priceUsd),
    pricePerM2Usd: amount(row.pricePerM2Usd),
    alikeCount: row.groupKey === null ? 1 : (alike.get(row.groupKey) ?? 1),
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
  // Grouped, it counts the rows the page would show: one per group.
  const capped = db
    .select({ id: listings.id })
    .from(listings)
    .where(shownRows(filters, now))
    .limit(ceiling + 1)
    .as('capped');
  const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(capped);
  return row?.total ?? 0;
}

export interface DetailsCoverage {
  /** Of `total`, the listings whose own page was read. */
  read: number;
  /** Listings matching every filter but those on listing-page fields. */
  total: number;
}

/**
 * How many listings a listing-page filter could judge: those matching every
 * other filter, and how many of them have their page read. Listings, never
 * look-alike groups; each counted no further than one past `ceiling`, as
 * `countRealEstate` is.
 */
export async function detailsCoverage(
  db: DatabaseOrTransaction,
  filters: RealEstateFilters,
  now: string,
  ceiling: number = COUNT_CEILING,
): Promise<DetailsCoverage> {
  const others = conditions(withoutDetailFilters(filters), now);
  const capped = async (where: SQL | undefined) => {
    const rows = db
      .select({ id: listings.id })
      .from(listings)
      .where(where)
      .limit(ceiling + 1);
    const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(rows.as('capped'));
    return row?.total ?? 0;
  };
  const [total, read] = await Promise.all([
    capped(others),
    capped(and(others, isNotNull(listings.detailsReadAt))),
  ]);
  return { read, total };
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
