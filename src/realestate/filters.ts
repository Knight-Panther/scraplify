import {
  and,
  arrayContains,
  arrayOverlaps,
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
import {
  realEstatePublicPlaces as catalogue,
  realEstatePublicListings as listings,
} from '../db/schema/index.js';
import {
  type AmenityKey,
  type BuildingStatus,
  type Condition,
  type DealType,
  type FloorType,
  LOCATION_PRECISIONS,
  type LocationPrecision,
  type Project,
  type PropertyType,
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
 * listing that outlives its expected end (an owner's 45 days) stays on show
 * while its list still shows it: each night's read of the list's end moves
 * its expected end on (`upsertListing`, `SEEN_PAST_END_HOURS`). Here the last
 * sighting extends nothing by itself; the condition keeps its shape, which is
 * also what Hermes is handed (C1).
 */
export const SHOWN_GRACE_DAYS = 0;
/** The top choice of each count on ss.ge's panels, meaning that many or more. */
export const ROOMS_TOP = 10;
export const BATHROOMS_TOP = 5;
export const BALCONIES_TOP = 5;

export type RealEstateSort = 'newest' | 'price-asc' | 'price-desc' | 'ppm2-asc' | 'area-desc';

/**
 * The levels a place filter takes, as C6 (`realestate.public_places`) names
 * them: ss.ge's map, then the official map, its stations and the owner's
 * neighbourhoods. A C6 row's `level` and `ref` go in as they are.
 */
export const PLACE_FILTER_LEVELS = [
  'city',
  'district',
  'subdistrict',
  'street',
  'municipality',
  'official_district',
  'metro_station',
  'neighbourhood',
] as const;
export type PlaceFilterLevel = (typeof PLACE_FILTER_LEVELS)[number];

/** A place on either map, by its level and ref in C6. */
export interface RealEstatePlace {
  level: PlaceFilterLevel;
  ref: number;
}

/** ss.ge's walking bands, in minutes (`METRO_MINUTE_EDGES`); a station further than the last is not near. */
export const METRO_MINUTE_BANDS = [5, 10, 15, 20] as const;
export type MetroMinutes = (typeof METRO_MINUTE_BANDS)[number];
const METRO_MINUTES_TOP = 20;

/**
 * Near the metro, by our checked metro (C5's `metro_station`, `metro_minutes`,
 * `metro_nearby`), never ss.ge's claim.
 */
export interface RealEstateMetro {
  /** At most this band to the station; 20, the last band, when absent. */
  maxMinutes?: MetroMinutes;
  /** Any of these stations, by ss.ge's code (C6's `metro_station` `code`); any station when absent or empty. */
  stations?: string[];
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
   *
   * On the official map (Phase 14D): an `official_district` matches a listing
   * whose own official district is known to be it, and a `metro_station` one
   * within 20 minutes of it; a listing whose location does not say is never
   * matched, and `locationUnknown` counts it. A `municipality` matches the
   * listings that name it and the settlements C6 knows to be in it. A
   * `neighbourhood` is not an ss.ge place, so it matches the ss.ge place its
   * listings are under (C6's `parent_level`, `parent_ref`).
   */
  places?: RealEstatePlace[];
  /** Near the metro (Phase 14D); unknown never matches, and `locationUnknown` counts it. */
  metro?: RealEstateMetro;
  /** Located at least this exactly (C5's `location_precision`, `LOCATION_PRECISIONS`). */
  minPrecision?: LocationPrecision;
  /** Leaves out listings whose pin, or ss.ge's metro claim, contradicts the rest (C5's `location_uncertain`). */
  excludeUncertain?: boolean;
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

/*
 * The official map, its stations and the owner's neighbourhoods are read from
 * C6 (`realestate.public_places`) by subqueries that do not depend on the
 * listing, so Postgres works each out once per query. They are not narrowed
 * to the listing's source: these rows come from committed files and are the
 * same under every source that has them (only ss.ge does).
 */

/** C6's places at one level, by ref: one column of them. */
const catalogueRefs = (
  column: typeof catalogue.code | typeof catalogue.parentRef | typeof catalogue.ref,
  where: SQL | undefined,
) => queryBuilder.select({ value: column }).from(catalogue).where(where);

/** A station's code (ss.ge's, the one C5's metro columns hold), as an array, empty when the ref is no station. */
const stationCodes = (ref: number) =>
  sql`array(${catalogueRefs(catalogue.code, and(eq(catalogue.level, 'metro_station'), eq(catalogue.ref, ref)))})`;

/** The settlements C6 knows to be in a municipality (learned from listing pages). */
const settlementsOf = (municipalityRef: number) =>
  catalogueRefs(
    catalogue.ref,
    and(
      eq(catalogue.level, 'city'),
      eq(catalogue.parentLevel, 'municipality'),
      eq(catalogue.parentRef, municipalityRef),
    ),
  );

/** A neighbourhood's ss.ge place, when it is at this level. */
const neighbourhoodParent = (ref: number, level: 'city' | 'district' | 'subdistrict') =>
  catalogueRefs(
    catalogue.parentRef,
    and(
      eq(catalogue.level, 'neighbourhood'),
      eq(catalogue.ref, ref),
      eq(catalogue.parentLevel, level),
    ),
  );

/** In one place, as far as the listing's location says. Null, never true, where it does not. */
function inPlace(place: RealEstatePlace): SQL {
  switch (place.level) {
    case 'city':
      return eq(listings.cityRef, place.ref);
    case 'district':
      return eq(listings.districtRef, place.ref);
    case 'subdistrict':
      return eq(listings.subdistrictRef, place.ref);
    case 'street':
      return eq(listings.streetRef, place.ref);
    case 'municipality':
      return or(
        eq(listings.municipalityRef, place.ref),
        inArray(listings.cityRef, settlementsOf(place.ref)),
      ) as SQL;
    case 'official_district':
      return eq(listings.officialDistrictRef, place.ref);
    case 'metro_station':
      return sql`${listings.metroNearby} && ${stationCodes(place.ref)}`;
    case 'neighbourhood':
      return or(
        inArray(listings.subdistrictRef, neighbourhoodParent(place.ref, 'subdistrict')),
        inArray(listings.districtRef, neighbourhoodParent(place.ref, 'district')),
        inArray(listings.cityRef, neighbourhoodParent(place.ref, 'city')),
      ) as SQL;
  }
}

function inAnyPlace(places: readonly RealEstatePlace[] | undefined) {
  if (places === undefined || places.length === 0) return undefined;
  return or(...places.map(inPlace));
}

/** The sub-districts where a listing's location matches `known`: where a listing nobody located might match too. */
const subdistrictsWhere = (known: SQL | undefined) =>
  queryBuilder.select({ value: listings.subdistrictRef }).from(listings).where(known);

/**
 * The ss.ge areas C6 sees overlapping an official district: some of their
 * located listings are in it (`official_shares`), at one level.
 */
const areasOverlapping = (officialRef: number, level: 'district' | 'subdistrict') =>
  catalogueRefs(
    catalogue.ref,
    and(
      eq(catalogue.level, level),
      sql`(${catalogue.officialShares} -> 'by_district') ?| ${sql`array(${catalogueRefs(
        catalogue.code,
        and(eq(catalogue.level, 'official_district'), eq(catalogue.ref, officialRef)),
      )})`}`,
    ),
  );

/**
 * A listing that might be in this place, though its location does not say:
 * for an official district, no official district known, in an ss.ge area
 * overlapping it; for a station, not located, in a sub-district where a
 * located listing is near it. Undefined for a place a listing always names
 * or never can.
 */
function unknownInPlace(place: RealEstatePlace): SQL | undefined {
  switch (place.level) {
    case 'official_district':
      return and(
        isNull(listings.officialDistrictRef),
        or(
          inArray(listings.subdistrictRef, areasOverlapping(place.ref, 'subdistrict')),
          and(
            isNull(listings.subdistrictRef),
            inArray(listings.districtRef, areasOverlapping(place.ref, 'district')),
          ),
        ),
      );
    case 'metro_station':
      return and(
        isNull(listings.metroBasis),
        inArray(listings.subdistrictRef, subdistrictsWhere(inPlace(place))),
      );
    default:
      return undefined;
  }
}

/** Near the metro, as far as the listing's checked metro says. */
function nearMetro(metro: RealEstateMetro): SQL | undefined {
  const maxMinutes = metro.maxMinutes ?? METRO_MINUTES_TOP;
  const stations = metro.stations ?? [];
  if (stations.length === 0) return lte(listings.metroMinutes, maxMinutes);
  // Every station within the last band is in `metro_nearby`.
  if (maxMinutes >= METRO_MINUTES_TOP) return arrayOverlaps(listings.metroNearby, stations);
  // Each station's own band, nearest or not: `metro_nearby_minutes` is in `metro_nearby`'s order.
  return sql`exists (select 1 from unnest(${listings.metroNearby}, ${listings.metroNearbyMinutes}) as station(code, minutes)
    where station.code in (${sql.join(
      stations.map((code) => sql`${code}`),
      sql`, `,
    )}) and station.minutes <= ${maxMinutes})`;
}

/** Might be near the metro, though the listing's location does not say: not located, in a sub-district where a located listing is. */
function unknownNearMetro(metro: RealEstateMetro): SQL | undefined {
  return and(
    isNull(listings.metroBasis),
    inArray(listings.subdistrictRef, subdistrictsWhere(nearMetro(metro))),
  );
}

/** At least this exact. */
const atLeast = (precision: LocationPrecision) =>
  inArray(
    listings.locationPrecision,
    LOCATION_PRECISIONS.slice(LOCATION_PRECISIONS.indexOf(precision)),
  );

/** Whether a location filter is set that a listing's location may not answer: an official district, a station, or `metro`. */
export function hasUnknowableLocationFilter(filters: RealEstateFilters): boolean {
  return (
    filters.metro !== undefined ||
    (filters.places ?? []).some((place) => unknownInPlace(place) !== undefined)
  );
}

/**
 * The listings the location filters might hold though their location does not
 * say (Phase 14D): every other filter holds, each location filter matches or
 * cannot be told, and not all of them are known to match. Listings, never
 * look-alike groups. Undefined without such a filter (`hasUnknowableLocationFilter`).
 */
export function locationUnknown(filters: RealEstateFilters, now: string): SQL | undefined {
  if (!hasUnknowableLocationFilter(filters)) return undefined;
  const others: RealEstateFilters = { ...filters };
  delete others.places;
  delete others.metro;
  const places = filters.places ?? [];
  const inPlaces = inAnyPlace(places);
  const nearStation = filters.metro === undefined ? undefined : nearMetro(filters.metro);
  const known = [inPlaces, nearStation].filter((match) => match !== undefined);
  return and(
    conditions(others, now),
    inPlaces === undefined ? undefined : or(inPlaces, ...places.map(unknownInPlace)),
    filters.metro === undefined ? undefined : or(nearStation, unknownNearMetro(filters.metro)),
    // A comparison with an unknown value is null, which is not a match.
    sql`not (${and(...known.map((match) => sql`coalesce(${match}, false)`))})`,
  );
}

/**
 * How many of `locationUnknown`'s listings are likely to match: in each ss.ge
 * sub-district, its unknown listings times the share of its listings whose
 * location does tell that match. One located listing near a station must not
 * make every unlocated listing of a large area count (2026-11-12: one Vake
 * listing within 10 minutes of Rustaveli put all 5,566 unlocated Vake rentals
 * among the 17,455 that might be; weighted, about 700 are likely). The shares
 * are taken over every listing of the area, whatever the other filters, since
 * where a listing is does not depend on its deal or kind. A statement with one
 * row, `unknown` and `likely`; undefined without such a filter.
 */
export function locationEstimate(filters: RealEstateFilters, now: string): SQL | undefined {
  const unknown = locationUnknown(filters, now);
  if (unknown === undefined) return undefined;
  const places = filters.places ?? [];
  const inPlaces = inAnyPlace(places);
  const placesUnknown = or(...places.map(unknownInPlace));
  const nearStation = filters.metro === undefined ? undefined : nearMetro(filters.metro);
  const metroUnknown = filters.metro === undefined ? undefined : unknownNearMetro(filters.metro);
  const isTrue = (condition: SQL | undefined) =>
    condition === undefined ? undefined : sql`coalesce(${condition}, false)`;
  // Told: the location says whether it matches, either way.
  const told = (match: SQL | undefined, notSaid: SQL | undefined) =>
    match === undefined ? undefined : or(isTrue(match), sql`not ${isTrue(notSaid) ?? sql`false`}`);
  const area = listings.subdistrictRef;
  return sql`with unknown as (
    select ${area} as area, count(*) as listings
      from ${listings} where ${unknown} group by 1
  ), told as (
    select ${area} as area,
           count(*) filter (where ${and(isTrue(inPlaces), isTrue(nearStation))}) as matching,
           count(*) filter (where ${and(told(inPlaces, placesUnknown), told(nearStation, metroUnknown))}) as told
      from ${listings} where ${area} in (select area from unknown) group by 1
  )
  select coalesce(sum(unknown.listings), 0)::integer as unknown,
         coalesce(round(sum(unknown.listings * told.matching::numeric / nullif(told.told, 0))), 0)::integer as likely
    from unknown left join told on told.area = unknown.area`;
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
    filters.metro === undefined ? undefined : nearMetro(filters.metro),
    filters.minPrecision === undefined ? undefined : atLeast(filters.minPrecision),
    filters.excludeUncertain === true ? eq(listings.locationUncertain, false) : undefined,
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
