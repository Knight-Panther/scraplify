import { eq, sql } from 'drizzle-orm';
import { realEstatePlaces } from '../../db/schema/index.js';
import type { DatabaseOrTransaction } from '../../db/types.js';
import {
  AREA_MEDIAN_MIN_PINS,
  candidatePinsSql,
  metersApart,
  metersSql,
  STREET_AREA_METERS,
  STREET_LOCATION_MIN_PINS,
  STREET_LOCATION_SUPPORT,
  TRUSTED_PIN_STREET_METERS,
} from '../location-rules.js';
import { nameKey, nameKeys, romanizedName } from '../place-lookup.js';
import type { CuratedPlaces } from './curated.js';
import { type OfficialMap, officialDistrictAt } from './official.js';

/**
 * The place catalogue on both maps (Phase 14B, contract C6), refreshed after
 * every run from the tree `syncPlaces` (src/realestate/places.ts) has just
 * built, the committed official map and the owner's names:
 * 1. Tbilisi's official districts, its metro stations (each under the
 *    official district its point is in) and the owner's neighbourhoods;
 * 2. English names on ss.ge's places, where the owner's file names the place
 *    by the id and the Georgian name it still has;
 * 3. each street point's official district;
 * 4. how each of ss.ge's Tbilisi districts and sub-districts overlaps the
 *    official districts, from its listings' street points, and how many
 *    listings each official district and station has;
 * 5. every place's match keys.
 *
 * Each step writes only the rows whose values differ, so a second refresh
 * writes nothing. It reads listings and writes `places` only, and makes no
 * request to ss.ge.
 */

/** ss.ge's id for Tbilisi, the city the official map covers. */
export const TBILISI_CITY_REF = 95;
/** Writes per statement. */
const CHUNK = 2_000;

/**
 * ss.ge places some streets by a namesake: Titsian Tabidze St in Vake carries
 * the point of Galaktion Tabidze St, 2.8 km away, on every one of its pages.
 * On 2026-11-08, 67 of the 245 Tbilisi streets with 3 or more poster-placed
 * pins had a point more than this from those pins' median; against
 * OpenStreetMap's lines, ss.ge's point was more than 500 m off its street for
 * 29% of streets. So a street is located by its own listings' candidate pins
 * when they agree (Phase 14C, `location-rules.ts`), and by ss.ge's point
 * otherwise, unless every one of its pins lies more than this from that point.
 */
export const STREET_POINT_DISPUTE_METERS = 1_000;

/** What a refresh found and wrote. */
export interface CatalogueRefresh {
  /** Official districts, stations and neighbourhoods held. */
  official: number;
  stations: number;
  neighbourhoods: number;
  /** ss.ge places whose English name was set or cleared. */
  named: number;
  /** Places the owner's file names whose Georgian name ss.ge has since changed: their English name is left off until the file is checked. */
  renamed: string[];
  /** Streets whose location or official district was set or changed. */
  streetsPlaced: number;
  /** Streets located by their own listings' pins. */
  streetsByPins: number;
  /** Streets whose own pins contradict ss.ge's point for them (namesakes): located by the pins, or, when the pins disagree among themselves too, not at all. */
  streetsDisputed: number;
  /** Streets whose pins or ss.ge point lie further from their sub-district's pin median than a pin may (namesakes picked by mistake): no location from them. */
  streetsFarFromArea: number;
  /** ss.ge districts and sub-districts whose overlaps changed. */
  sharesWritten: number;
  /** Places whose match keys or Latin name changed. */
  keysWritten: number;
}

