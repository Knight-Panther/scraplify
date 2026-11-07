import { and, eq, sql } from 'drizzle-orm';
import { realEstatePlaces } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import { parseHouseNumber } from './address.js';
import type { PlaceLevel } from './kinds.js';

/**
 * A source's place tree (`realestate.places`, Phase 14A): what its listings
 * say about where they are, kept once per place instead of on every listing.
 */

/** Each sub-district's district, as the source itself states it. */
export type DistrictParents = ReadonlyMap<number, { ref: number; name: string }>;

interface DistrictFields {
  districtRef: number | null;
  districtName: string | null;
  subdistrictRef: number | null;
}

/**
 * Fills a district the source left out from its sub-district's: ss.ge gives
 * none on its oldest listings (about 1,200 live, first posted 2023-10 to
 * 2024-07), while every sub-district sits in one district. Applied the same
 * way to a results row and to the stored row it is compared with
 * (`upsertListing`), so a fill never counts as a change.
 */
export function inferDistrict<T extends DistrictFields>(
  fields: T,
  parents: DistrictParents,
): { fields: T; inferred: boolean } {
  if (fields.districtRef !== null || fields.districtName !== null) {
    return { fields, inferred: false };
  }
  const parent = fields.subdistrictRef === null ? undefined : parents.get(fields.subdistrictRef);
  if (parent === undefined) return { fields, inferred: false };
  return {
    fields: { ...fields, districtRef: parent.ref, districtName: parent.name },
    inferred: true,
  };
}

