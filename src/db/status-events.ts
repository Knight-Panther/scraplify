import { type SQL, sql } from 'drizzle-orm';
import {
  type SourceListingRow,
  sourceListingStatusEvents,
  sourceListings,
} from './schema/index.js';
import type { DatabaseOrTransaction } from './types.js';

/**
 * Phase 17C (docs/PHASE_17_PLAN.md): the status timeline of jobs and tenders.
 * Every writer of `source_listings.status` records the change here, in the
 * same transaction or statement, and only when the status really changes
 * (the table's check constraint refuses a row whose two statuses are equal).
 */

export type SourceListingStatus = SourceListingRow['status'];

/**
 * Why a listing's status changed. Text in the database, so a new writer adds
 * a reason here without a migration.
 */
export type StatusEventReason =
  /** The observation that created the listing row (`from_status` null). */
  | 'first_seen'
  /** discovered → active: its first successful read. */
  | 'activated'
  /** missing_suspected → active: seen again before it closed. */
  | 'seen_again'
  /** closed, expired or quarantined → active, on a confirmed reappearance (`allowReopen`). */
  | 'reopened'
  /** → quarantined: its page was fetched but could not be parsed. */
  | 'quarantined'
  /** → missing_suspected: absent from a complete reconciliation (also a capped mass closure). */
  | 'reconcile_missing'
  /** → closed: absent across the missing-streak threshold. */
  | 'reconcile_closed'
  /** → expired: its deadline passed. */
  | 'deadline_expired'
  /** → expired: a course's start date passed (summerschoolsineurope.eu). */
  | 'course_started'
  /** → closed: the source states the end (etenders.ge: terminated, failed, completed). */
  | 'source_status'
  /** → missing_suspected or closed: the source's own "not found" answer (etenders.ge). */
  | 'not_found'
  /** The one-shot backfill's approximate first event for a listing older than the table. */
  | 'backfill';

export interface StatusEventInput {
  sourceListingId: string;
  /** Null only for the observation that created the listing row. */
  fromStatus: SourceListingStatus | null;
  toStatus: SourceListingStatus;
  at: string;
  crawlRunId: string | null;
  reason: StatusEventReason;
}

/**
 * One listing's change, inside the writer's own transaction. A call whose two
 * statuses are equal writes nothing and returns false, so a writer can call it
 * after every update without testing for a change itself.
 */
export async function recordStatusEvent(
  tx: DatabaseOrTransaction,
  input: StatusEventInput,
): Promise<boolean> {
  if (input.fromStatus === input.toStatus) return false;
  await tx.insert(sourceListingStatusEvents).values({
    sourceListingId: input.sourceListingId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    at: input.at,
    crawlRunId: input.crawlRunId,
    approximate: false,
    reason: input.reason,
  });
  return true;
}

export interface ChangeStatusWhereInput {
  /** Which listings: a condition over the unaliased `source_listings` table. */
  where: SQL;
  toStatus: SourceListingStatus;
  /** Further assignments of the same UPDATE, e.g. `missing_streak = … + 1`; their targets unqualified. */
  alsoSet?: SQL;
  at: string;
  crawlRunId: string | null;
  reason: StatusEventReason;
}

export interface ChangedListing {
  id: string;
  fromStatus: SourceListingStatus;
}

/**
 * The set-based status change every bulk writer uses: one statement that
 * locks the matching rows (reading each one's status as it is once the lock is
 * held), updates them, and inserts an event for each whose status changed.
 * Returns every updated row, changed or not: a reconciliation pass also
 * advances the missing streak of rows already `missing_suspected`.
 *
 * `FOR UPDATE` in the first step keeps the old behaviour of a plain UPDATE
 * under READ COMMITTED: a row a concurrent writer changes is waited for and
 * then re-checked against `where`, so a listing that writer has just seen is
 * left out, and the recorded `from_status` is the one actually replaced.
 */
