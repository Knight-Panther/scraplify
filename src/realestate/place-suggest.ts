import { and, or, type SQL, sql } from 'drizzle-orm';
import {
  realEstatePublicPlaces as catalogue,
  realEstatePublicListings as listings,
} from '../db/schema/index.js';
import type { Database, DatabaseOrTransaction } from '../db/types.js';
import { unit, without } from './facets.js';
import {
  conditions,
  inPlace,
  nearMetro,
  type PlaceFilterLevel,
  type RealEstateFilters,
  type RealEstatePlace,
} from './filters.js';
import { nameKey } from './place-lookup.js';
import { withinTimeout } from './queries.js';

/**
 * The place box's suggestions and the names of the places a filter holds
 * (Phase 16B), over `realestate.public_places` (C6). A person's words are
 * folded by `place-lookup.ts`'s own `nameKey`, the way every place's names
 * were when its `match_keys` were stored, so "ვაკ", "vak" and "Vake" all reach
 * Vake.
 */

export type SuggestGroup = 'area' | 'district' | 'official' | 'city' | 'metro' | 'street';

export interface PlaceSuggestion {
  level: PlaceFilterLevel | 'metro_station';
  ref: number;
  /** A station's ss.ge code. */
  code: string | null;
  nameKa: string;
  nameEn: string | null;
  /** A street's or sub-district's parent, so two streets of one name can be told apart. */
  parentKa: string | null;
  /** Listings (or properties) it would show given the other filters; null when counting took too long. */
  count: number | null;
}

export interface PlaceSuggestions {
  query: string;
  groups: { group: SuggestGroup; places: PlaceSuggestion[] }[];
}

export interface PlaceLabel {
  level: string;
  ref: number;
  code: string | null;
  nameKa: string;
  nameEn: string | null;
}

const GROUP_ORDER: readonly SuggestGroup[] = [
  'area',
  'district',
  'official',
  'city',
  'metro',
  'street',
];
const GROUP_LEVELS: Record<SuggestGroup, readonly string[]> = {
  area: ['neighbourhood', 'subdistrict'],
  district: ['district'],
  official: ['official_district'],
  city: ['city', 'municipality'],
  metro: ['metro_station'],
  street: ['street'],
};
const PER_GROUP = 6;
const PER_GROUP_STREETS = 8;
/** What a suggestion's count may take before the suggestions come without numbers. */
const COUNT_TIMEOUT_MS = 1_500;
/** The station band a suggestion's count uses when the metro filter names none. */
const SUGGEST_METRO_MINUTES = 15;
/** The popular list, for an empty box: how many of each. */
const POPULAR: readonly { group: SuggestGroup; levels: readonly string[]; limit: number }[] = [
  { group: 'area', levels: GROUP_LEVELS.area, limit: 8 },
  { group: 'city', levels: ['city'], limit: 2 },
  { group: 'metro', levels: GROUP_LEVELS.metro, limit: 2 },
];

const groupOf = (level: string): SuggestGroup =>
  GROUP_ORDER.find((group) => GROUP_LEVELS[group].includes(level)) ?? 'area';

const list = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

interface Candidate extends Omit<PlaceSuggestion, 'count'> {
  group: SuggestGroup;
}

interface CandidateRow extends Record<string, unknown> {
  level: string;
  ref: number;
  code: string | null;
  name_ka: string;
  name_en: string | null;
  parent_ka: string | null;
}

const toCandidate = (row: CandidateRow): Candidate => ({
  group: groupOf(row.level),
  level: row.level as PlaceSuggestion['level'],
  ref: row.ref,
  code: row.code,
  nameKa: row.name_ka,
  nameEn: row.name_en,
  parentKa: row.parent_ka,
});

/** Escapes what `like` reads as a pattern. */
const likeLiteral = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

/** The places whose names the words start, busiest first, per group. */
async function matching(db: DatabaseOrTransaction, key: string): Promise<Candidate[]> {
  const prefix = `${likeLiteral(key)}%`;
  const inWords = `% ${likeLiteral(key)}%`;
  const groupCase = sql.join(
    GROUP_ORDER.map(
      (group) => sql`when p.level in (${list(GROUP_LEVELS[group])}) then ${group}::text`,
    ),
    sql` `,
  );
  const { rows } = await db.execute<CandidateRow>(sql`
    with hits as (
      select p.source_id, p.level, p.ref, p.code, p.name_ka, p.name_en, p.parent_level, p.parent_ref,
             p.active_listings,
             case ${groupCase} end as grp,
             -- Exact name, then the start of a name, then the start of one of its words.
             (select min(case when m.k = ${key} then 0 when m.k like ${prefix} then 1 else 2 end)
                from unnest(p.match_keys) as m(k)
               where (' ' || m.k) like ${inWords}) as quality
        from realestate.public_places p
       where p.active_listings > 0
    ), ranked as (
      select h.*,
             row_number() over (partition by h.grp order by h.quality, h.active_listings desc, h.ref) as n
        from hits h
       where h.quality is not null
    )
    select r.level, r.ref, r.code, r.name_ka, r.name_en,
           case when r.level in ('street', 'subdistrict') then parent.name_ka end as parent_ka
      from ranked r
      left join realestate.public_places parent
        on parent.source_id = r.source_id and parent.level = r.parent_level and parent.ref = r.parent_ref
     where r.n <= case when r.grp = 'street' then ${PER_GROUP_STREETS}::int else ${PER_GROUP}::int end
     order by r.grp, r.n
  `);
  return rows.map(toCandidate);
}

