import { getTableColumns, type SQL, sql } from 'drizzle-orm';
import {
  realEstateHistorySteps,
  realEstateListingGroupDays,
  realEstateListings,
  realEstateListingVersions,
  realEstatePublicListings,
  realEstateShowSpells,
} from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import { conditions } from './filters.js';
import { tbilisiDay } from './totals.js';

/**
 * Permanent real-estate history (Phase 17A, docs/PHASE_17_PLAN.md). The live
 * table keeps only each listing's current state, so once a night, after the
 * look-alike groups are fresh and at the instant the night's totals are
 * taken, one set-based step compares every live row with the history and
 * writes only what changed:
 *
 * - **versions** (`listing_versions`): a listing whose statistics fields
 *   differ from its open version has that version closed and a new one
 *   opened; a listing with none gets its first;
 * - **spells on show** (`show_spells`): a listing the Real estate tab's own
 *   rule (`conditions`, contract C1) shows now and had no open spell opens
 *   one, and one it no longer shows closes its spell;
 * - **look-alike groups by night** (`listing_group_days`).
 *
 * There is no hook in the code that writes listings and no column on the
 * live table: a night the step fails or does not run is healed by the next,
 * which sees the same differences. The archive copy (`deleteLongGoneListings`)
 * closes a listing's open version and spell in the statement that removes it.
 */

/** The version's columns that are not a live column of the same name. */
export const FILLED_BY_THE_STEP: ReadonlySet<string> = new Set([
  'id',
  'listing_id',
  'valid_from',
  'valid_to',
  'version_hash',
  'approximate',
  'price_posted',
]);

/** The live columns a version keeps under the same name. */
export const COPIED_COLUMNS = Object.values(getTableColumns(realEstateListingVersions))
  .map((column) => column.name)
  .filter((name) => !FILLED_BY_THE_STEP.has(name));

/**
 * The copied columns a change of which makes a new version: what the source
 * states, and the status. The price is hashed as posted (`pricePostedOf`).
 */
export const HASHED_COLUMNS = [
  'deal_type',
  'property_type',
  'commercial_type',
  'land_type',
  'rooms',
  'bedrooms',
  'area_m2',
  'floor',
  'total_floors',
  'floor_low',
  'floor_high',
  'currency_posted',
  'city_ref',
  'city_name',
  'district_ref',
  'district_name',
  'subdistrict_ref',
  'subdistrict_name',
  'municipality_ref',
  'municipality_name',
  'street_ref',
  'street_name',
  'street_number',
  'condition',
  'building_status',
  'poster_type',
  'poster_entity',
  'similarity_group',
  'promoted',
  'status',
] as const;

/**
 * Copied but outside the hash: the identity; the prices in both currencies,
 * one of which moves with each day's exchange rate (the posted amount is
 * hashed instead); the house number and letter, read from `street_number`,
 * which is hashed; and the posting time, hashed as UTC text instead, so no
 * session's time zone changes it.
 */
export const UNHASHED_COLUMNS = [
  'source_id',
  'source_listing_key',
  'price_usd',
  'price_gel',
  'house_number',
  'house_suffix',
  'source_created_at',
] as const;

/** The amount the poster typed, in the currency they chose; null when the row names none. */
export function pricePostedOf(row: SQL): SQL {
  return sql`case ${row}.currency_posted when 'gel' then ${row}.price_gel when 'usd' then ${row}.price_usd end`;
}

/**
 * A row's version hash: its stated fields and status, its posted price (both
 * prices when it names no currency, as `listingContentHash` does) and its
 * posting time as UTC text. md5 of the row's text form, which is fixed for
 * every value here (no float, no time zone), so every session gets the same.
 */
export function versionHashOf(row: SQL): SQL {
  const parts = [
    ...HASHED_COLUMNS.map((name) => sql`${row}.${sql.identifier(name)}`),
    pricePostedOf(row),
    sql`case when ${row}.currency_posted is null then ${row}.price_gel end`,
    sql`case when ${row}.currency_posted is null then ${row}.price_usd end`,
    sql`to_char(${row}.source_created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`,
  ];
  return sql`md5(row(${sql.join(parts, sql`, `)})::text)`;
}

