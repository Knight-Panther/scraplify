import { sql } from 'drizzle-orm';
import { realEstatePlaces } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import {
  AREA_MEDIAN_MIN_PINS,
  AREA_MIN_SHARE,
  AREA_MIN_TRUSTED_PINS,
  buildingKey,
  buildingKeySql,
  judgedPinsSql,
  LOCATION_RULES_VERSION,
  type LocationFlag,
  type MetroNear,
  median,
  metersApart,
  metroNear,
  STREET_NEIGHBOUR_PINS,
  TRUSTED_PIN_AREA_METERS,
  TRUSTED_PIN_STREET_METERS,
  UNCERTAIN_FLAGS,
} from './location-rules.js';
import { type OfficialMap, officialDistrictAt } from './places/official.js';

/**
 * Where each active listing is, judged (Phase 14C, docs/PHASE_14_PLAN.md):
 * its official district and what that rests on, how precisely it is
 * located, whether its pin or ss.ge's metro claim contradicts the rest, our
 * own metro, and its building. Refreshed after the place catalogue at the end
 * of every run (`refreshPlaceCatalogue` locates the streets first).
 *
 * Only the poster-placed pins, a few thousand, are judged in TypeScript;
 * everything else is one set-based statement per sixteenth of the listings,
 * which writes only the rows whose derived values differ. So a second
 * refresh writes nothing, and a rules change (`LOCATION_RULES_VERSION`)
 * judges every listing again. It reads `places` and writes listings only,
 * and makes no request to ss.ge.
 */
export interface LocationRefresh {
  /** Poster-placed pins judged, and how many of them are trusted. */
  pins: number;
  trusted: number;
  /** Of the pins, those with a flag: a default, broken, or far from their street or area. */
  flagged: number;
  /** Sub-districts whose trusted pins give their listings an official district. */
  areas: number;
  /** Listings whose derived location was written. */
  written: number;
}

interface JudgedPin {
  id: string;
  trusted: boolean;
  street_m: number | null;
  district: number | null;
  flags: LocationFlag[];
  metro_station: string | null;
  metro_minutes: number | null;
  metro_distance: number | null;
  metro_nearby: string[] | null;
}

/** A metro answer flattened for SQL, with the key it is joined on. */
function metroColumns(metro: MetroNear | null) {
  return {
    metro_station: metro?.station ?? null,
    metro_minutes: metro?.minutes ?? null,
    metro_distance: metro?.distanceM ?? null,
    metro_nearby: metro?.nearby ?? null,
  };
}

const HEX = '0123456789abcdef';

interface Point {
  lat: number;
  lng: number;
}

function positionKey(point: Point): string {
  return `${point.lat},${point.lng}`;
}

/** Adds a point to its group's distinct positions; a null key is no group. */
function addPosition<K>(groups: Map<K, Map<string, Point>>, key: K | null, point: Point): void {
  if (key === null) return;
  const positions = groups.get(key) ?? new Map<string, Point>();
  positions.set(positionKey(point), { lat: point.lat, lng: point.lng });
  groups.set(key, positions);
}

function medianPoint(positions: Map<string, Point>): Point {
  const points = [...positions.values()];
  return { lat: median(points.map((p) => p.lat)), lng: median(points.map((p) => p.lng)) };
}

/** Other distinct positions of the same street within `TRUSTED_PIN_STREET_METERS` of a pin. */
function neighbours(positions: Map<string, Point> | undefined, pin: Point): number {
  let near = 0;
  for (const [key, other] of positions ?? []) {
    if (key === positionKey(pin)) continue;
    if (metersApart(pin.lat, pin.lng, other.lat, other.lng) <= TRUSTED_PIN_STREET_METERS) near++;
  }
  return near;
}