export async function refreshPlaceCatalogue(
  db: DatabaseOrTransaction,
  input: { sourceId: string; at: string; map: OfficialMap; curated: CuratedPlaces },
): Promise<CatalogueRefresh> {
  const { sourceId, at, map, curated } = input;
  return db.transaction(async (tx) => {
    // 1. The official map's places, and the owner's.
    const officialRows = map.districts.map((district) => ({
      level: 'official_district',
      ref: district.ref,
      origin: 'osm',
      code: district.code,
      name_ka: district.nameKa,
      name_en: district.nameEn,
      parent_level: 'city',
      parent_ref: TBILISI_CITY_REF,
      latitude: null,
      longitude: null,
      official_district_ref: null,
      official_basis: null,
    }));
    const stationRows = map.stations.map((station) => {
      const place = officialDistrictAt(map, station.lat, station.lng);
      return {
        level: 'metro_station',
        ref: station.ref,
        origin: 'osm',
        code: station.code,
        name_ka: station.nameKa,
        name_en: station.nameEn,
        parent_level: place === null ? null : 'official_district',
        parent_ref: place?.district.ref ?? null,
        latitude: station.lat.toFixed(6),
        longitude: station.lng.toFixed(6),
        official_district_ref: place?.district.ref ?? null,
        official_basis: place?.basis ?? null,
      };
    });
    const neighbourhoodRows = curated.neighbourhoods.map((n) => ({
      level: 'neighbourhood',
      ref: n.ref,
      origin: 'owner',
      code: n.code,
      name_ka: n.nameKa,
      name_en: n.nameEn,
      parent_level: n.parentLevel,
      parent_ref: n.parentRef,
      latitude: null,
      longitude: null,
      official_district_ref: null,
      official_basis: null,
    }));
    const fixed = [...officialRows, ...stationRows, ...neighbourhoodRows];
    await tx.execute(sql`
      insert into ${realEstatePlaces} as p
        (source_id, level, ref, origin, code, name_ka, name_en, parent_level, parent_ref,
         latitude, longitude, point_status, point_checked_at,
         official_district_ref, official_basis, first_seen_at, last_seen_at)
      select ${sourceId}, r.level, r.ref, r.origin, r.code, r.name_ka, r.name_en,
             r.parent_level, r.parent_ref, r.latitude, r.longitude,
             case when r.latitude is null then 'unknown' else 'known' end,
             case when r.latitude is null then null else ${at}::timestamptz end,
             r.official_district_ref, r.official_basis, ${at}, ${at}
        from jsonb_to_recordset(${JSON.stringify(fixed)}::jsonb) as r(
          level text, ref integer, origin text, code text, name_ka text, name_en text,
          parent_level text, parent_ref integer, latitude numeric, longitude numeric,
          official_district_ref integer, official_basis text)
      on conflict (source_id, level, ref) do update set
        origin = excluded.origin,
        code = excluded.code,
        name_ka = excluded.name_ka,
        name_en = excluded.name_en,
        parent_level = excluded.parent_level,
        parent_ref = excluded.parent_ref,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        point_status = excluded.point_status,
        official_district_ref = excluded.official_district_ref,
        official_basis = excluded.official_basis,
        last_seen_at = excluded.last_seen_at
      where (p.origin, p.code, p.name_ka, p.name_en, p.parent_level, p.parent_ref, p.latitude,
             p.longitude, p.official_district_ref, p.official_basis)
            is distinct from
            (excluded.origin, excluded.code, excluded.name_ka, excluded.name_en,
             excluded.parent_level, excluded.parent_ref, excluded.latitude, excluded.longitude,
             excluded.official_district_ref, excluded.official_basis)
    `);

    // 2. English names on ss.ge's places: set where the owner's file names
    //    the place by its id and its current Georgian name, cleared elsewhere.
    const named = curated.places.map((p) => ({
      level: p.level,
      ref: p.ref,
      name_ka: p.nameKa,
      name_en: p.nameEn,
    }));
    const renamedRows = await tx.execute<{ level: string; ref: number; name_ka: string }>(sql`
      select p.level, p.ref, p.name_ka
        from ${realEstatePlaces} p
        join jsonb_to_recordset(${JSON.stringify(named)}::jsonb)
             as c(level text, ref integer, name_ka text, name_en text)
          on c.level = p.level and c.ref = p.ref
       where p.source_id = ${sourceId} and p.name_ka <> c.name_ka
    `);
    const englishNames = await tx.execute(sql`
      update ${realEstatePlaces} p
         set name_en = v.name_en
        from (
          select p0.level, p0.ref, c.name_en
            from ${realEstatePlaces} p0
            left join jsonb_to_recordset(${JSON.stringify(named)}::jsonb)
                 as c(level text, ref integer, name_ka text, name_en text)
              on c.level = p0.level and c.ref = p0.ref and c.name_ka = p0.name_ka
           where p0.source_id = ${sourceId} and p0.origin = 'ss.ge'
        ) v
       where p.source_id = ${sourceId} and p.level = v.level and p.ref = v.ref
         and p.name_en is distinct from v.name_en
    `);

    // 3. Each street's location (Phase 14C): the median of its listings'
    //    distinct candidate pin positions when they agree on it, else
    //    ss.ge's point unless those positions all contradict it; either only
    //    within reach of its sub-district's pin median (Phase 14D); and the
    //    official district that location is in.
    const streets = await tx.execute<{
      ref: number;
      latitude: string | null;
      longitude: string | null;
      located_latitude: string | null;
      located_longitude: string | null;
      located_basis: string | null;
      located_pins: number | null;
      official_district_ref: number | null;
      official_basis: string | null;
      official_source: string | null;
      pins: number | string;
      pin_lat: number | string | null;
      pin_lng: number | string | null;
      near_median: number | string;
      near_point: number | string;
      area_lat: number | string | null;
      area_lng: number | string | null;
    }>(sql`
      with ${candidatePinsSql(sourceId)}, positions as (
        select distinct street_ref, lat, lng from candidates where street_ref is not null
      ), medians as (
        select street_ref, count(*)::integer as n,
               percentile_cont(0.5) within group (order by lat) as lat,
               percentile_cont(0.5) within group (order by lng) as lng
          from positions group by street_ref
      ), agreement as (
        select p.street_ref,
               count(*) filter (
                 where ${metersSql(sql`p.lat`, sql`p.lng`, sql`m.lat`, sql`m.lng`)} <= ${TRUSTED_PIN_STREET_METERS}
               )::integer as near_median,
               count(*) filter (
                 where s.latitude is not null and s.longitude is not null
                   and ${metersSql(sql`p.lat`, sql`p.lng`, sql`s.latitude::float8`, sql`s.longitude::float8`)}
                       <= ${STREET_POINT_DISPUTE_METERS}
               )::integer as near_point
          from positions p
          join medians m on m.street_ref = p.street_ref
          join ${realEstatePlaces} s
            on s.source_id = ${sourceId} and s.level = 'street' and s.ref = p.street_ref
         group by p.street_ref
      ), area_positions as (
        select distinct subdistrict_ref, lat, lng from candidates where subdistrict_ref is not null
      ), areas as (
        -- A sub-district's pin median, as location.ts takes it for a pin.
        select subdistrict_ref,
               percentile_cont(0.5) within group (order by lat) as lat,
               percentile_cont(0.5) within group (order by lng) as lng
          from area_positions group by subdistrict_ref
        having count(*) >= ${AREA_MEDIAN_MIN_PINS}
      )
      select s.ref, s.latitude, s.longitude,
             s.located_latitude, s.located_longitude, s.located_basis, s.located_pins,
             s.official_district_ref, s.official_basis, s.official_source,
             coalesce(m.n, 0) as pins, m.lat as pin_lat, m.lng as pin_lng,
             coalesce(a.near_median, 0) as near_median, coalesce(a.near_point, 0) as near_point,
             ar.lat as area_lat, ar.lng as area_lng
        from ${realEstatePlaces} s
        left join medians m on m.street_ref = s.ref
        left join agreement a on a.street_ref = s.ref
        left join areas ar on s.parent_level = 'subdistrict' and ar.subdistrict_ref = s.parent_ref
       where s.source_id = ${sourceId} and s.level = 'street'
    `);
    let streetsByPins = 0;
    let streetsDisputed = 0;
    let streetsFarFromArea = 0;
    const placed = streets.rows.flatMap((street) => {
      const ssge =
        street.latitude === null || street.longitude === null
          ? null
          : { lat: Number(street.latitude), lng: Number(street.longitude) };
      const area =
        street.area_lat === null || street.area_lng === null
          ? null
          : { lat: Number(street.area_lat), lng: Number(street.area_lng) };
      // A namesake picked by mistake lands far from the street's own sub-district.
      const inReach = (point: { lat: number; lng: number }) =>
        area === null ||
        metersApart(point.lat, point.lng, area.lat, area.lng) <= STREET_AREA_METERS;
      const positions = Number(street.pins);
      const pinsAgree =
        positions >= STREET_LOCATION_MIN_PINS &&
        street.pin_lat !== null &&
        street.pin_lng !== null &&
        Number(street.near_median) >= Math.min(STREET_LOCATION_SUPPORT, positions);
      const pinsInReach =
        pinsAgree && inReach({ lat: Number(street.pin_lat), lng: Number(street.pin_lng) });
      if (pinsAgree && !pinsInReach) streetsFarFromArea++;
      const byPins = pinsInReach;
      let location: { lat: number; lng: number; basis: 'pins' | 'ss.ge'; pins: number } | null =
        null;
      if (byPins) {
        location = {
          lat: Number(street.pin_lat),
          lng: Number(street.pin_lng),
          basis: 'pins',
          pins: positions,
        };
        streetsByPins++;
        if (
          ssge !== null &&
          metersApart(ssge.lat, ssge.lng, location.lat, location.lng) > STREET_POINT_DISPUTE_METERS
        ) {
          streetsDisputed++;
        }
      } else if (ssge !== null) {
        // Pins that disagree among themselves can still all contradict ss.ge's point.
        if (positions > 0 && Number(street.near_point) === 0) streetsDisputed++;
        else if (!inReach(ssge)) {
          if (!pinsAgree) streetsFarFromArea++;
        } else location = { ...ssge, basis: 'ss.ge', pins: 0 };
      }
      const place = location === null ? null : officialDistrictAt(map, location.lat, location.lng);
      const next = {
        ref: street.ref,
        located_latitude: location === null ? null : location.lat.toFixed(6),
        located_longitude: location === null ? null : location.lng.toFixed(6),
        located_basis: location?.basis ?? null,
        located_pins: location?.pins ?? null,
        official_district_ref: place?.district.ref ?? null,
        official_basis: place?.basis ?? null,
        official_source: place === null ? null : (location?.basis ?? null),
      };
      const unchanged =
        next.located_latitude === street.located_latitude &&
        next.located_longitude === street.located_longitude &&
        next.located_basis === street.located_basis &&
        next.located_pins === street.located_pins &&
        next.official_district_ref === street.official_district_ref &&
        next.official_basis === street.official_basis &&
        next.official_source === street.official_source;
      return unchanged ? [] : [next];
    });
    for (let from = 0; from < placed.length; from += CHUNK) {
      await tx.execute(sql`
        update ${realEstatePlaces} p
           set located_latitude = c.located_latitude, located_longitude = c.located_longitude,
               located_basis = c.located_basis, located_pins = c.located_pins,
               official_district_ref = c.official_district_ref, official_basis = c.official_basis,
               official_source = c.official_source
          from jsonb_to_recordset(${JSON.stringify(placed.slice(from, from + CHUNK))}::jsonb)
               as c(ref integer, located_latitude numeric, located_longitude numeric,
                    located_basis text, located_pins integer, official_district_ref integer,
                    official_basis text, official_source text)
         where p.source_id = ${sourceId} and p.level = 'street' and p.ref = c.ref
      `);
    }

    // 4. Overlaps, from each active Tbilisi listing's street point, and
    //    listings per official district (by street point) and per station
    //    (ss.ge's own claim, from its pin, until 14C checks it).
    const shares = await tx.execute(sql`
      with located as (
        select l.district_ref, l.subdistrict_ref, o.code
          from realestate.listings l
          left join ${realEstatePlaces} s
            on s.source_id = l.source_id and s.level = 'street' and s.ref = l.street_ref
          left join ${realEstatePlaces} o
            on o.source_id = l.source_id and o.level = 'official_district'
           and o.ref = s.official_district_ref
         where l.source_id = ${sourceId} and l.status = 'active' and l.city_ref = ${TBILISI_CITY_REF}
      ), by_area as (
        select 'district' as level, district_ref as ref, code from located where district_ref is not null
        union all
        select 'subdistrict', subdistrict_ref, code from located where subdistrict_ref is not null
      ), per_code as (
        select level, ref, code, count(*)::integer as n from by_area group by level, ref, code
      ), areas as (
        select level, ref,
               jsonb_build_object(
                 'listings', sum(n)::integer,
                 'located', coalesce(sum(n) filter (where code is not null), 0)::integer,
                 'by_district', coalesce(jsonb_object_agg(code, n) filter (where code is not null), '{}'::jsonb)
               ) as shares
          from per_code
         group by level, ref
      )
      update ${realEstatePlaces} p
         set official_shares = areas.shares
        from areas
       where p.source_id = ${sourceId} and p.level = areas.level and p.ref = areas.ref
         and p.official_shares is distinct from areas.shares
    `);
    await tx.execute(sql`
      update ${realEstatePlaces} o
         set active_listings = c.n
        from (
          select o0.ref, count(l.id)::integer as n
            from ${realEstatePlaces} o0
            left join ${realEstatePlaces} s
              on s.source_id = o0.source_id and s.level = 'street' and s.official_district_ref = o0.ref
            left join realestate.listings l
              on l.source_id = s.source_id and l.street_ref = s.ref and l.status = 'active'
           where o0.source_id = ${sourceId} and o0.level = 'official_district'
           group by o0.ref
        ) c
       where o.source_id = ${sourceId} and o.level = 'official_district' and o.ref = c.ref
         and o.active_listings <> c.n
    `);
    await tx.execute(sql`
      update ${realEstatePlaces} st
         set active_listings = coalesce(c.n, 0)
        from ${realEstatePlaces} st0
        left join (
          select station as code, count(*)::integer as n
            from realestate.listings l
           cross join lateral jsonb_object_keys(l.ss_metro) as station
           where l.source_id = ${sourceId} and l.status = 'active' and l.ss_metro is not null
           group by station
        ) c on c.code = st0.code
       where st.source_id = ${sourceId} and st.level = 'metro_station'
         and st0.source_id = st.source_id and st0.level = st.level and st0.ref = st.ref
         and st.active_listings <> coalesce(c.n, 0)
    `);

    // 5. Match keys: every name's key, and the owner's aliases for the place
    //    while its Georgian name is still the one the file names. And the
    //    Georgian name in Latin letters, for showing where there is no
    //    English one.
    const aliasesOf = new Map(
      curated.places.map((p) => [`${p.level}:${p.ref}:${p.nameKa}`, p.aliases ?? []]),
    );
    const places = await tx.execute<{
      level: string;
      ref: number;
      name_ka: string;
      name_en: string | null;
      name_roman: string | null;
      aliases: string[];
      match_keys: string[];
    }>(sql`
      select level, ref, name_ka, name_en, name_roman, aliases, match_keys
        from ${realEstatePlaces}
       where source_id = ${sourceId}
    `);
    const rekeyed = places.rows.flatMap((place) => {
      const names = [
        place.name_ka,
        ...place.aliases,
        ...(place.name_en === null ? [] : [place.name_en]),
        ...(aliasesOf.get(`${place.level}:${place.ref}:${place.name_ka}`) ?? []),
      ];
      const keys = matchKeys(place.level, names);
      const roman = romanizedName(place.name_ka);
      const same =
        roman === place.name_roman &&
        keys.length === place.match_keys.length &&
        keys.every((k, i) => k === place.match_keys[i]);
      return same ? [] : [{ level: place.level, ref: place.ref, keys, roman }];
    });
    for (let from = 0; from < rekeyed.length; from += CHUNK) {
      await tx.execute(sql`
        update ${realEstatePlaces} p
           set match_keys = array(select jsonb_array_elements_text(c.keys)), name_roman = c.roman
          from jsonb_to_recordset(${JSON.stringify(rekeyed.slice(from, from + CHUNK))}::jsonb)
               as c(level text, ref integer, keys jsonb, roman text)
         where p.source_id = ${sourceId} and p.level = c.level and p.ref = c.ref
      `);
    }

    const [held] = await tx
      .select({
        official: sql<number>`count(*) filter (where ${realEstatePlaces.level} = 'official_district')::integer`,
        stations: sql<number>`count(*) filter (where ${realEstatePlaces.level} = 'metro_station')::integer`,
        neighbourhoods: sql<number>`count(*) filter (where ${realEstatePlaces.level} = 'neighbourhood')::integer`,
      })
      .from(realEstatePlaces)
      .where(eq(realEstatePlaces.sourceId, sourceId));
    return {
      official: held?.official ?? 0,
      stations: held?.stations ?? 0,
      neighbourhoods: held?.neighbourhoods ?? 0,
      named: englishNames.rowCount ?? 0,
      renamed: renamedRows.rows.map((row) => `${row.level} ${row.ref} is now ${row.name_ka}`),
      streetsPlaced: placed.length,
      streetsByPins,
      streetsDisputed,
      streetsFarFromArea,
      sharesWritten: shares.rowCount ?? 0,
      keysWritten: rekeyed.length,
    };
  });
}

/** The words that pick the official map, as keys. */
const DISTRICT_WORDS = new Set([nameKey('district'), nameKey('რაიონი')]);

/**
 * A place's match keys, sorted and unique. An official district is also
 * found by its name without the district word, and with either language's
 * word: "Isani", "ისნის რაიონი" and "isani raioni" all find Isani District.
 */
export function matchKeys(level: string, names: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const name of names) {
    const [key, ...variants] = nameKeys(name);
    if (key === undefined) continue;
    keys.add(key);
    for (const variant of variants) keys.add(variant);
    if (level !== 'official_district') continue;
    const words = key.split(' ');
    const last = words.at(-1);
    if (words.length < 2 || last === undefined || !DISTRICT_WORDS.has(last)) continue;
    const short = words.slice(0, -1).join(' ');
    keys.add(short);
    for (const word of DISTRICT_WORDS) keys.add(`${short} ${word}`);
  }
  return [...keys].sort();
}