/**
 * The listings on show at `now` by the Real estate tab's own rule: the C1
 * builder's `conditions` itself, over the view it is written for, the same
 * predicate `takeDailyTotals` counts with (it adds `plausibleOnly`). No
 * second copy of the rule exists, so spells and totals cannot disagree.
 */
export function onShowIds(sourceId: string, now: string): SQL {
  return sql`select ${realEstatePublicListings.id} from ${realEstatePublicListings}
    where ${conditions({ sourceId }, now)}`;
}

export interface HistoryStepResult {
  ok: boolean;
  versionsOpened: number;
  versionsClosed: number;
  spellsOpened: number;
  spellsClosed: number;
  /** Listing-and-group rows that gained a night. */
  groupDays: number;
  durationMs: number;
  /** Why the step failed; null when it worked. */
  error: string | null;
}

const listed = (names: readonly string[], row?: SQL) =>
  sql.join(
    names.map((name) =>
      row === undefined ? sql.identifier(name) : sql`${row}.${sql.identifier(name)}`,
    ),
    sql`, `,
  );

/**
 * Records one night's history of a source at the instant `now`, which must be
 * the instant the night's totals are taken (`takeDailyTotals`), so the spells
 * and the totals see the same listings on show. One transaction: all of it is
 * written or none. Run twice at the same instant, the second writes nothing.
 *
 * Never throws for a failure of its own: it rolls back, records the failure
 * in `history_steps` (`ok` false) and returns it, so the crawl that called it
 * is not failed for it. The next night heals what this one missed.
 */