/** The busiest places of the popular list, for an empty box. */
async function popular(db: DatabaseOrTransaction): Promise<Candidate[]> {
  const found: Candidate[] = [];
  for (const { levels, limit } of POPULAR) {
    const { rows } = await db.execute<CandidateRow>(sql`
      select p.level, p.ref, p.code, p.name_ka, p.name_en,
             case when p.level in ('street', 'subdistrict') then parent.name_ka end as parent_ka
        from realestate.public_places p
        left join realestate.public_places parent
          on parent.source_id = p.source_id and parent.level = p.parent_level and parent.ref = p.parent_ref
       where p.active_listings > 0 and p.level in (${list(levels)})
       order by p.active_listings desc, p.ref
       limit ${limit}::int
    `);
    found.push(...rows.map(toCandidate));
  }
  return found;
}

/** What picking each candidate would show, in one scan; null for one that cannot be counted. */
async function countCandidates(
  db: DatabaseOrTransaction,
  candidates: readonly Candidate[],
  filters: RealEstateFilters,
  now: string,
): Promise<(number | null)[]> {
  if (candidates.length === 0) return [];
  // A place is added to the places, a station to the metro: neither filter holds in the base.
  const base = without(filters, ['places', 'metro']);
  const metroBand = filters.metro?.maxMinutes;
  const matches = candidates.map((candidate): SQL | undefined => {
    if (candidate.level === 'metro_station') {
      return candidate.code === null
        ? undefined
        : nearMetro({ maxMinutes: metroBand ?? SUGGEST_METRO_MINUTES, stations: [candidate.code] });
    }
    const place: RealEstatePlace = { level: candidate.level, ref: candidate.ref };
    return and(inPlace(place), filters.metro === undefined ? undefined : nearMetro(filters.metro));
  });
  const fields = Object.fromEntries(
    matches.map((match, at) => [`c${at}`, unit(base, match ?? sql`false`)]),
  );
  const [row] = await db
    .select(fields)
    .from(listings)
    .where(and(conditions(base, now), or(...matches.map((match) => match ?? sql`false`))));
  return candidates.map((candidate, at) =>
    candidate.level === 'metro_station' && candidate.code === null
      ? null
      : Number(row?.[`c${at}`] ?? 0),
  );
}

/**
 * The places the text may be after, grouped, with how many listings each
 * would show given the other filters. An empty text gives the popular ones.
 * A count that takes too long is left out (null on every place); the
 * suggestions themselves never fail for it.
 */
export async function suggestPlaces(
  db: Database,
  text: string,
  filters: RealEstateFilters,
  now: string,
): Promise<PlaceSuggestions> {
  const key = nameKey(text);
  // Words that only name a kind of place ("street") ask for nothing.
  const candidates =
    text.trim() === '' ? await popular(db) : key === '' ? [] : await matching(db, key);
  const counts = await withinTimeout(db, COUNT_TIMEOUT_MS, (tx) =>
    countCandidates(tx, candidates, filters, now),
  );
  const groups = GROUP_ORDER.map((group) => ({
    group,
    places: candidates.flatMap((candidate, at) =>
      candidate.group === group
        ? [
            {
              level: candidate.level,
              ref: candidate.ref,
              code: candidate.code,
              nameKa: candidate.nameKa,
              nameEn: candidate.nameEn,
              parentKa: candidate.parentKa,
              count: counts?.[at] ?? null,
            },
          ]
        : [],
    ),
  })).filter((entry) => entry.places.length > 0);
  return { query: text, groups };
}

/** The catalogue's names for the places a filter holds, in the order asked; a place C6 does not know is left out. */
export async function placeLabels(
  db: DatabaseOrTransaction,
  places: readonly RealEstatePlace[],
): Promise<PlaceLabel[]> {
  if (places.length === 0) return [];
  const rows = await db
    .select({
      level: catalogue.level,
      ref: catalogue.ref,
      code: catalogue.code,
      nameKa: catalogue.nameKa,
      nameEn: catalogue.nameEn,
    })
    .from(catalogue)
    .where(
      or(
        ...places.map(
          (place) => sql`(${catalogue.level} = ${place.level} and ${catalogue.ref} = ${place.ref})`,
        ),
      ),
    );
  const found = new Map(rows.map((row) => [`${row.level}:${row.ref}`, row]));
  return places.flatMap((place) => {
    const row = found.get(`${place.level}:${place.ref}`);
    return row === undefined ? [] : [row];
  });
}

/** The metro stations of C6, for the line diagram: their codes and names, in the order of their refs. */
export async function stationLabels(db: DatabaseOrTransaction): Promise<PlaceLabel[]> {
  return db
    .select({
      level: catalogue.level,
      ref: catalogue.ref,
      code: catalogue.code,
      nameKa: catalogue.nameKa,
      nameEn: catalogue.nameEn,
    })
    .from(catalogue)
    .where(sql`${catalogue.level} = 'metro_station'`)
    .orderBy(catalogue.ref);
}