export async function changeStatusWhere(
  db: DatabaseOrTransaction,
  input: ChangeStatusWhereInput,
): Promise<ChangedListing[]> {
  const prior = sql.raw('prior');
  const changed = sql.raw('changed');
  const { rows } = await db.execute<{ id: string; from_status: SourceListingStatus }>(sql`
    with ${prior} as (
      select ${sourceListings.id} as id, ${sourceListings.status} as status
        from ${sourceListings}
       where ${input.where}
         for update
    ), ${changed} as (
      update ${sourceListings}
         set status = ${input.toStatus}::source_listing_status${input.alsoSet === undefined ? sql`` : sql`, ${input.alsoSet}`}
        from ${prior}
       where ${sourceListings.id} = ${prior}.id
      returning ${sourceListings.id} as id, ${prior}.status as from_status,
                ${sourceListings.status} as to_status
    ), events as (
      insert into ${sourceListingStatusEvents}
        (source_listing_id, from_status, to_status, at, crawl_run_id, approximate, reason)
      select id, from_status, to_status, ${input.at}::timestamptz, ${input.crawlRunId}::uuid,
             false, ${input.reason}
        from ${changed}
       where from_status <> to_status
    )
    select id, from_status from ${changed}`);
  return rows.map((row) => ({ id: row.id, fromStatus: row.from_status }));
}

export interface BackfillStatusEventsResult {
  /** First events written by this call, by the status they record. */
  inserted: Partial<Record<SourceListingStatus, number>>;
  total: number;
}

/**
 * One-shot backfill for listings older than the table (`npm run
 * status-events:backfill`). Each listing with no first event (`from_status`
 * null) gets one, `approximate`, recording the status it had before any event
 * was written, at a time inferred from its own columns:
 *
 * - `closed`: `greatest(last_seen_at, last_reconciled_at)`, the pass that
 *   closed it (the retention rule's own "dead since",
 *   src/retention/eligibility.ts);
 * - `expired`: its deadline, or `last_seen_at` when it has none;
 * - `active`, `missing_suspected` and `discovered`: `first_seen_at`, since the
 *   moment it went missing was never recorded;
 * - `quarantined`: `last_seen_at`, which quarantine sets.
 *
 * A listing that has already had an event since the release is backfilled
 * with that event's `from_status`, at no later than that event, so its
 * timeline stays in order. Idempotent: the partial unique index on first
 * events allows one per listing, and a second call inserts nothing.
 */
export async function backfillStatusEvents(
  db: DatabaseOrTransaction,
  options: { sourceIds?: readonly string[] } = {},
): Promise<BackfillStatusEventsResult> {
  const listing = sql.raw('listing');
  const events = sql.raw('events');
  const scope =
    options.sourceIds === undefined
      ? sql`true`
      : options.sourceIds.length === 0
        ? sql`false`
        : sql`${listing}.source_id in (${sql.join(
            options.sourceIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;
  const { rows } = await db.execute<{ to_status: SourceListingStatus; n: number }>(sql`
    with earliest as (
      select distinct on (source_listing_id) source_listing_id, from_status, at
        from ${sourceListingStatusEvents}
       order by source_listing_id, at, id
    ), first_events as (
      select ${listing}.id,
             coalesce(earliest.from_status, ${listing}.status) as status,
             ${listing}.first_seen_at, ${listing}.last_seen_at, ${listing}.last_reconciled_at,
             ${listing}.source_deadline_at, earliest.at as earliest_at
        from ${sourceListings} ${listing}
        left join earliest on earliest.source_listing_id = ${listing}.id
       where ${scope}
         and not exists (
           select 1 from ${sourceListingStatusEvents} ${events}
            where ${events}.source_listing_id = ${listing}.id and ${events}.from_status is null)
    ), inserted as (
      insert into ${sourceListingStatusEvents}
        (source_listing_id, from_status, to_status, at, crawl_run_id, approximate, reason)
      select id, null, status,
             least(
               case status
                 when 'closed' then greatest(last_seen_at, last_reconciled_at)
                 when 'expired' then coalesce(source_deadline_at, last_seen_at)
                 when 'quarantined' then last_seen_at
                 else first_seen_at
               end,
               earliest_at),
             null, true, 'backfill'
        from first_events
          on conflict (source_listing_id) where from_status is null do nothing
      returning to_status
    )
    select to_status, count(*)::int as n from inserted group by to_status`);
  const inserted: Partial<Record<SourceListingStatus, number>> = {};
  let total = 0;
  for (const row of rows) {
    inserted[row.to_status] = row.n;
    total += row.n;
  }
  return { inserted, total };
}