export async function recordListingHistory(
  db: DatabaseOrTransaction,
  input: { sourceId: string; now: string; crawlRunId: string | null },
): Promise<HistoryStepResult> {
  const { sourceId, now, crawlRunId } = input;
  const startedAtMs = Date.now();
  const live = sql.raw('live');
  const versions = sql.raw('versions');
  const spells = sql.raw('spells');
  try {
    const counts = await db.transaction(async (tx) => {
      // Two steps for one source never interleave (a crawl's and one by hand).
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`realestate-history:${sourceId}`}))`,
      );
      const [last] = (
        await tx.execute<{ ok_at: string | null; too_early: boolean }>(sql`
          select max(taken_at) filter (where ok)::text as ok_at,
                 coalesce(${now}::timestamptz < max(taken_at) filter (where ok), false) as too_early
            from ${realEstateHistorySteps} where source_id = ${sourceId}`)
      ).rows;
      if (last?.too_early) throw new Error(`now (${now}) is before the last step (${last.ok_at})`);

      // A version whose listing changed, or left the live table by a way the
      // archive copy did not close, ends now.
      const closedVersions = await tx.execute(sql`
        update ${realEstateListingVersions} ${versions}
           set valid_to = greatest(${now}::timestamptz, ${versions}.valid_from)
         where ${versions}.source_id = ${sourceId} and ${versions}.valid_to is null
           and not exists (
             select 1 from ${realEstateListings} ${live}
              where ${live}.id = ${versions}.listing_id
                and ${versionHashOf(live)} = ${versions}.version_hash)`);

      // Every live row with no open version gets one: from now if it had one
      // before (a change), else its first, from when it was first seen. A
      // first version is approximate unless the listing was first seen after
      // the last attempt of this step, since it may have changed in between.
      const openedVersions = await tx.execute(sql`
        with last as (
          select max(taken_at) as attempted from ${realEstateHistorySteps} where source_id = ${sourceId}
        ), fresh as (
          select ${live}.*, not exists (
                   select 1 from ${realEstateListingVersions} ${versions}
                    where ${versions}.listing_id = ${live}.id) as is_first
            from ${realEstateListings} ${live}
           where ${live}.source_id = ${sourceId}
             and not exists (
               select 1 from ${realEstateListingVersions} ${versions}
                where ${versions}.source_id = ${sourceId} and ${versions}.listing_id = ${live}.id
                  and ${versions}.valid_to is null)
        )
        insert into ${realEstateListingVersions}
          (listing_id, valid_from, version_hash, approximate, price_posted, ${listed(COPIED_COLUMNS)})
        select ${live}.id,
               case when ${live}.is_first then least(${live}.first_seen_at, ${now}::timestamptz)
                    else ${now}::timestamptz end,
               ${versionHashOf(live)},
               ${live}.is_first and (last.attempted is null or ${live}.first_seen_at <= last.attempted),
               ${pricePostedOf(live)},
               ${listed(COPIED_COLUMNS, live)}
          from fresh ${live} cross join last`);

      const shown = sql.raw('shown');
      const closedSpells = await tx.execute(sql`
        update ${realEstateShowSpells} ${spells}
           set shown_until = greatest(${now}::timestamptz, ${spells}.shown_from)
         where ${spells}.source_id = ${sourceId} and ${spells}.shown_until is null
           and not exists (
             select 1 from (${onShowIds(sourceId, now)}) ${shown}
              where ${shown}.id = ${spells}.listing_id)`);

      const openedSpells = await tx.execute(sql`
        insert into ${realEstateShowSpells} (listing_id, source_id, source_listing_key, shown_from, group_key)
        select ${live}.id, ${live}.source_id, ${live}.source_listing_key, ${now}::timestamptz, ${live}.group_key
          from ${realEstateListings} ${live}
         where ${live}.id in (${onShowIds(sourceId, now)})
           and not exists (
             select 1 from ${realEstateShowSpells} ${spells}
              where ${spells}.source_id = ${sourceId} and ${spells}.listing_id = ${live}.id
                and ${spells}.shown_until is null)`);

      // Tonight's groups, as `regroupListings` has just left them. A second
      // run on the same Tbilisi day adds nothing.
      const day = tbilisiDay(now);
      const groupDays = await tx.execute(sql`
        insert into ${realEstateListingGroupDays} as days
          (listing_id, source_id, group_key, first_day, last_day, nights)
        select ${live}.id, ${live}.source_id, ${live}.group_key, ${day}::date, ${day}::date, 1
          from ${realEstateListings} ${live}
         where ${live}.source_id = ${sourceId} and ${live}.status = 'active'
           and ${live}.group_key is not null
        on conflict (listing_id, group_key) do update
          set last_day = excluded.last_day, nights = days.nights + 1
          where days.last_day < excluded.last_day`);

      const result = {
        versionsOpened: openedVersions.rowCount ?? 0,
        versionsClosed: closedVersions.rowCount ?? 0,
        spellsOpened: openedSpells.rowCount ?? 0,
        spellsClosed: closedSpells.rowCount ?? 0,
        groupDays: groupDays.rowCount ?? 0,
      };
      await tx.insert(realEstateHistorySteps).values({
        sourceId,
        takenAt: now,
        crawlRunId,
        ...result,
        durationMs: Date.now() - startedAtMs,
        ok: true,
      });
      return result;
    });
    return { ok: true, ...counts, durationMs: Date.now() - startedAtMs, error: null };
  } catch (err) {
    let error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    try {
      await db.insert(realEstateHistorySteps).values({
        sourceId,
        takenAt: now,
        crawlRunId,
        durationMs: Date.now() - startedAtMs,
        ok: false,
        error: error.slice(0, 1000),
      });
    } catch (recordErr) {
      error += `; recording the failure failed too: ${recordErr instanceof Error ? recordErr.message : String(recordErr)}`;
    }
    return {
      ok: false,
      versionsOpened: 0,
      versionsClosed: 0,
      spellsOpened: 0,
      spellsClosed: 0,
      groupDays: 0,
      durationMs: Date.now() - startedAtMs,
      error,
    };
  }
}
