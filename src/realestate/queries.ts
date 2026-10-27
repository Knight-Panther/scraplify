import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
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
  /**
   * One row per look-alike group (Phase 11D), the group's first listing in
   * this order, after every filter: a filter matching any member shows the
   * group. A listing in no group is its own row.
   */
  grouped?: boolean;
  /** One look-alike group's listings only. */
  groupKey?: string;
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
  /** Its look-alike group, or null. */
  groupKey: string | null;
  /** Grouped: how many listings matching the filters the row stands for. Otherwise 1. */
  alikeCount: number;
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
    filters.groupKey === undefined ? undefined : eq(listings.groupKey, filters.groupKey),
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

/**
 * A price or area no real listing has: a poster's typo. Measured on the host
 * on 2026-10-27, 248 of 185,839 live listings, and each of 25 sampled was one:
 * a flat "for sale" at $462 (its rent), 1 m² (no area given), a flat "for
 * rent" at $87,500 a month (its sale price), 42,000 m² at $42,000 (the price
 * typed as the area). The bounds are wide on purpose; a 1,100 m² flat at
 * $1.6 million is not caught. Such a listing is kept and shown as posted, but
 * comes after every other one in the price and area sorts, the top of which
 * it would otherwise take. Never null: a missing value is not a typo.
 */
const implausibleValues = sql`coalesce(
  ${listings.areaM2} < 10
  or (${listings.areaM2} > case when ${listings.propertyType} = 'flat' then 1000 else 10000 end
      and ${listings.pricePerM2Usd} < 100)
  or (${listings.dealType} = 'sale' and ${listings.priceUsd} < 5000)
  or (${listings.dealType} = 'rent' and (${listings.priceUsd} > 50000 or ${listings.priceUsd} < 50)),
  false)`;

/** Every order ends in the id, so paging never repeats or drops a row when keys tie. */
function ordering(filters: RealEstateFilters): SQL[] {
  const price = filters.currency === 'gel' ? listings.priceGel : listings.priceUsd;
  switch (filters.sort) {
    case 'price-asc':
      return [sql`${implausibleValues} asc`, sql`${price} asc nulls last`, asc(listings.id)];
    case 'price-desc':
      return [sql`${implausibleValues} asc`, sql`${price} desc nulls last`, asc(listings.id)];
    case 'ppm2-asc':
      return [
        sql`${implausibleValues} asc`,
        sql`${listings.pricePerM2Usd} asc nulls last`,
        asc(listings.id),
      ];
    case 'area-desc':
      return [
        sql`${implausibleValues} asc`,
        sql`${listings.areaM2} desc nulls last`,
        asc(listings.id),
      ];
    default:
      return [desc(listings.sourceUpdatedAt), asc(listings.id)];
  }
}

const amount = (value: string | null): number | null => (value === null ? null : Number(value));

const isGrouped = (filters: RealEstateFilters) =>
  filters.grouped === true && filters.groupKey === undefined;

/**
 * The ids of the grouped listings that lead their groups: within each group,
 * the first matching listing in the page's own order. Only grouped listings
 * are ranked (about a fifth of them): a listing in no group stands for itself.
 *
 * It is used as `id IN (...)`, which Postgres builds once as a hash. Joined
 * instead, the planner paired every row of a page with every ranked row
 * (3.4 million comparisons, 0.7 s on the host, measured 2026-10-19).
 */
function groupLeaderIds(db: DatabaseOrTransaction, filters: RealEstateFilters, now: string) {
  const order = sql.join(ordering(filters), sql`, `);
  const ranked = db
    .select({
      id: listings.id,
      rank: sql<number>`row_number() over (partition by ${listings.groupKey} order by ${order})`.as(
        'rank',
      ),
    })
    .from(listings)
    .where(and(conditions(filters, now), isNotNull(listings.groupKey)))
    .as('ranked');
  return db.select({ id: ranked.id }).from(ranked).where(eq(ranked.rank, 1));
}

/** The rows a page shows: every match, or, grouped, each group's leader and every ungrouped match. */
function shownRows(db: DatabaseOrTransaction, filters: RealEstateFilters, now: string) {
  return isGrouped(filters)
    ? and(
        conditions(filters, now),
        or(isNull(listings.groupKey), inArray(listings.id, groupLeaderIds(db, filters, now))),
      )
    : conditions(filters, now);
}

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
      groupKey: listings.groupKey,
    })
    .from(listings)
    .where(shownRows(db, filters, now))
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
    .where(shownRows(db, filters, now))
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
