import { type SQL, sql } from 'drizzle-orm';

/**
 * The rules that judge where a listing is (Phase 14C, docs/PHASE_14_PLAN.md,
 * 14C). Starting values from the first night of 14A's data (2026-11-08); the
 * thresholds are calibrated on two nights and recorded here with their
 * evidence. A change raises `LOCATION_RULES_VERSION`, and the next refresh
 * judges every listing again: the raw evidence (pins, ss.ge's claims) is kept,
 * and nothing derived is hashed, so it costs no churn.
 */
export const LOCATION_RULES_VERSION = 1;

/**
 * A street is located by its own listings' pins when it has at least this
 * many candidates: half of a street's poster-placed pins sit within 84 m of
 * their median (2,764 pins on 276 streets, 2026-11-08).
 */
export const STREET_LOCATION_MIN_PINS = 3;

/** The map's default point, where a pin lands when the poster never moves it. */
export const PLACEHOLDER_PIN = { latitude: 41.6938, longitude: 44.8015 } as const;
export const PLACEHOLDER_METERS = 50;

/** One exact pin on this many different streets is an agency's or the map's default, not a place. */
export const SHARED_PIN_MIN_STREETS = 3;

/**
 * A pin further than this from its city's median pin is broken: some carry
 * the latitude as the longitude (41.7882, 41.7882 on a Tbilisi street). A box
 * or "latitude equals longitude" would not do: Batumi really is near
 * 41.64, 41.63.
 */
export const CITY_RADIUS_METERS = 30_000;

/** Metres per degree of latitude; a degree of longitude is this times the latitude's cosine. */
export const METERS_PER_DEGREE = 111_195;

/**
 * A candidate pin is trusted within this of its street's location: between
 * the 75th (549 m) and 90th (1,325 m) percentile of a street's own pins
 * around their median (2026-11-08).
 */
export const TRUSTED_PIN_STREET_METERS = 600;

/** On a street with no location, a candidate pin is trusted within this of its sub-district's pin median. */
export const TRUSTED_PIN_AREA_METERS = 3_000;

/** A sub-district's pin median needs this many candidate pins. */
export const AREA_MEDIAN_MIN_PINS = 3;

/**
 * A sub-district gives its listings an official district (basis `area`) when
 * at least this many of its trusted pins lie in official districts, and this
 * share of them in one.
 */
export const AREA_MIN_TRUSTED_PINS = 20;
export const AREA_MIN_SHARE = 0.95;

/**
 * ss.ge's walking-minutes bands, as straight-line metres from the location
 * to a station. Fitted to ss.ge's own claims on 1,663 poster-placed Tbilisi
 * pins (2026-11-08): these edges give ss.ge's band for 86% of the 8,009
 * station-and-pin pairs within 2.5 km, the same nearest station for 97.5% of
 * listings, and its band within one step for 99%. ss.ge's bands overlap
 * (they follow streets, not straight lines), so no edges do much better.
 * Beyond the last edge a station is not near, as on ss.ge.
 */
export const METRO_MINUTE_EDGES: ReadonlyArray<{ minutes: number; maxMeters: number }> = [
  { minutes: 5, maxMeters: 325 },
  { minutes: 10, maxMeters: 625 },
  { minutes: 15, maxMeters: 1_000 },
  { minutes: 20, maxMeters: 1_325 },
];

/** The private distance to the station is kept to this. */
export const METRO_DISTANCE_STEP_METERS = 50;

/** The flags that make a listing's location uncertain: the pin, or ss.ge's metro claim from it, contradicts the rest. */
export const UNCERTAIN_FLAGS = [
  'pin_far_from_street',
  'pin_far_from_area',
  'metro_from_untrusted_pin',
] as const;

/** Every flag `location_flags` can hold. */
export const LOCATION_FLAGS = [
  'pin_placeholder',
  'pin_broken',
  ...UNCERTAIN_FLAGS,
  'house_number_junk',
  'district_inferred',
] as const;
export type LocationFlag = (typeof LOCATION_FLAGS)[number];

/** A station's minutes band at this many straight-line metres, or null beyond the last edge. */
export function metroMinutes(meters: number): number | null {
  return METRO_MINUTE_EDGES.find((edge) => meters <= edge.maxMeters)?.minutes ?? null;
}

/** Our metro from one point: the nearest station within the bands, its band, its distance (private), and every station within the bands, nearest first. */
export interface MetroNear {
  station: string | null;
  minutes: number | null;
  distanceM: number | null;
  nearby: string[];
}

export function metroNear(
  stations: ReadonlyArray<{ code: string; lat: number; lng: number }>,
  lat: number,
  lng: number,
): MetroNear {
  const near = stations
    .map((station) => ({
      code: station.code,
      meters: metersApart(lat, lng, station.lat, station.lng),
    }))
    .filter((station) => metroMinutes(station.meters) !== null)
    .sort((a, b) => a.meters - b.meters || a.code.localeCompare(b.code));
  const nearest = near[0];
  return nearest === undefined
    ? { station: null, minutes: null, distanceM: null, nearby: [] }
    : {
        station: nearest.code,
        minutes: metroMinutes(nearest.meters),
        distanceM:
          Math.round(nearest.meters / METRO_DISTANCE_STEP_METERS) * METRO_DISTANCE_STEP_METERS,
        nearby: near.map((station) => station.code),
      };
}

