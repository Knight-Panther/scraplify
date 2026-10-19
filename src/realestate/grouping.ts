import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { realEstateListingGroups, realEstateListings } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';

/**
 * Look-alike listings: the same flat or house posted more than once, by its
 * owner and by agents (guideline §5, Phase 11D). ss.ge already folds many of
 * them; about one row in four in the busiest neighbourhood is still a repeat.
 *
 * Two listings are look-alikes when the deal, the kind, the city, the
 * sub-district, the street, the rooms, the floor and the building's height
 * all agree, and the area and the dollar price are close: within 0.6 m² and
 * 3% of the group's first member, taken in order of area and then price. The
 * margins are measured from that first member, not from the nearest one, so
 * a run of small steps cannot chain different flats into one group. A street
 * number is not compared: posters fill it with anything (".", "000", the
 * building's name).
 *
 * A listing missing any compared field is never grouped, except that a house
 * or cottage has no floor. The rule can still join genuinely different units
 * of one new building that share a floor, a size and a price; the tab shows
 * every member of a group, so nothing is hidden by a wrong match.
 */

export const AREA_MARGIN_M2 = 0.6;
export const PRICE_MARGIN = 0.03;

/** Street-type words, cut wherever they stand: "ქ." and "ქუჩა" name the same street. */
const STREET_TYPE_WORDS = new Set([
  'ქ',
  'ქუჩა',
  'ქუჩის',
  'გამზ',
  'გამზირი',
  'გამზირის',
  'str',
  'st',
  'street',
  'ave',
  'avenue',
]);

/**
 * One street however its name is written: lower case, a former name in
 * brackets and initials ("ს.", "ალ.") dropped, street-type words ("ქ.",
 * "ქუჩა", "გამზ.") dropped, hyphens read as spaces, punctuation gone. A lane
 * ("ჩიხი"), a side street ("შესახვევი") and its number ("I", "II") are kept,
 * since each is a different street from the avenue it leaves. Null when
 * nothing is left.
 */
export function streetKey(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null;
  const words = name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    // An initial: one or two letters and a dot, as in "ს.ცინცაძის" or "ალ. იოსელიანის".
    .replace(/(^|[\s,])[a-zა-ჿ]{1,2}\.(?=\s*[a-zა-ჿ]{3})/g, '$1 ')
    .replace(/[-–—]/g, ' ')
    .split(/[^0-9a-zა-ჿ]+/)
    .filter((word) => word !== '' && !STREET_TYPE_WORDS.has(word));
  return words.length === 0 ? null : words.join(' ');
}

export interface GroupingRow {
  id: string;
  dealType: 'sale' | 'rent';
  propertyType: 'flat' | 'house' | 'cottage';
  cityRef: number | null;
  subdistrictRef: number | null;
  streetName: string | null;
  rooms: number | null;
  floor: number | null;
  totalFloors: number | null;
  areaM2: number | null;
  priceUsd: number | null;
  /** The group it was in before this pass, kept where the group carries on. */
  groupKey: string | null;
}

/** The fields that must match exactly, or null when one the rule needs is missing. */
function blockOf(row: GroupingRow): string | null {
  const street = streetKey(row.streetName);
  const needsFloor = row.propertyType === 'flat';
  if (
    street === null ||
    row.cityRef === null ||
    row.subdistrictRef === null ||
    row.rooms === null ||
    row.totalFloors === null ||
    row.areaM2 === null ||
    row.priceUsd === null ||
    row.priceUsd <= 0 ||
    (needsFloor && row.floor === null)
  ) {
    return null;
  }
  return [
    row.dealType,
    row.propertyType,
    row.cityRef,
    row.subdistrictRef,
    street,
    row.rooms,
    row.floor ?? '-',
    row.totalFloors,
  ].join('|');
}

/**
 * The groups among `rows`, as lists of ids, each of two or more. Pure, and
 * the same whatever order the rows come in.
 */
export function groupLookAlikes(rows: readonly GroupingRow[]): string[][] {
  const blocks = new Map<string, GroupingRow[]>();
  for (const row of rows) {
    const block = blockOf(row);
    if (block === null) continue;
    const members = blocks.get(block);
    if (members === undefined) blocks.set(block, [row]);
    else members.push(row);
  }

  const groups: string[][] = [];
  for (const members of blocks.values()) {
    if (members.length < 2) continue;
    members.sort(
      (a, b) =>
        (a.areaM2 as number) - (b.areaM2 as number) ||
        (a.priceUsd as number) - (b.priceUsd as number) ||
        a.id.localeCompare(b.id),
    );
    const formed: { first: GroupingRow; ids: string[] }[] = [];
    for (const row of members) {
      const home = formed.find(
        ({ first }) =>
          Math.abs((row.areaM2 as number) - (first.areaM2 as number)) <= AREA_MARGIN_M2 + 1e-9 &&
          Math.abs((row.priceUsd as number) - (first.priceUsd as number)) <=
            PRICE_MARGIN * (first.priceUsd as number) + 1e-6,
      );
      if (home === undefined) formed.push({ first: row, ids: [row.id] });
      else home.ids.push(row.id);
    }
    for (const { ids } of formed) if (ids.length > 1) groups.push(ids);
  }
  return groups;
}