/** Each sub-district's district, from the place tree. */
export async function loadDistrictParents(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<DistrictParents> {
  const rows = await db.execute<{ subdistrict: number; district: number; name: string }>(sql`
    select s.ref as subdistrict, d.ref as district, d.name_ka as name
      from ${realEstatePlaces} s
      join ${realEstatePlaces} d
        on d.source_id = s.source_id and d.level = 'district' and d.ref = s.parent_ref
     where s.source_id = ${sourceId}
       and s.level = 'subdistrict'
       and s.parent_level = 'district'
  `);
  return new Map(
    rows.rows.map((row) => [
      Number(row.subdistrict),
      { ref: Number(row.district), name: row.name },
    ]),
  );
}

/** One level of the tree: its ref, name and parent columns on a listing, and what its parent may be. */
interface LevelSource {
  level: PlaceLevel;
  ref: string;
  name: string;
  /** The parent's level and ref column, most specific first; the first one a listing has is its parent. */
  parents: ReadonlyArray<{ level: PlaceLevel; ref: string }>;
  /** Only listings where the source stated the parent itself count for it. */
  statedOnly?: string;
  /** Only these listings name the place at all. */
  namedBy?: string;
}

/**
 * The tree's levels as listings carry them. A district's parent is its city;
 * a sub-district's is its district, or its city where it has none; a street's
 * is its sub-district, or its city; a city's is its municipality, which only
 * a listing's own page states (settlements outside the main cities).
 * A district filled in by `inferDistrict` never counts as the source's word.
 */
const LEVELS: readonly LevelSource[] = [
  { level: 'municipality', ref: 'municipality_ref', name: 'municipality_name', parents: [] },
  {
    level: 'city',
    ref: 'city_ref',
    name: 'city_name',
    parents: [{ level: 'municipality', ref: 'municipality_ref' }],
  },
  {
    level: 'district',
    ref: 'district_ref',
    name: 'district_name',
    parents: [{ level: 'city', ref: 'city_ref' }],
    // A filled-in district is the tree's own word, never evidence for it.
    namedBy: 'not district_inferred',
  },
  {
    level: 'subdistrict',
    ref: 'subdistrict_ref',
    name: 'subdistrict_name',
    parents: [
      { level: 'district', ref: 'district_ref' },
      { level: 'city', ref: 'city_ref' },
    ],
    statedOnly: 'not district_inferred',
  },
  {
    level: 'street',
    ref: 'street_ref',
    name: 'street_name',
    parents: [
      { level: 'subdistrict', ref: 'subdistrict_ref' },
      { level: 'city', ref: 'city_ref' },
    ],
  },
];

/** How specific a parent level is: smaller is more specific. */
const SPECIFICITY = (column: string) =>
  sql.raw(`array_position(array['subdistrict', 'district', 'city', 'municipality'], ${column})`);
/** The stored parent stays when tonight's listings name none, or only a vaguer one. */
const KEEPS_PARENT = sql`excluded.parent_level is null or (p.parent_level is not null and ${SPECIFICITY('p.parent_level')} < ${SPECIFICITY('excluded.parent_level')})`;

/**
 * The place tree from the source's active listings, once a run is over:
 * every place they name, by the name most of them give it, under the parent
 * most of them give it, with how many name it. A place renamed keeps its old
 * name as an alias. A place no active listing names any more keeps its row,
 * with no listings. Its street points are left alone (`recordStreetPoint`).
 *
 * Returns how many places each level gained: a sudden jump is the source
 * renumbering its places.
 */
export async function syncPlaces(
  db: DatabaseOrTransaction,
  input: { sourceId: string; at: string },
): Promise<Record<PlaceLevel, number>> {
  const added = {} as Record<PlaceLevel, number>;
  await db.transaction(async (tx) => {
    await tx
      .update(realEstatePlaces)
      .set({ activeListings: 0 })
      .where(eq(realEstatePlaces.sourceId, input.sourceId));
    for (const level of LEVELS) {
      const ref = sql.identifier(level.ref);
      const name = sql.identifier(level.name);
      const parentLevel =
        level.parents.length === 0
          ? sql`null::text`
          : sql.raw(
              `case ${level.parents.map((p) => `when ${p.ref} is not null then '${p.level}'`).join(' ')} end`,
            );
      const parentRef =
        level.parents.length === 0
          ? sql`null::integer`
          : sql.raw(`coalesce(${level.parents.map((p) => p.ref).join(', ')})`);
      const stated = level.statedOnly === undefined ? sql`true` : sql.raw(level.statedOnly);
      const namedBy = level.namedBy === undefined ? sql`true` : sql.raw(level.namedBy);
      const rows = await tx.execute<{ inserted: boolean }>(sql`
        with named as (
          select ${ref} as ref, ${name} as name,
                 case when ${stated} then ${parentLevel} end as parent_level,
                 case when ${stated} then ${parentRef} end as parent_ref
            from realestate.listings
           where source_id = ${input.sourceId} and status = 'active' and ${ref} is not null
             and ${namedBy}
        ), places as (
          select ref,
                 mode() within group (order by name) filter (where name is not null) as name,
                 count(*)::integer as listings
            from named
           group by ref
        ), parents as (
          -- The most specific parent any listing gives, then the most common:
          -- a sub-district's district wins over the city its legacy listings
          -- (no district at all) would give it.
          select distinct on (ref) ref, parent_level, parent_ref
            from named
           where parent_ref is not null
           group by ref, parent_level, parent_ref
           order by ref, ${SPECIFICITY('parent_level')}, count(*) desc, parent_ref
        )
        insert into ${realEstatePlaces} as p
          (source_id, level, ref, parent_level, parent_ref, name_ka, active_listings, first_seen_at, last_seen_at)
        select ${input.sourceId}, ${level.level}, places.ref, parents.parent_level, parents.parent_ref,
               places.name, places.listings, ${input.at}, ${input.at}
          from places
          left join parents using (ref)
         where places.name is not null
        on conflict (source_id, level, ref) do update set
          aliases = case
            when p.name_ka <> excluded.name_ka and not p.name_ka = any(p.aliases)
              then array_append(p.aliases, p.name_ka)
            else p.aliases
          end,
          name_ka = excluded.name_ka,
          -- Never a vaguer parent than the one held (a night when only a
          -- sub-district's legacy listings are active names just its city).
          parent_level = case when ${KEEPS_PARENT} then p.parent_level else excluded.parent_level end,
          parent_ref = case when ${KEEPS_PARENT} then p.parent_ref else excluded.parent_ref end,
          active_listings = excluded.active_listings,
          last_seen_at = excluded.last_seen_at
        returning (xmax = 0) as inserted
      `);
      added[level.level] = rows.rows.filter((row) => row.inserted).length;
    }
  });
  return added;
}

const BACKFILL_READ = 5_000;
const BACKFILL_WRITE = 1_000;

/**
 * What a sighting writes, for rows no results page shows again soon (Phase
 * 14A's deploy, `npm run places:ss-ge -- --backfill`): each stored house
 * number read again (`parseHouseNumber`), and the districts the source left
 * out filled from the tree by the rule `upsertListing` uses (`inferDistrict`),
 * so neither is ever taken for a change. Rows of every status: a gone row is
 * archived as it stands. No request to the source.
 */
export async function backfillStoredListings(
  db: DatabaseOrTransaction,
  input: { sourceId: string },
): Promise<{ houseNumbers: number; districts: number }> {
  let houseNumbers = 0;
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const page = await db.execute<{
      id: string;
      street_number: string | null;
      house_number: number | null;
      house_suffix: string | null;
    }>(sql`
      select id, street_number, house_number, house_suffix
        from realestate.listings
       where source_id = ${input.sourceId} and id > ${after}::uuid
       order by id
       limit ${BACKFILL_READ}
    `);
    const last = page.rows.at(-1);
    if (last === undefined) break;
    after = last.id;
    const changes = page.rows.flatMap((row) => {
      const parsed = parseHouseNumber(row.street_number);
      return parsed.houseNumber === row.house_number && parsed.houseSuffix === row.house_suffix
        ? []
        : [{ id: row.id, ...parsed }];
    });
    for (let at = 0; at < changes.length; at += BACKFILL_WRITE) {
      const values = sql.join(
        changes
          .slice(at, at + BACKFILL_WRITE)
          .map(
            (change) =>
              sql`(${change.id}::uuid, ${change.houseNumber}::integer, ${change.houseSuffix}::text)`,
          ),
        sql`, `,
      );
      await db.execute(sql`
        update realestate.listings l
           set house_number = v.house_number, house_suffix = v.house_suffix
          from (values ${values}) as v(id, house_number, house_suffix)
         where l.id = v.id
      `);
    }
    houseNumbers += changes.length;
  }

  const filled = await db.execute(sql`
    update realestate.listings l
       set district_ref = d.ref, district_name = d.name_ka, district_inferred = true
      from ${realEstatePlaces} s
      join ${realEstatePlaces} d
        on d.source_id = s.source_id and d.level = 'district' and d.ref = s.parent_ref
     where l.source_id = ${input.sourceId}
       and l.district_ref is null and l.district_name is null
       and s.source_id = l.source_id and s.level = 'subdistrict'
       and s.ref = l.subdistrict_ref and s.parent_level = 'district'
  `);
  return { houseNumbers, districts: filled.rowCount ?? 0 };
}

