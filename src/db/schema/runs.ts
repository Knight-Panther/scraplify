import { integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
export const crawlRuns = pgTable('crawl_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id')
    .notNull()
    .references(() => sources.id),
  startedAt: timestamp('started_at', { mode: 'string', withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { mode: 'string', withTimezone: true }),
  status: crawlRunStatusEnum('status').notNull(),
  discoveredCount: integer('discovered_count').notNull().default(0),
  newCount: integer('new_count').notNull().default(0),
  changedCount: integer('changed_count').notNull().default(0),
  unchangedCount: integer('unchanged_count').notNull().default(0),
  missingCount: integer('missing_count').notNull().default(0),
  expiredCount: integer('expired_count').notNull().default(0),
  reopenedCount: integer('reopened_count').notNull().default(0),
  quarantinedCount: integer('quarantined_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
});

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