/** The median of some numbers, interpolated like Postgres's `percentile_cont(0.5)`. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = (sorted.length - 1) / 2;
  const low = sorted[Math.floor(middle)] as number;
  const high = sorted[Math.ceil(middle)] as number;
  return low + (high - low) * (middle - Math.floor(middle));
}

/**
 * One building, for grouping listings (13E): `c<complex_ref>`, else
 * `s<street_ref>-<number><suffix>`, else null. `buildingKeySql` is the same
 * rule over `realestate.listings`.
 */
export function buildingKey(listing: {
  complexRef: number | null;
  streetRef: number | null;
  houseNumber: number | null;
  houseSuffix: string | null;
}): string | null {
  if (listing.complexRef !== null) return `c${listing.complexRef}`;
  if (listing.streetRef === null || listing.houseNumber === null) return null;
  return `s${listing.streetRef}-${listing.houseNumber}${listing.houseSuffix ?? ''}`;
}

export function buildingKeySql(listing: SQL): SQL {
  return sql`case
    when ${listing}.complex_ref is not null then 'c' || ${listing}.complex_ref
    when ${listing}.street_ref is not null and ${listing}.house_number is not null
      then 's' || ${listing}.street_ref || '-' || ${listing}.house_number || coalesce(${listing}.house_suffix, '')
  end`;
}

/** Near the map's default point, as SQL over float8 expressions. */
function nearPlaceholderSql(lat: SQL, lng: SQL): SQL {
  const placeholderLat = PLACEHOLDER_METERS / METERS_PER_DEGREE;
  const placeholderLng =
    PLACEHOLDER_METERS / (METERS_PER_DEGREE * Math.cos((PLACEHOLDER_PIN.latitude * Math.PI) / 180));
  return sql`(abs(${lat} - ${PLACEHOLDER_PIN.latitude}) < ${placeholderLat}
              and abs(${lng} - ${PLACEHOLDER_PIN.longitude}) < ${placeholderLng})`;
}

/** Metres between two nearby points, on a local plane, as SQL over float8 expressions. */
export function metersSql(lat1: SQL, lng1: SQL, lat2: SQL, lng2: SQL): SQL {
  return sql`sqrt(power((${lng1} - ${lng2}) * cos(radians(${lat1})) * ${METERS_PER_DEGREE}, 2)
                + power((${lat1} - ${lat2}) * ${METERS_PER_DEGREE}, 2))`;
}

/** The same in TypeScript. */
export function metersApart(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const kx = METERS_PER_DEGREE * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot((lng1 - lng2) * kx, (lat1 - lat2) * METERS_PER_DEGREE);
}

/**
 * The common table expressions that pick candidate pins: an active listing's
 * pin the poster placed, not the map's default, not shared by several
 * streets, and within reach of its city. Defines `pins`, `shared`,
 * `city_mid` and `candidates` (listing id, street, sub-district, city, lat,
 * lng); append further CTEs after it with a comma.
 */
export function candidatePinsSql(sourceId: string): SQL {
  return sql`pins as (
    select l.id, l.street_ref, l.subdistrict_ref, l.city_ref,
           l.latitude::float8 as lat, l.longitude::float8 as lng
      from realestate.listings l
     where l.source_id = ${sourceId} and l.status = 'active' and l.pin_manual
       and l.latitude is not null and l.longitude is not null and l.city_ref is not null
  ), shared as (
    select lat, lng from pins where street_ref is not null
     group by lat, lng having count(distinct street_ref) >= ${SHARED_PIN_MIN_STREETS}
  ), city_mid as (
    select city_ref,
           percentile_cont(0.5) within group (order by lat) as lat,
           percentile_cont(0.5) within group (order by lng) as lng
      from pins group by city_ref
  ), candidates as (
    select p.*
      from pins p
      join city_mid c on c.city_ref = p.city_ref
     where not exists (select 1 from shared s where s.lat = p.lat and s.lng = p.lng)
       and not ${nearPlaceholderSql(sql`p.lat`, sql`p.lng`)}
       and ${metersSql(sql`p.lat`, sql`p.lng`, sql`c.lat`, sql`c.lng`)} <= ${CITY_RADIUS_METERS}
  )`;
}

/**
 * Every poster-placed pin of an active listing, and why it is not a
 * candidate if it is not: the map's or an agency's default (`placeholder`),
 * or too far from its city (`broken`). With the listing's building fields
 * and whether ss.ge claims a metro for it.
 */
export function judgedPinsSql(sourceId: string): SQL {
  return sql`with ${candidatePinsSql(sourceId)}
    select p.id, p.lat, p.lng, p.street_ref, p.subdistrict_ref,
           l.complex_ref, l.house_number, l.house_suffix,
           (l.ss_metro is not null and l.ss_metro <> '{}'::jsonb) as has_claims,
           exists (select 1 from candidates c where c.id = p.id) as candidate,
           (exists (select 1 from shared s where s.lat = p.lat and s.lng = p.lng)
            or ${nearPlaceholderSql(sql`p.lat`, sql`p.lng`)}) as placeholder,
           ${metersSql(sql`p.lat`, sql`p.lng`, sql`m.lat`, sql`m.lng`)} > ${CITY_RADIUS_METERS} as broken
      from pins p
      join realestate.listings l on l.id = p.id
      join city_mid m on m.city_ref = p.city_ref`;
}
