import { eq, sql } from 'drizzle-orm';
import { realEstateDailyTotals, realEstatePublicListings } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import { conditions, type RealEstateFilters, shownRows } from './filters.js';

/**
 * What was on the market today (Phase 13D, contract C3): the Real estate
 * tab's own rules, applied to every area, deal, kind and room band at once,
 * and kept in `realestate_archive.daily_totals`. Taken after each night's
 * ss.ge run (`src/cli/run-ss-ge-crawl.ts`), or by hand
 * (`npm run totals:ss-ge`).
 *
 * The figures are of the listings a statistic counts: on show, reposts
 * merged into their group's newest listing, typo prices left out
 * (`{ grouped: true, plausibleOnly: true }`, as contract C1 tells Hermes to
 * ask), so a day's totals and the bot's figures for that day agree. `posts`
 * counts the same listings before reposts are merged.
 */

/**
 * Raised when the rules behind the figures change, so a step is not read as a
 * trend. 2 (2026-11-06): a rent of $200 a m² or more is a typo, and prices per
 * m² come only from listings whose area is known.
 */
export const TOTALS_RULES_VERSION = 2;
/** A cell with fewer listings is not kept: one or two listings are no market, and most cells are villages. */
export const TOTALS_MIN_LISTINGS = 5;

/** The calendar date in Tbilisi (UTC+4 all year, no daylight saving since 2005). */
export function tbilisiDay(instant: string): string {
  return new Date(Date.parse(instant) + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Each area level paired with its ref and name columns, in the order the cells name them. */
const AREA_SETS = [
  { level: 'city', ref: sql.raw('city_ref') },
  { level: 'district', ref: sql.raw('district_ref') },
  { level: 'subdistrict', ref: sql.raw('subdistrict_ref') },
] as const;

/**
 * Replaces today's totals for one source with fresh ones, in one
 * transaction: a day taken twice keeps the later figures and no cell of the
 * earlier ones. Returns the day and how many cells it holds.
 */
export async function takeDailyTotals(
  db: DatabaseOrTransaction,
  input: { sourceId: string; now: string; crawlRunId: string | null },
): Promise<{ day: string; cells: number }> {
  const { sourceId, now, crawlRunId } = input;
  const day = tbilisiDay(now);
  const posts: RealEstateFilters = { sourceId, plausibleOnly: true };
  const leads: RealEstateFilters = { ...posts, grouped: true };
  const kind = sql.raw('deal_type, property_type');
  const groupingSets = sql.join(
    [sql``, ...AREA_SETS.map((set) => sql`${set.ref}, `)].flatMap((area) => [
      sql`(${area}${kind})`,
      sql`(${area}${kind}, band)`,
    ]),
    sql`, `,
  );
  const level = sql.join(
    AREA_SETS.map((set) => sql`when grouping(${set.ref}) = 0 then ${set.level}`),
    sql` `,
  );

  const cells = await db.transaction(async (tx) => {
    await tx.delete(realEstateDailyTotals).where(eq(realEstateDailyTotals.day, day));
    const inserted = await tx.execute(sql`
      with s as (
        select city_ref, city_name, district_ref, district_name, subdistrict_ref, subdistrict_name,
          deal_type, property_type,
          case when rooms >= 5 then '5+' when rooms between 1 and 4 then rooms::text end as band,
          price_usd, price_gel, price_per_m2_usd, price_per_m2_gel, area_m2, details_read_at,
          coalesce(${shownRows(leads, now)}, false) as leads
        from ${realEstatePublicListings}
        where ${conditions(posts, now)}
      ), cells as (
        select
          case ${level} else 'all' end as area_level,
          case
            when grouping(city_ref) = 0 then city_ref
            when grouping(district_ref) = 0 then district_ref
            when grouping(subdistrict_ref) = 0 then subdistrict_ref
            else 0
          end as area_ref,
          case
            when grouping(city_ref) = 0 then max(city_name)
            when grouping(district_ref) = 0 then max(district_name)
            when grouping(subdistrict_ref) = 0 then max(subdistrict_name)
          end as area_name,
          deal_type, property_type,
          case when grouping(band) = 0 then band else 'all' end as rooms_band,
          count(*) filter (where leads) as listings,
          count(*) as posts,
          count(details_read_at) filter (where leads) as with_details,
          percentile_cont(array[0.25, 0.5, 0.75]) within group (order by price_usd)
            filter (where leads) as price_usd,
          -- With no area, ss.ge's price per m² is the whole price.
          percentile_cont(0.5) within group (order by price_per_m2_usd)
            filter (where leads and area_m2 is not null) as ppm2_usd,
          percentile_cont(0.5) within group (order by price_gel) filter (where leads) as price_gel,
          percentile_cont(0.5) within group (order by price_per_m2_gel)
            filter (where leads and area_m2 is not null) as ppm2_gel,
          percentile_cont(0.5) within group (order by area_m2) filter (where leads) as area_m2
        from s
        group by grouping sets (${groupingSets})
        -- A listing with no room count is in its kind's "all" band only.
        having (grouping(band) = 1 or band is not null)
          and count(*) filter (where leads) >= ${TOTALS_MIN_LISTINGS}
      )
      insert into ${realEstateDailyTotals} (
        day, area_level, area_ref, area_name, deal_type, property_type, rooms_band,
        listings, posts, with_details, price_usd_p25, price_usd_median, price_usd_p75,
        price_per_m2_usd_median, price_gel_median, price_per_m2_gel_median, area_m2_median,
        taken_at, crawl_run_id, rules_version)
      select ${day}::date, area_level, area_ref, area_name, deal_type, property_type, rooms_band,
        listings, posts, with_details, price_usd[1], price_usd[2], price_usd[3],
        ppm2_usd, price_gel, ppm2_gel, area_m2,
        ${now}::timestamptz, ${crawlRunId}::uuid, ${TOTALS_RULES_VERSION}
      from cells
      -- A listing whose place is not known at a level is in no cell of that level.
      where area_ref is not null`);
    return inserted.rowCount ?? 0;
  });
  return { day, cells };
}
