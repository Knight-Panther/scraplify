import {
  and,
  desc,
  eq,
  getTableColumns,
  gt,
  isNotNull,
  lt,
  lte,
  or,
  sql,
  type Table,
} from 'drizzle-orm';
import {
  FILLED_AT_ARCHIVING,
  realEstateArchiveListings,
  realEstateArchivePriceChanges,
  realEstateListings,
  realEstatePriceChanges,
} from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import { type ListingDetails, recordListingDetails } from './details.js';
import { type ListingPrice, recordPriceSighting } from './ingest.js';
import type { DealType, PropertyType } from './kinds.js';
import { implausibleValuesOf } from './plausibility.js';

/**
 * How a listing leaves the catalogue (docs/real-estate-implementation-guideline.md
 * §9.3). A source's lists cannot say a listing is gone: nightly runs read
 * only the newest rows, and flat lists hide look-alikes. So every listing
 * carries the date the source is expected to drop it, and what happens at
 * that date is decided by the listing's own page, or by nobody having seen
 * it since.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A stated end is never trusted further ahead than this, so a listing that runs for years is looked at monthly. */
export const CHECK_HORIZON_DAYS = 30;
/** A listing shown as live although its stated end has passed is looked at again this soon. */
export const UNSETTLED_RECHECK_DAYS = 3;
/**
 * A page with no listing record is not believed for a listing its list
 * showed this recently: ss.ge renders a live listing's page that way now and
 * then (two of eight fresh ones on 2026-11-04, live on the next request).
 */
export const MISSING_TRUSTED_AFTER_DAYS = 2;
/** A listing nobody has seen or confirmed for this long past its expected end is given up. */
export const LAPSE_AFTER_DAYS = 7;
/** A gone listing is kept this long (a source showing it again reopens it), then archived and deleted. */
export const GONE_RETENTION_DAYS = 14;

export interface DueListing {
  id: string;
  sourceListingKey: string;
}

/** What a listing's own page says, in the terms every source adapter reports it. */
export type ListingCheck =
  | { status: 'active'; endAt: string | null; price?: ListingPrice; details?: ListingDetails }
  | { status: 'gone'; reason: string };

/**
 * Active listings worth asking their own page about, in that order.
 *
 * First those a full read of their list missed (`markMissedListings`) that
 * the tab still shows, the longest-lived first: a dead one of those stays on
 * show longest, and 55% of them were live on 2026-11-11. Then those past
 * their expected end that a list showed after that date and none has since,
 * most recently expired first.
 *
 * The rest past their end are not asked: they lapse a week later
 * (`markLapsedListingsGone`), and the night's listing pages go to the
 * details instead. Since 2026-11-11 every list's end is read each night, and
 * that is where a listing alive past its 30 days is: of the owners' listings
 * the checks found alive past them on 2026-11-11, the list ends showed 92.5%
 * that night (889 of 961), and a sighting keeps a listing on show by itself
 * (`upsertListing`, `SEEN_PAST_END_HOURS`). Agents' listings the lists no
 * longer show were 2.7% live; ss.ge's own lists do not show them either.
 */
export async function loadListingsDueForCheck(
  db: DatabaseOrTransaction,
  input: { sourceId: string; asOf: string; limit: number },
): Promise<DueListing[]> {
  const missedOnShow = and(
    isNotNull(realEstateListings.missedAt),
    gt(realEstateListings.expectedEndAt, input.asOf),
  );
  return db
    .select({ id: realEstateListings.id, sourceListingKey: realEstateListings.sourceListingKey })
    .from(realEstateListings)
    .where(
      and(
        eq(realEstateListings.sourceId, input.sourceId),
        eq(realEstateListings.status, 'active'),
        or(
          missedOnShow,
          and(
            lte(realEstateListings.expectedEndAt, input.asOf),
            gt(realEstateListings.lastSeenAt, realEstateListings.expectedEndAt),
          ),
        ),
      ),
    )
    .orderBy(desc(sql`coalesce(${missedOnShow}, false)`), desc(realEstateListings.expectedEndAt))
    .limit(input.limit);
}

