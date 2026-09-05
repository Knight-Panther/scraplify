import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { resources } from './resources.js';
import { sources } from './sources.js';

/**
 * 'quarantined' is the run itself flagged anomalous (§21.3) — distinct
 * from the quarantinedCount column below, which counts individual
 * listings quarantined during an otherwise-healthy run.
 */
export const crawlRunStatusEnum = pgEnum('crawl_run_status', [
  'running',
  'completed',
  'failed',
  'partial',
  'quarantined',
]);
export const fetchOutcomeEnum = pgEnum('fetch_outcome', ['success', 'retry', 'failure', 'blocked']);

/** Mirrors CrawlRunSchema. */
export const crawlRuns = pgTable(
  'crawl_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    startedAt: timestamp('started_at', { mode: 'string', withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { mode: 'string', withTimezone: true }),
    /**
     * Set only once this run is fully settled — reconciliation genuinely
     * ran (or, for a 'failed' run, definitely never will) — separately from
     * `status`, which flips to its terminal value earlier, before
     * reconciliation runs (closeMissingListings needs to read that
     * persisted terminal status to decide eligibility). The exclusivity
     * index below keys on THIS column, not `status`, specifically so the
     * lock survives the gap between "status set" and "reconciliation
     * committed" — see its own comment (adversarial review, 2026-09-05,
     * round 6).
     */
    reconciledAt: timestamp('reconciled_at', { mode: 'string', withTimezone: true }),
    status: crawlRunStatusEnum('status').notNull(),
    /** Mirrors CrawlRunSchema.fullCoverage — see its comment there. */
    fullCoverage: boolean('full_coverage').notNull().default(false),
    discoveredCount: integer('discovered_count').notNull().default(0),
    /**
     * Per-partition breakdown of discoveredCount (concept §26: "VIP and
     * standard sections are measured separately"). Persisted, not just
     * computed in memory, so a future run can compare its own vipCount
     * against this run's — the only way to tell "VIP is legitimately empty
     * today" apart from "the VIP parser silently broke" (adversarial
     * review, 2026-09-05, round 5: a combined-total collapse check alone
     * can't see a ~10-row VIP wipeout inside a ~5,647-row total).
     */
    vipCount: integer('vip_count').notNull().default(0),
    standardCount: integer('standard_count').notNull().default(0),
    newCount: integer('new_count').notNull().default(0),
    changedCount: integer('changed_count').notNull().default(0),
    unchangedCount: integer('unchanged_count').notNull().default(0),
    missingCount: integer('missing_count').notNull().default(0),
    expiredCount: integer('expired_count').notNull().default(0),
    reopenedCount: integer('reopened_count').notNull().default(0),
    quarantinedCount: integer('quarantined_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
  },
  (table) => [
    // At most one UNSETTLED crawl per source at a time — without this, two
    // overlapping runs (a scheduled trigger firing while a slow previous
    // run is still going, or while an earlier one's reconciliation is
    // still in flight) could each independently discover and reconcile the
    // same absent listing, each incrementing its missingStreak since each
    // has its own later startedAt, closing a listing off of overlapping
    // observations rather than genuinely consecutive ones (adversarial
    // review, 2026-09-05). Keyed on reconciledAt rather than status='running':
    // an earlier version released this lock the moment status flipped to
    // its terminal value, which happens BEFORE reconciliation runs —
    // reopening the exact overlap window this index exists to close, for
    // the entire gap between "status set" and "reconciliation committed"
    // (round 6). startCrawlRun (src/db/ingest.ts) catches this constraint's
    // violation and raises a typed CrawlAlreadyRunningError rather than a
    // raw Postgres error.
    uniqueIndex('crawl_runs_one_unsettled_per_source_idx')
      .on(table.sourceId)
      .where(sql`${table.reconciledAt} is null`),
  ],
);

/** Mirrors FetchAttemptSchema. */
export const fetchAttempts = pgTable('fetch_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  crawlRunId: uuid('crawl_run_id')
    .notNull()
    .references(() => crawlRuns.id),
  resourceId: uuid('resource_id')
    .notNull()
    .references(() => resources.id),
  attemptedAt: timestamp('attempted_at', { mode: 'string', withTimezone: true }).notNull(),
  statusCode: integer('status_code'),
  durationMs: integer('duration_ms'),
  outcome: fetchOutcomeEnum('outcome').notNull(),
  errorKind: text('error_kind'),
});

export type CrawlRunRow = typeof crawlRuns.$inferSelect;
export type NewCrawlRunRow = typeof crawlRuns.$inferInsert;
export type FetchAttemptRow = typeof fetchAttempts.$inferSelect;
export type NewFetchAttemptRow = typeof fetchAttempts.$inferInsert;
