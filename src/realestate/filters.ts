import {
  and,
  arrayContains,
  asc,
  type Column,
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
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { realEstatePublicListings as listings } from '../db/schema/index.js';
import type {
  AmenityKey,
  BuildingStatus,
  Condition,
  DealType,
  FloorType,
  Project,
  PropertyType,
} from './kinds.js';
import { implausibleValuesOf } from './plausibility.js';
import { listingSearchQuery } from './search.js';

/**
 * Which listings the Real estate tab shows for a set of filters, and in what
 * order: the one implementation of those rules. The tab's queries
 * (`queries.ts`) and the SQL handed to Hermes (`filter-builder.ts`, contract
 * C1 in docs/hermes-contracts.md) are both built from what is here, over the
 * `realestate.public_listings` view. Nothing here touches a database.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How long a listing stays on show past its expected end: not at all
 * (guideline §9.3). It was two days until 2026-11-10, when 8,112 listings
 * were on the tab in those two days and ss.ge was asked about 60 of them: 51
 * were gone (27 of 30 agents' listings, 24 of 30 naming no business), and the
 * end we expect was the site's own to the second for 18 of 18 still running.
 * The grace showed about five dead listings for each live one it kept. A
 * listing that outlives its expected end (an owner's 45 days, a renewal not
 * yet seen) is back once the night's checks read its page or a list shows it
 * renewed. With no grace the last sighting no longer extends anything; the
 * condition keeps its shape, which is also what Hermes is handed (C1).
 */
export const SHOWN_GRACE_DAYS = 0;
/** The top choice of each count on ss.ge's panels, meaning that many or more. */
export const ROOMS_TOP = 10;
export const BATHROOMS_TOP = 5;
export const BALCONIES_TOP = 5;

export type RealEstateSort = 'newest' | 'price-asc' | 'price-desc' | 'ppm2-asc' | 'area-desc';

/** A place at one level of ss.ge's location tree, by its ref. */
export interface RealEstatePlace {
  level: 'city' | 'district' | 'subdistrict';
  ref: number;
}

export interface RealEstateFilters {
  /** One source's listings only. */
  sourceId?: string;
  dealType?: DealType;
  propertyType?: PropertyType;
  /** Any of these commercial space types (ss.ge codes, `COMMERCIAL_TYPE_CODES`). Empty narrows nothing. */
  commercialTypes?: number[];
  /** Any of these land types (`LAND_TYPE_CODES`). Empty narrows nothing. */
  landTypes?: number[];
  cityRef?: number;
  districtRef?: number;
  subdistrictRef?: number;
  /**
   * In any of these places, each at its own level ("Vake or Vera"). Empty
   * narrows nothing. The tab asks for one place at a time with the refs
   * above; Hermes, whose questions name several, uses this.
   */
  places?: RealEstatePlace[];
  /** The currency the price bounds are in, and the one price sorts use. */
  currency?: 'usd' | 'gel';
  priceMin?: number;
  priceMax?: number;
  areaMin?: number;
  areaMax?: number;
  /** `middle` is neither the first floor nor the last. */
  floor?: 'not-first' | 'not-last' | 'middle';
  /** `business` is an agency or a developer; `other` is everything the source does not mark as one. */
  poster?: 'business' | 'other';
  /** Updated on the source at or after this instant. */
  updatedSince?: string;
  /** The price bounds are per m², in `currency`. */
  pricePerM2?: boolean;
  /** Any of these room counts; `ROOMS_TOP` means that many or more. Empty narrows nothing. */
  roomsIn?: number[];
  floorMin?: number;
  floorMax?: number;
  /** Posted by a developer (results row). */
  developerOnly?: boolean;
  /** At least one photo (results row; no photo is ever fetched). */
  withPhotos?: boolean;
  exclusiveOnly?: boolean;
  /*
   * The rest are read from a listing's own page (Phase 12B), so each matches
   * only listings whose page was read (`DETAIL_FILTER_KEYS`): unknown is not "no".
   * Every choice list is "any of" and narrows nothing when empty.
   */
  buildingStatuses?: BuildingStatus[];
  conditions?: Condition[];
  projects?: Project[];
  floorTypes?: FloorType[];
  /** `BATHROOMS_TOP` means that many or more; 0 is none. */
  bathrooms?: number[];
  /** `BALCONIES_TOP` means that many or more; 0 is none. */
  balconies?: number[];
  kitchenAreaMin?: number;
  kitchenAreaMax?: number;
  houseAreaMin?: number;
  houseAreaMax?: number;
  yardAreaMin?: number;
  yardAreaMax?: number;
  /** Every one of these. */
  amenities?: AmenityKey[];
  /** Posted by a private person, as the listing's page says. */
  ownerOnly?: boolean;
  /**
   * Leaves out a price or area no real listing has, a poster's typo
   * (`plausibility.ts`). The tab shows those, last in its price and area
   * sorts; statistics leave them out, before look-alikes are folded, so a
   * group led by a typo still counts once, by its next listing.
   */
  plausibleOnly?: boolean;
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

/**
 * The filters read from a listing's own page. Any of them limits the results
 * to listings whose page was read, and `detailsCoverage` leaves them out to
 * count how many listings could be judged, so a new filter on a listing-page
 * field belongs in this list.
 */
const DETAIL_FILTER_KEYS = [
  'buildingStatuses',
  'conditions',
  'projects',
  'floorTypes',
  'bathrooms',
  'balconies',
  'kitchenAreaMin',
  'kitchenAreaMax',
  'houseAreaMin',
  'houseAreaMax',
  'yardAreaMin',
  'yardAreaMax',
  'amenities',
  'ownerOnly',
] as const satisfies readonly (keyof RealEstateFilters)[];

/** Whether a filter on a listing-page field is set, so the page should say how many listings it could judge. */
export function hasDetailFilter(filters: RealEstateFilters): boolean {
  return DETAIL_FILTER_KEYS.some((key) => {
    const value = filters[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false;
  });
}

export function withoutDetailFilters(filters: RealEstateFilters): RealEstateFilters {
  const rest: RealEstateFilters = { ...filters };
  for (const key of DETAIL_FILTER_KEYS) delete rest[key];
  return rest;
}

const anyOf = (column: Column, chosen: readonly (string | number)[] | undefined) =>
  chosen === undefined || chosen.length === 0 ? undefined : inArray(column, [...chosen]);

/** Any of these counts, `top` meaning that many or more. Empty narrows nothing. */
function countIn(column: Column, chosen: readonly number[] | undefined, top: number) {
  if (chosen === undefined || chosen.length === 0) return undefined;
  return or(
    anyOf(
      column,
      chosen.filter((count) => count < top),
    ),
    chosen.some((count) => count >= top) ? gte(column, top) : undefined,
  );
}

/** Inclusive bounds; a missing value is outside any bound. */
const between = (column: Column, min: number | undefined, max: number | undefined) =>
  and(
    min === undefined ? undefined : gte(column, min),
    max === undefined ? undefined : lte(column, max),
  );

const PLACE_COLUMNS = {
  city: listings.cityRef,
  district: listings.districtRef,
  subdistrict: listings.subdistrictRef,
} as const;

function inAnyPlace(places: readonly RealEstatePlace[] | undefined) {
  if (places === undefined || places.length === 0) return undefined;
  return or(...places.map((place) => eq(PLACE_COLUMNS[place.level], place.ref)));
}

/** A poster's typo in the price or area (`src/realestate/plausibility.ts`). */
export const implausibleValues = implausibleValuesOf(listings);

/** Every filter, over `realestate.public_listings`, at the time `now`. */
export function conditions(filters: RealEstateFilters, now: string): SQL | undefined {
  const shownAfter = new Date(Date.parse(now) - SHOWN_GRACE_DAYS * DAY_MS).toISOString();
  const gel = filters.currency === 'gel';
  const price =
    filters.pricePerM2 === true
      ? gel
        ? listings.pricePerM2Gel
        : listings.pricePerM2Usd
      : gel
        ? listings.priceGel
        : listings.priceUsd;
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
    filters.commercialTypes === undefined || filters.commercialTypes.length === 0
      ? undefined
      : inArray(listings.commercialType, filters.commercialTypes),
    filters.landTypes === undefined || filters.landTypes.length === 0
      ? undefined
      : inArray(listings.landType, filters.landTypes),
    filters.cityRef === undefined ? undefined : eq(listings.cityRef, filters.cityRef),
    filters.districtRef === undefined ? undefined : eq(listings.districtRef, filters.districtRef),
    filters.subdistrictRef === undefined
      ? undefined
      : eq(listings.subdistrictRef, filters.subdistrictRef),
    inAnyPlace(filters.places),
    // A bound on a missing price or area is false, so those listings drop out.
    filters.priceMin === undefined ? undefined : gte(price, String(filters.priceMin)),
    filters.priceMax === undefined ? undefined : lte(price, String(filters.priceMax)),
    filters.areaMin === undefined ? undefined : gte(listings.areaM2, String(filters.areaMin)),
    filters.areaMax === undefined ? undefined : lte(listings.areaM2, String(filters.areaMax)),
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
    countIn(listings.rooms, filters.roomsIn, ROOMS_TOP),
    between(listings.floor, filters.floorMin, filters.floorMax),
    filters.developerOnly === true ? eq(listings.posterType, 'developer') : undefined,
    filters.withPhotos === true ? gt(listings.imageCount, 0) : undefined,
    filters.exclusiveOnly === true ? eq(listings.exclusive, true) : undefined,
    // From the listing's own page: a listing whose page was not read is never judged.
    hasDetailFilter(filters) ? isNotNull(listings.detailsReadAt) : undefined,
    anyOf(listings.buildingStatus, filters.buildingStatuses),
    anyOf(listings.condition, filters.conditions),
    anyOf(listings.project, filters.projects),
    anyOf(listings.floorType, filters.floorTypes),
    countIn(listings.bathrooms, filters.bathrooms, BATHROOMS_TOP),
    countIn(listings.balconies, filters.balconies, BALCONIES_TOP),
    between(listings.kitchenArea, filters.kitchenAreaMin, filters.kitchenAreaMax),
    between(listings.houseArea, filters.houseAreaMin, filters.houseAreaMax),
    between(listings.yardArea, filters.yardAreaMin, filters.yardAreaMax),
    filters.amenities === undefined || filters.amenities.length === 0
      ? undefined
      : arrayContains(listings.amenities, filters.amenities),
    filters.ownerOnly === true ? eq(listings.posterEntity, 'individual') : undefined,
    filters.plausibleOnly === true ? sql`not ${implausibleValues}` : undefined,
    // Text that holds no letter or digit asks for nothing, so it narrows nothing.
    query === null ? undefined : sql`${listings.search} @@ to_tsquery('simple', ${query})`,
  );
}

/** Every order ends in the id, so paging never repeats or drops a row when keys tie. A typo sorts last. */
export function ordering(filters: RealEstateFilters): SQL[] {
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

export const isGrouped = (filters: RealEstateFilters) =>
  filters.grouped === true && filters.groupKey === undefined;

/** Builds subqueries without a database, so the SQL can be handed on (`filter-builder.ts`). */
const queryBuilder = new QueryBuilder();

/**
 * The ids of the grouped listings that lead their groups: within each group,
 * the first matching listing in the page's own order. Only grouped listings
 * are ranked (about a fifth of them): a listing in no group stands for itself.
 *
 * It is used as `id IN (...)`, which Postgres builds once as a hash. Joined
 * instead, the planner paired every row of a page with every ranked row
 * (3.4 million comparisons, 0.7 s on the host, measured 2026-10-19).
 */
function groupLeaderIds(filters: RealEstateFilters, now: string) {
  const order = sql.join(ordering(filters), sql`, `);
  const ranked = queryBuilder
    .select({
      id: listings.id,
      rank: sql<number>`row_number() over (partition by ${listings.groupKey} order by ${order})`.as(
        'rank',
      ),
    })
    .from(listings)
    .where(and(conditions(filters, now), isNotNull(listings.groupKey)))
    .as('ranked');
  return queryBuilder.select({ id: ranked.id }).from(ranked).where(eq(ranked.rank, 1));
}

/** The rows a page shows: every match, or, grouped, each group's leader and every ungrouped match. */
export function shownRows(filters: RealEstateFilters, now: string): SQL | undefined {
  return isGrouped(filters)
    ? and(
        conditions(filters, now),
        or(isNull(listings.groupKey), inArray(listings.id, groupLeaderIds(filters, now))),
      )
    : conditions(filters, now);
}