export async function refreshListingLocations(
  db: DatabaseOrTransaction,
  input: { sourceId: string; map: OfficialMap },
): Promise<LocationRefresh> {
  const { sourceId, map } = input;
  const stations = map.stations;

  // Streets with a location (the catalogue's step 3).
  const streetRows = await db.execute<{
    ref: number;
    lat: string;
    lng: string;
    district: number | null;
    basis: 'pins' | 'ss.ge';
  }>(sql`
    select ref, located_latitude as lat, located_longitude as lng, official_district_ref as district,
           located_basis as basis
      from ${realEstatePlaces}
     where source_id = ${sourceId} and level = 'street' and located_basis is not null
  `);
  const streets = new Map(
    streetRows.rows.map((row) => [
      row.ref,
      { lat: Number(row.lat), lng: Number(row.lng), district: row.district, basis: row.basis },
    ]),
  );

  // Every poster-placed pin, and whether it is a candidate.
  const pinRows = await db.execute<{
    id: string;
    lat: number;
    lng: number;
    street_ref: number | null;
    subdistrict_ref: number | null;
    complex_ref: number | null;
    house_number: number | null;
    house_suffix: string | null;
    has_claims: boolean;
    candidate: boolean;
    placeholder: boolean;
    broken: boolean;
  }>(judgedPinsSql(sourceId));
  const pins = pinRows.rows.map((row) => ({ ...row, lat: Number(row.lat), lng: Number(row.lng) }));

  // Distinct candidate positions per street and per sub-district: a flat
  // reposted three times is one place, in every count and median below.
  const streetPositions = new Map<number, Map<string, Point>>();
  const areaPositions = new Map<number, Map<string, Point>>();
  for (const pin of pins) {
    if (!pin.candidate) continue;
    addPosition(streetPositions, pin.street_ref, pin);
    addPosition(areaPositions, pin.subdistrict_ref, pin);
  }
  const areaMedians = new Map<number, Point>();
  for (const [ref, positions] of areaPositions) {
    if (positions.size >= AREA_MEDIAN_MIN_PINS) areaMedians.set(ref, medianPoint(positions));
  }

  // Judge each pin.
  const judged: JudgedPin[] = [];
  const buildings = new Map<string, Map<string, Point>>();
  const trustedByArea = new Map<number, Map<string, number | null>>();
  for (const pin of pins) {
    const street = pin.street_ref === null ? undefined : streets.get(pin.street_ref);
    const streetM =
      street === undefined
        ? null
        : Math.round(metersApart(pin.lat, pin.lng, street.lat, street.lng));
    const flags: LocationFlag[] = [];
    let trusted = false;
    let district: number | null = null;
    if (!pin.candidate) {
      if (pin.placeholder) flags.push('pin_placeholder');
      else if (pin.broken) flags.push('pin_broken');
    } else {
      district = officialDistrictAt(map, pin.lat, pin.lng)?.district.ref ?? null;
      const area = pin.subdistrict_ref === null ? undefined : areaMedians.get(pin.subdistrict_ref);
      // Only a street its own pins locate judges a pin: ss.ge's point is off
      // its street more often than a poster's pin is (location-rules.ts).
      if (street?.basis === 'pins' && streetM !== null) {
        trusted =
          streetM <= TRUSTED_PIN_STREET_METERS ||
          neighbours(streetPositions.get(pin.street_ref as number), pin) >= STREET_NEIGHBOUR_PINS;
        if (!trusted) flags.push('pin_far_from_street');
      } else if (area !== undefined) {
        trusted = metersApart(pin.lat, pin.lng, area.lat, area.lng) <= TRUSTED_PIN_AREA_METERS;
        if (!trusted) flags.push('pin_far_from_area');
      }
    }
    if (pin.has_claims && flags.length > 0) flags.push('metro_from_untrusted_pin');
    judged.push({
      id: pin.id,
      trusted,
      street_m: streetM,
      district,
      flags,
      ...metroColumns(trusted ? metroNear(stations, pin.lat, pin.lng) : null),
    });
    if (!trusted) continue;
    addPosition(
      buildings,
      buildingKey({
        complexRef: pin.complex_ref,
        streetRef: pin.street_ref,
        houseNumber: pin.house_number,
        houseSuffix: pin.house_suffix,
      }),
      pin,
    );
    if (pin.subdistrict_ref !== null) {
      const positions = trustedByArea.get(pin.subdistrict_ref) ?? new Map<string, number | null>();
      positions.set(positionKey(pin), district);
      trustedByArea.set(pin.subdistrict_ref, positions);
    }
  }

  // A sub-district whose trusted positions lie almost all in one official district.
  const areas: { ref: number; district: number }[] = [];
  for (const [ref, positions] of trustedByArea) {
    const byDistrict = new Map<number, number>();
    for (const district of positions.values()) {
      if (district !== null) byDistrict.set(district, (byDistrict.get(district) ?? 0) + 1);
    }
    const [top] = [...byDistrict].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    if (
      top !== undefined &&
      positions.size >= AREA_MIN_TRUSTED_PINS &&
      top[1] >= AREA_MIN_SHARE * positions.size
    ) {
      areas.push({ ref, district: top[0] });
    }
  }

  const streetsJson = JSON.stringify(
    [...streets].map(([ref, street]) => ({
      ref,
      district: street.district,
      ...metroColumns(metroNear(stations, street.lat, street.lng)),
    })),
  );
  const buildingsJson = JSON.stringify(
    [...buildings].map(([key, building]) => {
      const middle = medianPoint(building);
      return { key, ...metroColumns(metroNear(stations, middle.lat, middle.lng)) };
    }),
  );
  const areasJson = JSON.stringify(areas);

  let written = 0;
  for (const [at, hex] of [...HEX].entries()) {
    const low = `${hex}0000000-0000-0000-0000-000000000000`;
    const next = HEX[at + 1];
    const high = next === undefined ? null : `${next}0000000-0000-0000-0000-000000000000`;
    const pinsJson = JSON.stringify(judged.filter((pin) => pin.id.startsWith(hex)));
    const result = await db.execute(sql`
      with p as (
        select * from jsonb_to_recordset(${pinsJson}::jsonb) as p(
          id uuid, trusted boolean, street_m integer, district integer, flags text[],
          metro_station text, metro_minutes smallint, metro_distance integer, metro_nearby text[])
      ), s as (
        select * from jsonb_to_recordset(${streetsJson}::jsonb) as s(
          ref integer, district integer,
          metro_station text, metro_minutes smallint, metro_distance integer, metro_nearby text[])
      ), b as (
        select * from jsonb_to_recordset(${buildingsJson}::jsonb) as b(
          key text, metro_station text, metro_minutes smallint, metro_distance integer, metro_nearby text[])
      ), a as (
        select * from jsonb_to_recordset(${areasJson}::jsonb) as a(ref integer, district integer)
      ), l as (
        select l.id, l.street_ref, l.subdistrict_ref, l.district_ref, l.city_ref, l.municipality_ref,
               l.house_number, l.street_number, l.district_inferred, l.latitude,
               ${buildingKeySql(sql`l`)} as building_key
          from realestate.listings l
         where l.source_id = ${sourceId} and l.status = 'active'
           and l.id >= ${low}::uuid ${high === null ? sql`` : sql`and l.id < ${high}::uuid`}
      ), d as (
        select l.id, l.building_key,
               case when p.trusted and p.district is not null then p.district
                    when s.district is not null then s.district
                    else a.district end as official_district_ref,
               case when p.trusted and p.district is not null then 'pin'
                    when s.district is not null then 'street'
                    when a.district is not null then 'area' end as official_district_basis,
               case when p.trusted then 'pin'
                    when s.ref is not null and l.house_number is not null then 'house'
                    when s.ref is not null then 'street'
                    when l.subdistrict_ref is not null then 'subdistrict'
                    when l.district_ref is not null then 'district'
                    when l.city_ref is not null then 'city'
                    when l.municipality_ref is not null then 'municipality'
                    else 'none' end as location_precision,
               coalesce(p.flags, '{}'::text[])
                 || case when l.street_number ~ '[1-9]' and l.house_number is null
                         then array['house_number_junk'] else '{}'::text[] end
                 || case when l.district_inferred then array['district_inferred'] else '{}'::text[] end
                 as location_flags,
               case when p.trusted then 'pin' when b.key is not null then 'building'
                    when s.ref is not null then 'street' end as metro_basis,
               case when p.trusted then p.metro_station when b.key is not null then b.metro_station
                    else s.metro_station end as metro_station,
               case when p.trusted then p.metro_minutes when b.key is not null then b.metro_minutes
                    else s.metro_minutes end as metro_minutes,
               case when p.trusted then p.metro_distance when b.key is not null then b.metro_distance
                    else s.metro_distance end as metro_distance_m,
               case when p.trusted then p.metro_nearby when b.key is not null then b.metro_nearby
                    else s.metro_nearby end as metro_nearby,
               case when l.latitude is null then null else coalesce(p.trusted, false) end as pin_trusted,
               p.street_m as pin_street_m,
               p.district as pin_official_district_ref
          from l
          left join p on p.id = l.id
          left join s on s.ref = l.street_ref
          left join b on b.key = l.building_key
          left join a on a.ref = l.subdistrict_ref
      ), e as (
        select d.*, d.location_flags && ${sql.raw(`array['${UNCERTAIN_FLAGS.join("','")}']`)}::text[]
                    as location_uncertain
          from d
      )
      update realestate.listings t
         set official_district_ref = e.official_district_ref,
             official_district_basis = e.official_district_basis,
             location_precision = e.location_precision,
             location_uncertain = e.location_uncertain,
             location_flags = e.location_flags,
             metro_station = e.metro_station,
             metro_minutes = e.metro_minutes,
             metro_basis = e.metro_basis,
             metro_nearby = e.metro_nearby,
             building_key = e.building_key,
             location_rules = ${LOCATION_RULES_VERSION},
             pin_trusted = e.pin_trusted,
             pin_street_m = e.pin_street_m,
             pin_official_district_ref = e.pin_official_district_ref,
             metro_distance_m = e.metro_distance_m
        from e
       where t.id = e.id
         and (t.official_district_ref, t.official_district_basis, t.location_precision,
              t.location_uncertain, t.location_flags, t.metro_station, t.metro_minutes,
              t.metro_basis, t.metro_nearby, t.building_key, t.location_rules, t.pin_trusted,
              t.pin_street_m, t.pin_official_district_ref, t.metro_distance_m)
             is distinct from
             (e.official_district_ref, e.official_district_basis, e.location_precision,
              e.location_uncertain, e.location_flags, e.metro_station, e.metro_minutes,
              e.metro_basis, e.metro_nearby, e.building_key, ${LOCATION_RULES_VERSION}::smallint,
              e.pin_trusted, e.pin_street_m, e.pin_official_district_ref, e.metro_distance_m)
    `);
    written += result.rowCount ?? 0;
  }

  return {
    pins: pins.length,
    trusted: judged.filter((pin) => pin.trusted).length,
    flagged: judged.filter((pin) => pin.flags.length > 0).length,
    areas: areas.length,
    written,
  };
}
