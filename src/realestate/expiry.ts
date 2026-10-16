import { and, desc, eq, lt, lte, sql } from 'drizzle-orm';
import { realEstateListings } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';

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
/** A listing nobody has seen or confirmed for this long past its expected end is given up. */
export const LAPSE_AFTER_DAYS = 7;
/** A gone listing is kept this long (a source showing it again reopens it), then deleted. */
export const GONE_RETENTION_DAYS = 14;

export interface DueListing {
  id: string;
  sourceListingKey: string;
}

/** What a listing's own page says, in the terms every source adapter reports it. */
export type ListingCheck =
  | { status: 'active'; endAt: string | null }
  | { status: 'gone'; reason: string };

/**
 * Active listings past their expected end, in the order worth checking.
 *
 * First those the source still listed after that date: the thirty-day rule
 * plainly does not hold for them (company listings run for years), and only
 * their own page says when they end. Then the most recently expired: a check
 * on the night a listing lapses keeps it on show without a gap, and when
 * there are more than one night's checks can cover, the oldest are the ones
 * least worth the request.
 */
export async function loadListingsDueForCheck(
  db: DatabaseOrTransaction,
  input: { sourceId: string; asOf: string; limit: number },
): Promise<DueListing[]> {
  return db
    .select({ id: realEstateListings.id, sourceListingKey: realEstateListings.sourceListingKey })
    .from(realEstateListings)
    .where(
      and(
        eq(realEstateListings.sourceId, input.sourceId),
        eq(realEstateListings.status, 'active'),
        lte(realEstateListings.expectedEndAt, input.asOf),
      ),
    )
    .orderBy(
      desc(sql`${realEstateListings.lastSeenAt} > ${realEstateListings.expectedEndAt}`),
      desc(realEstateListings.expectedEndAt),
    )
    .limit(input.limit);
}

/** Writes what a listing's page said: gone, or live until a date worth believing. */
export async function recordListingCheck(
  db: DatabaseOrTransaction,
  input: { listingId: string; check: ListingCheck; checkedAt: string },
): Promise<'verified' | 'gone'> {
  const { listingId, check, checkedAt } = input;
  if (check.status === 'gone') {
    await db
      .update(realEstateListings)
      .set({ status: 'gone', goneAt: checkedAt, goneReason: check.reason, verifiedAt: checkedAt })
      .where(eq(realEstateListings.id, listingId));
    return 'gone';
  }

  const checkedMs = Date.parse(checkedAt);
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
    .set({ expectedEndAt: new Date(nextMs).toISOString(), verifiedAt: checkedAt })
    .where(eq(realEstateListings.id, listingId));
  return 'verified';
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

/** Deletes listings gone for fourteen days; their price history goes with them. Without this the table only grows. */
export async function deleteLongGoneListings(
  db: DatabaseOrTransaction,
  input: { sourceId: string; asOf: string },
): Promise<number> {
  const before = new Date(Date.parse(input.asOf) - GONE_RETENTION_DAYS * DAY_MS).toISOString();
  const rows = await db
    .delete(realEstateListings)
    .where(
      and(
        eq(realEstateListings.sourceId, input.sourceId),
        eq(realEstateListings.status, 'gone'),
        lt(realEstateListings.goneAt, before),
      ),
    )
    .returning({ id: realEstateListings.id });
  return rows.length;
}