/**
 * Writes what a listing's page said: gone, or live until a date worth
 * believing, with its details when the page carries them. `unsettled` is a
 * page that showed no listing for one its list showed within
 * `MISSING_TRUSTED_AFTER_DAYS` and no full read has missed since: it is looked
 * at again in a few days instead.
 */
export async function recordListingCheck(
  db: DatabaseOrTransaction,
  input: { listingId: string; check: ListingCheck; checkedAt: string },
): Promise<'verified' | 'gone' | 'unsettled'> {
  const { listingId, check, checkedAt } = input;
  const checkedMs = Date.parse(checkedAt);
  if (check.status === 'gone' && check.reason === 'missing') {
    const [listing] = await db
      .select({ lastSeenAt: realEstateListings.lastSeenAt, missedAt: realEstateListings.missedAt })
      .from(realEstateListings)
      .where(eq(realEstateListings.id, listingId));
    const seenMs = listing === undefined ? Number.NaN : Date.parse(listing.lastSeenAt);
    // A full read of its list that missed it is a second signal: believed at once.
    if (listing?.missedAt === null && checkedMs - seenMs < MISSING_TRUSTED_AFTER_DAYS * DAY_MS) {
      await db
        .update(realEstateListings)
        .set({
          expectedEndAt: new Date(checkedMs + UNSETTLED_RECHECK_DAYS * DAY_MS).toISOString(),
        })
        .where(eq(realEstateListings.id, listingId));
      return 'unsettled';
    }
  }
  if (check.status === 'gone') {
    await db
      .update(realEstateListings)
      .set({
        status: 'gone',
        goneAt: checkedAt,
        goneReason: check.reason,
        verifiedAt: checkedAt,
        missedAt: null,
      })
      .where(eq(realEstateListings.id, listingId));
    return 'gone';
  }

  const horizonMs = checkedMs + CHECK_HORIZON_DAYS * DAY_MS;
  const statedMs = check.endAt === null ? Number.NaN : Date.parse(check.endAt);
  let nextMs: number;
  if (Number.isNaN(statedMs)) nextMs = horizonMs;
  // Live on its page with an end already behind it: the source has not
  // caught up with itself, and will say one way or the other shortly.
  else if (statedMs <= checkedMs) nextMs = checkedMs + UNSETTLED_RECHECK_DAYS * DAY_MS;
  else nextMs = Math.min(statedMs, horizonMs);

  await db
    .update(realEstateListings)
    .set({ expectedEndAt: new Date(nextMs).toISOString(), verifiedAt: checkedAt, missedAt: null })
    .where(eq(realEstateListings.id, listingId));
  if (check.price !== undefined) {
    await recordPriceSighting(db, { listingId, price: check.price, seenAt: checkedAt });
  }
  if (check.details !== undefined) {
    await recordListingDetails(db, { listingId, details: check.details, readAt: checkedAt });
  }
  return 'verified';
}

/**
 * After a full read of one list (one deal and kind), marks the active
 * listings of it that the read did not see, nor any look-alike of them, as
 * missed, so the checks ask their own pages soon. A source's flat lists show
 * one listing per look-alike group (47,864 active listings were in 15,053
 * groups on 2026-10-27), so a listing whose group was seen is folded, not
 * missing. Listings already past their expected end are left to the usual
 * rules. A missed listing is never dropped for that alone.
 */
