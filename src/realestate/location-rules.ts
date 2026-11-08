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
  const placeholderLat = PLACEHOLDER_METERS / METERS_PER_DEGREE;
  const placeholderLng =
    PLACEHOLDER_METERS / (METERS_PER_DEGREE * Math.cos((PLACEHOLDER_PIN.latitude * Math.PI) / 180));
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
       and not (abs(p.lat - ${PLACEHOLDER_PIN.latitude}) < ${placeholderLat}
                and abs(p.lng - ${PLACEHOLDER_PIN.longitude}) < ${placeholderLng})
       and ${metersSql(sql`p.lat`, sql`p.lng`, sql`c.lat`, sql`c.lng`)} <= ${CITY_RADIUS_METERS}
  )`;
}
