import { type SQL, sql } from 'drizzle-orm';

/**
 * The rules that judge where a listing is (Phase 14C, docs/PHASE_14_PLAN.md,
 * 14C). Calibrated on the first night of 14A's data (2026-11-08) against
 * ground truth: OpenStreetMap's own line for each Tbilisi street of the same
 * name (1,225 of 1,430 streets matched), fetched once and never shipped. Of
 * 2,868 poster-placed Tbilisi pins, 87% lie within 100 m of their street's
 * line and 5% more than 300 m from it, while ss.ge's own point for a street
 * is more than 500 m off its line for 29% of streets (38% of those with no
 * pin). So a street's own pins locate it before ss.ge's point does, and a pin
 * is never judged against ss.ge's point. A change raises
 * `LOCATION_RULES_VERSION`, and the next refresh judges every listing again:
 * the raw evidence (pins, ss.ge's claims) is kept, and nothing derived is
 * hashed, so it costs no churn.
 *
 * Version 2 (Phase 14D) changes no rule: it adds each nearby station's band
 * (`metro_nearby_minutes`), so every listing gets one.
 */
export const LOCATION_RULES_VERSION = 2;

/**
 * A street is located by its own listings' pins from this many distinct
 * positions. Positions, not pins, and each position counts once in every
 * median here: one flat reposted three times is one place. Even one position
 * beats ss.ge's point: where the two were more than 500 m apart, the pin lay
 * on the street 60 times and ss.ge's point 4 times (2026-11-08); a street's
 * single position was on its line for 89% of streets, its 6 or more
 * positions' median for 94%.
 */
export const STREET_LOCATION_MIN_PINS = 1;

/**
 * The median must sit where the street's pins agree: at least this many of
 * its positions (all of them, when it has fewer) within
 * `TRUSTED_PIN_STREET_METERS` of it. Scattered positions have a median near
 * none of them: one street's 8 positions spread over 12 km gave a point 4 km
 * from the nearest (13 of 191 pin-located streets, 1,088 listings, on
 * 2026-11-08). Such a street falls back to ss.ge's point, unless its
 * positions all contradict that too.
 */
export const STREET_LOCATION_SUPPORT = 2;

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
 * A candidate pin is trusted within this of its street's location (when the
 * street is located by pins): between the 75th (549 m) and 90th (1,325 m)
 * percentile of a street's own pins around their median (2026-11-08). 1 km
 * instead trusted 12 more pins off their street to stop 32 false alarms.
 */
export const TRUSTED_PIN_STREET_METERS = 600;

/**
 * A street is a line, not a point: a pin further than that from its street's
 * middle is still trusted when at least this many other distinct positions on
 * the same street lie within the same distance of it. Against OSM's lines
 * (2026-11-08), a pin with no other position of its street within 600 m was
 * off its street 13% of the time, with one or more 2-5%; one neighbour
 * instead of two trusted 7 more wrong pins and stopped 77 false alarms.
 */
export const STREET_NEIGHBOUR_PINS = 1;

/**
 * A pin whose street is not located by pins (only ss.ge's point, or nothing)
 * is trusted within this of its sub-district's pin median. Pins on their
 * street sat a median 954 m from it (90% within 2.8 km), pins off it 1.2 km
 * (90% within 5.2 km): only the gross errors are caught here. 5 km instead
 * of 3 trusted 2 more wrong pins and stopped 22 false alarms (2026-11-08).
 */
export const TRUSTED_PIN_AREA_METERS = 5_000;

/** A sub-district's pin median needs this many candidate pins. */
export const AREA_MEDIAN_MIN_PINS = 3;

/**
 * A street's location, from its pins or ss.ge's point, must lie within this
 * of its sub-district's pin median, as a pin must (Phase 14D, 2026-11-12).
 * ss.ge's street ids repeat names across the city, and a poster can pick the
 * wrong namesake: ტარიელის ქ. under Didi Dighomi was located by three agreeing
 * pins on central Tarieli St, 10 km away, and its 115 listings showed
 * Rustaveli's metro. Against OSM's lines on production (791 Tbilisi streets
 * checkable), 44 streets sat on a namesake, all more than 1.5 km from their
 * area: 5 km drops 34 of them (1,724 listings) and 10 streets OSM shows on
 * their own line (857 listings); 3 km would drop 42 and 27 (5,544, among
 * them University St and Gelovani Ave in the wide Saburtalo). Losing a
 * street's location costs precision; keeping a namesake states a wrong
 * district and metro.
 */
export const STREET_AREA_METERS = TRUSTED_PIN_AREA_METERS;

/**
 * A sub-district gives its listings an official district (basis `area`) when
 * at least this many of its distinct trusted positions lie in official
 * districts, and this share of them in one (below 20 positions, all of them).
 * Against the district of each listing's street on OSM (2026-11-08): 10
 * positions placed 9 sub-districts and 6.5% of the checkable listings wrong,
 * 20 placed 3 and 9.2% wrong.
 */
export const AREA_MIN_TRUSTED_PINS = 10;
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
  /** Each of `nearby`'s bands, in the same order (Phase 14D). */
  nearbyMinutes: number[];
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
    ? { station: null, minutes: null, distanceM: null, nearby: [], nearbyMinutes: [] }
    : {
        station: nearest.code,
        minutes: metroMinutes(nearest.meters),
        distanceM:
          Math.round(nearest.meters / METRO_DISTANCE_STEP_METERS) * METRO_DISTANCE_STEP_METERS,
        nearby: near.map((station) => station.code),
        nearbyMinutes: near.map((station) => metroMinutes(station.meters) as number),
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