/** A street whose "no point" answer is asked again after this long: ss.ge may have placed it since. */
const POINT_NONE_RECHECK_DAYS = 60;
/** A city whose streets ss.ge never places (Batumi on 2026-11-06): after this many "none" and no point, its streets are not asked. */
const UNPLACED_CITY_STREETS = 20;

/**
 * One active listing for each street whose point is not known, the streets
 * with most listings first, then one for each settlement no page of whose
 * listings has been read (its municipality is only on a page). A listing whose
 * page was never read is taken before one already read, since its details are
 * wanted too. A street ss.ge answered "none" for is asked again after
 * `POINT_NONE_RECHECK_DAYS`, unless its city has no placed street at all.
 */
export async function loadListingsForPlacePoints(
  db: DatabaseOrTransaction,
  input: { sourceId: string; asOf: string; limit: number },
): Promise<{ id: string; sourceListingKey: string }[]> {
  if (input.limit <= 0) return [];
  const recheckBefore = new Date(
    Date.parse(input.asOf) - POINT_NONE_RECHECK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const rows = await db.execute<{ id: string; source_listing_key: string }>(sql`
    with street_city as (
      select distinct on (p.ref) p.ref, p.point_status, p.point_checked_at, p.active_listings, l.city_ref
        from ${realEstatePlaces} p
        join realestate.listings l
          on l.source_id = p.source_id and l.street_ref = p.ref and l.status = 'active'
       where p.source_id = ${input.sourceId} and p.level = 'street'
       order by p.ref, l.city_ref
    ), unplaced_cities as (
      select city_ref
        from street_city
       where city_ref is not null
       group by city_ref
      having count(*) filter (where point_status = 'known') = 0
         and count(*) filter (where point_status = 'none') >= ${UNPLACED_CITY_STREETS}
    ), streets as (
      select distinct on (s.ref) 0 as kind, s.active_listings as weight, s.ref as place, l.id, l.source_listing_key
        from street_city s
        join realestate.listings l
          on l.source_id = ${input.sourceId} and l.street_ref = s.ref and l.status = 'active'
       where (s.point_status = 'unknown'
              or (s.point_status = 'none' and s.point_checked_at < ${recheckBefore}))
         and not exists (select 1 from unplaced_cities u where u.city_ref = s.city_ref)
       order by s.ref, l.details_read_at is null desc, l.source_updated_at desc, l.id
    ), unread_settlements as (
      select city_ref, count(*)::integer as listings
        from realestate.listings
       where source_id = ${input.sourceId} and status = 'active' and city_ref is not null
       group by city_ref
      having count(details_read_at) = 0 and count(municipality_ref) = 0
    ), settlements as (
      select distinct on (u.city_ref) 1 as kind, u.listings as weight, u.city_ref as place, l.id, l.source_listing_key
        from unread_settlements u
        join realestate.listings l
          on l.source_id = ${input.sourceId} and l.city_ref = u.city_ref and l.status = 'active'
       order by u.city_ref, l.source_updated_at desc, l.id
    )
    select id, source_listing_key from (
      select * from streets union all select * from settlements
    ) picks
     order by kind, weight desc, place
     limit ${input.limit}
  `);
  return rows.rows.map((row) => ({ id: row.id, sourceListingKey: row.source_listing_key }));
}

/** What one listing page says about its street's point. */
export type StreetPoint =
  | { status: 'known'; latitude: number; longitude: number }
  /** The page sent 0/0: ss.ge has no point for this street. */
  | { status: 'none' };

/**
 * Keeps ss.ge's own point for a street, which every listing page on it
 * carries alike (Phase 14A). A street the tree does not hold yet is added
 * under the page's sub-district or city, by the page's name for it; with no
 * name, only a street already held is updated.
 */
export async function recordStreetPoint(
  db: DatabaseOrTransaction,
  input: {
    sourceId: string;
    streetRef: number;
    streetName: string | null;
    subdistrictRef: number | null;
    cityRef: number | null;
    point: StreetPoint;
    readAt: string;
  },
): Promise<void> {
  const point =
    input.point.status === 'known'
      ? {
          latitude: input.point.latitude.toFixed(6),
          longitude: input.point.longitude.toFixed(6),
          pointStatus: 'known' as const,
        }
      : { latitude: null, longitude: null, pointStatus: 'none' as const };
  const changes = { ...point, pointCheckedAt: input.readAt };
  if (input.streetName === null) {
    await db
      .update(realEstatePlaces)
      .set(changes)
      .where(
        and(
          eq(realEstatePlaces.sourceId, input.sourceId),
          eq(realEstatePlaces.level, 'street'),
          eq(realEstatePlaces.ref, input.streetRef),
        ),
      );
    return;
  }
  const parent =
    input.subdistrictRef !== null
      ? { parentLevel: 'subdistrict' as const, parentRef: input.subdistrictRef }
      : input.cityRef !== null
        ? { parentLevel: 'city' as const, parentRef: input.cityRef }
        : { parentLevel: null, parentRef: null };
  await db
    .insert(realEstatePlaces)
    .values({
      sourceId: input.sourceId,
      level: 'street',
      ref: input.streetRef,
      ...parent,
      nameKa: input.streetName,
      ...changes,
      firstSeenAt: input.readAt,
      lastSeenAt: input.readAt,
    })
    .onConflictDoUpdate({
      target: [realEstatePlaces.sourceId, realEstatePlaces.level, realEstatePlaces.ref],
      set: changes,
    });
}
