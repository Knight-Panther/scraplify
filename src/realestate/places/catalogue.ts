import { eq, sql } from 'drizzle-orm';
import { realEstatePlaces } from '../../db/schema/index.js';
import type { DatabaseOrTransaction } from '../../db/types.js';
import { nameKey } from '../place-lookup.js';
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
  /** Streets whose official district was set or changed. */
  streetsPlaced: number;
  /** ss.ge districts and sub-districts whose overlaps changed. */
  sharesWritten: number;
  /** Places whose match keys changed. */
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

    // 3. Each street point's official district.
    const streets = await tx.execute<{
      ref: number;
      latitude: string | null;
      longitude: string | null;
      official_district_ref: number | null;
      official_basis: string | null;
    }>(sql`
      select ref, latitude, longitude, official_district_ref, official_basis
        from ${realEstatePlaces}
       where source_id = ${sourceId} and level = 'street'
    `);
    const placed = streets.rows.flatMap((street) => {
      const place =
        street.latitude === null || street.longitude === null
          ? null
          : officialDistrictAt(map, Number(street.latitude), Number(street.longitude));
      const ref = place?.district.ref ?? null;
      const basis = place?.basis ?? null;
      return ref === street.official_district_ref && basis === street.official_basis
        ? []
        : [{ ref: street.ref, official_district_ref: ref, official_basis: basis }];
    });
    for (let from = 0; from < placed.length; from += CHUNK) {
      await tx.execute(sql`
        update ${realEstatePlaces} p
           set official_district_ref = c.official_district_ref, official_basis = c.official_basis
          from jsonb_to_recordset(${JSON.stringify(placed.slice(from, from + CHUNK))}::jsonb)
               as c(ref integer, official_district_ref integer, official_basis text)
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
    //    while its Georgian name is still the one the file names.
    const aliasesOf = new Map(
      curated.places.map((p) => [`${p.level}:${p.ref}:${p.nameKa}`, p.aliases ?? []]),
    );
    const places = await tx.execute<{
      level: string;
      ref: number;
      name_ka: string;
      name_en: string | null;
      aliases: string[];
      match_keys: string[];
    }>(sql`
      select level, ref, name_ka, name_en, aliases, match_keys
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
      const same =
        keys.length === place.match_keys.length && keys.every((k, i) => k === place.match_keys[i]);
      return same ? [] : [{ level: place.level, ref: place.ref, keys }];
    });
    for (let from = 0; from < rekeyed.length; from += CHUNK) {
      await tx.execute(sql`
        update ${realEstatePlaces} p
           set match_keys = array(select jsonb_array_elements_text(c.keys))
          from jsonb_to_recordset(${JSON.stringify(rekeyed.slice(from, from + CHUNK))}::jsonb)
               as c(level text, ref integer, keys jsonb)
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
    const key = nameKey(name);
    if (key === '') continue;
    keys.add(key);
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
