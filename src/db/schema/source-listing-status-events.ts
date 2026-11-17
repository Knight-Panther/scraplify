import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { crawlRuns } from './runs.js';
import { sourceListings, sourceListingStatusEnum } from './source-listings.js';

/**
 * Every change of `source_listings.status`, one row per real change (Phase
 * 17C, docs/PHASE_17_PLAN.md). The listing row keeps only its current status;
 * this keeps when it became active, went missing, closed, expired, reopened
 * or was quarantined, so a job's or tender's open and closed spells can be
 * rebuilt later (17E's `job_lives`).
 *
 * Written in the same statement or transaction as the status change by each
 * writer (`src/db/write-source-listing-revision.ts`,
 * `src/db/reconcile-source-listings.ts`, the etenders.ge and summer-school
 * crawls), never by a trigger, so each row carries the writer's own reason and
 * crawl run. Never updated or deleted: only the test cleanup and retention's
 * tier 3 (off for good since 17.0) remove rows.
 *
 * - `from_status` is null only for a listing's first event: the observation
 *   that created the row, or the one-shot backfill (`approximate`) for a
 *   listing that existed before this table. The partial unique index allows
 *   one such row per listing, which is what makes the backfill idempotent.
 * - `approximate` marks a backfilled time, inferred from the listing's own
 *   timestamps rather than observed (`src/db/status-events.ts`).
 * - `reason` is one of `StatusEventReason` (`src/db/status-events.ts`). Text,
 *   not an enum, so a new writer adds a reason without a migration.
 */
export const sourceListingStatusEvents = pgTable(
  'source_listing_status_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sourceListingId: uuid('source_listing_id')
      .notNull()
      .references(() => sourceListings.id),
    fromStatus: sourceListingStatusEnum('from_status'),
    toStatus: sourceListingStatusEnum('to_status').notNull(),
    at: timestamp('at', { mode: 'string', withTimezone: true }).notNull(),
    crawlRunId: uuid('crawl_run_id').references(() => crawlRuns.id),
    approximate: boolean('approximate').notNull().default(false),
    reason: text('reason').notNull(),
  },
  (table) => [
    index('source_listing_status_events_listing_at_idx').on(table.sourceListingId, table.at),
    uniqueIndex('source_listing_status_events_first_idx')
      .on(table.sourceListingId)
      .where(sql`${table.fromStatus} is null`),
    // Only a real change is an event.
    check(
      'source_listing_status_events_change_check',
      sql`${table.fromStatus} is null or ${table.fromStatus} <> ${table.toStatus}`,
    ),
  ],
);

export type SourceListingStatusEventRow = typeof sourceListingStatusEvents.$inferSelect;