/**
 * A key for each group: the key most of its members already had, so a group
 * keeps its key as members come and go, or a new one. When two groups claim
 * the same old key, the one with more members holding it keeps it (then the
 * one whose first id sorts first) and the other is given a new key.
 */
export function keyGroups(
  groups: readonly string[][],
  previousKey: ReadonlyMap<string, string | null>,
  newKey: () => string = randomUUID,
): string[] {
  const claims = groups.map((ids, index) => {
    const counts = new Map<string, number>();
    for (const id of ids) {
      const key = previousKey.get(id);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      index,
      key: best?.[0] ?? null,
      holders: best?.[1] ?? 0,
      first: [...ids].sort()[0] ?? '',
    };
  });
  const keys: string[] = new Array(groups.length);
  const taken = new Set<string>();
  const order = [...claims].sort((a, b) => b.holders - a.holders || a.first.localeCompare(b.first));
  for (const claim of order) {
    if (claim.key !== null && !taken.has(claim.key)) {
      keys[claim.index] = claim.key;
      taken.add(claim.key);
    }
  }
  for (const claim of claims) if (keys[claim.index] === undefined) keys[claim.index] = newKey();
  return keys;
}

export interface RegroupResult {
  groups: number;
  groupedListings: number;
  /** Listings whose group key changed in this pass. */
  changedListings: number;
}

const UPDATE_CHUNK = 1_000;

/**
 * Regroups one source's active listings and records the groups. Run after
 * every crawl; it reads every active listing (about 140,000 for ss.ge, a few
 * seconds) and writes only what changed. A listing no longer active, or no
 * longer like any other, loses its key, and a group left with fewer than
 * two members is deleted.
 */
export async function regroupListings(
  db: DatabaseOrTransaction,
  options: { sourceId: string; now: string },
): Promise<RegroupResult> {
  const { sourceId, now } = options;
  return db.transaction(async (tx) => {
    const loaded = await tx
      .select({
        id: realEstateListings.id,
        dealType: realEstateListings.dealType,
        propertyType: realEstateListings.propertyType,
        cityRef: realEstateListings.cityRef,
        subdistrictRef: realEstateListings.subdistrictRef,
        streetName: realEstateListings.streetName,
        rooms: realEstateListings.rooms,
        floor: realEstateListings.floor,
        totalFloors: realEstateListings.totalFloors,
        areaM2: realEstateListings.areaM2,
        priceUsd: realEstateListings.priceUsd,
        groupKey: realEstateListings.groupKey,
      })
      .from(realEstateListings)
      .where(
        and(eq(realEstateListings.sourceId, sourceId), eq(realEstateListings.status, 'active')),
      );
    const rows: GroupingRow[] = loaded.map((row) => ({
      ...row,
      areaM2: row.areaM2 === null ? null : Number(row.areaM2),
      priceUsd: row.priceUsd === null ? null : Number(row.priceUsd),
    }));
    const previous = new Map(rows.map((row) => [row.id, row.groupKey]));

    const groups = groupLookAlikes(rows);
    const keys = keyGroups(groups, previous);
    const next = new Map<string, string>();
    groups.forEach((ids, index) => {
      for (const id of ids) next.set(id, keys[index] as string);
    });

    const changes: { id: string; key: string | null }[] = [];
    for (const row of rows) {
      const key = next.get(row.id) ?? null;
      if (key !== row.groupKey) changes.push({ id: row.id, key });
    }
    for (let at = 0; at < changes.length; at += UPDATE_CHUNK) {
      const chunk = changes.slice(at, at + UPDATE_CHUNK);
      const values = sql.join(
        chunk.map(({ id, key }) => sql`(${id}::uuid, ${key}::text)`),
        sql`, `,
      );
      await tx.execute(sql`
        update ${realEstateListings} set group_key = changed.key
        from (values ${values}) as changed (id, key)
        where ${realEstateListings.id} = changed.id
      `);
    }
    // A listing that is no longer active keeps no group.
    await tx
      .update(realEstateListings)
      .set({ groupKey: null })
      .where(
        and(
          eq(realEstateListings.sourceId, sourceId),
          ne(realEstateListings.status, 'active'),
          isNotNull(realEstateListings.groupKey),
        ),
      );

    // The groups table: one row per live group, formed_at kept from its first night.
    const sizes = groups.map((ids, index) => ({
      groupKey: keys[index] as string,
      memberCount: ids.length,
    }));
    for (let at = 0; at < sizes.length; at += UPDATE_CHUNK) {
      await tx
        .insert(realEstateListingGroups)
        .values(
          sizes.slice(at, at + UPDATE_CHUNK).map((g) => ({ ...g, formedAt: now, updatedAt: now })),
        )
        .onConflictDoUpdate({
          target: realEstateListingGroups.groupKey,
          set: { memberCount: sql`excluded.member_count`, updatedAt: sql`excluded.updated_at` },
        });
    }
    // A group no listing points to any more has ended. Only this function
    // writes group keys, so that is the whole test.
    await tx
      .delete(realEstateListingGroups)
      .where(
        sql`not exists (select 1 from ${realEstateListings} where ${realEstateListings.groupKey} = ${realEstateListingGroups.groupKey})`,
      );

    return {
      groups: groups.length,
      groupedListings: next.size,
      changedListings: changes.length,
    };
  });
}