export async function markMissedListings(
  db: DatabaseOrTransaction,
  input: {
    sourceId: string;
    dealType: DealType;
    propertyType: PropertyType;
    /** When the full read began: anything seen since was in it. */
    readStartedAt: string;
    at: string;
  },
): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    update realestate.listings l
       set missed_at = ${input.at}
     where l.source_id = ${input.sourceId}
       and l.status = 'active'
       and l.deal_type = ${input.dealType}
       and l.property_type = ${input.propertyType}
       and l.missed_at is null
       and l.last_seen_at < ${input.readStartedAt}
       and l.expected_end_at > ${input.at}
       and not exists (
         select 1 from realestate.listings g
          where g.source_id = l.source_id
            and g.status = 'active'
            and g.last_seen_at >= ${input.readStartedAt}
            and ((l.group_key is not null and g.group_key = l.group_key)
              or (l.similarity_group is not null and g.similarity_group = l.similarity_group)))
    returning l.id`);
  return rows.rows.length;
}

/**
 * Marks gone the listings past their expected end that nobody has seen or
 * confirmed for a week. That errs towards dropping a live listing over
 * showing a dead one; a source that shows it again reopens it.
 */
export async function markLapsedListingsGone(
  db: DatabaseOrTransaction,
  input: { sourceId: string; asOf: string },
): Promise<number> {
  const before = new Date(Date.parse(input.asOf) - LAPSE_AFTER_DAYS * DAY_MS).toISOString();
  const rows = await db
    .update(realEstateListings)
    .set({ status: 'gone', goneAt: input.asOf, goneReason: 'lapsed' })
    .where(
      and(
        eq(realEstateListings.sourceId, input.sourceId),
        eq(realEstateListings.status, 'active'),
        lt(realEstateListings.expectedEndAt, before),
        lt(realEstateListings.lastSeenAt, before),
      ),
    )
    .returning({ id: realEstateListings.id });
  return rows.length;
}

const columnNames = (table: Table) => Object.values(getTableColumns(table)).map((c) => c.name);
const ARCHIVED_LISTING_COLUMNS = columnNames(realEstateArchiveListings).filter(
  (name) => !FILLED_AT_ARCHIVING.has(name),
);
const ARCHIVED_PRICE_CHANGE_COLUMNS = columnNames(realEstateArchivePriceChanges);

const listed = (names: readonly string[]) =>
  sql.join(
    names.map((name) => sql.identifier(name)),
    sql`, `,
  );

/**
 * Deletes listings gone for fourteen days, and their price history with
 * them; without this the table only grows. Each one is first copied to
 * `realestate_archive` (Phase 13A), with its price changes, minus its link,
 * text and coordinates.
 *
 * One statement does all of it, so the archive receives exactly the rows the
 * delete removes, and either both happen or neither does. Its parts all read
 * the table as it was when the statement began, so the price changes are
 * copied before the delete's cascade removes them. A listing the archive
 * already holds keeps its first copy.
 */
export async function deleteLongGoneListings(
  db: DatabaseOrTransaction,
  input: { sourceId: string; asOf: string },
): Promise<number> {
  const before = new Date(Date.parse(input.asOf) - GONE_RETENTION_DAYS * DAY_MS).toISOString();
  const doomed = sql.identifier('doomed');
  const implausible = implausibleValuesOf({
    areaM2: sql.identifier('area_m2'),
    propertyType: sql.identifier('property_type'),
    dealType: sql.identifier('deal_type'),
    priceUsd: sql.identifier('price_usd'),
    pricePerM2Usd: sql.identifier('price_per_m2_usd'),
  });
  const result = await db.execute<{ deleted: number }>(sql`
    with ${doomed} as (
      delete from ${realEstateListings}
      where source_id = ${input.sourceId} and status = 'gone' and gone_at < ${before}
      returning id, ${listed(ARCHIVED_LISTING_COLUMNS)}
    ), archived as (
      insert into ${realEstateArchiveListings} (listing_id, ${listed(ARCHIVED_LISTING_COLUMNS)}, implausible)
      select id, ${listed(ARCHIVED_LISTING_COLUMNS)}, ${implausible} from ${doomed}
      on conflict (listing_id) do nothing
    ), archived_changes as (
      insert into ${realEstateArchivePriceChanges} (${listed(ARCHIVED_PRICE_CHANGE_COLUMNS)})
      select ${listed(ARCHIVED_PRICE_CHANGE_COLUMNS)} from ${realEstatePriceChanges}
      where listing_id in (select id from ${doomed})
      on conflict (id) do nothing
    )
    select count(*)::int as deleted from ${doomed}
  `);
  return result.rows[0]?.deleted ?? 0;
}
