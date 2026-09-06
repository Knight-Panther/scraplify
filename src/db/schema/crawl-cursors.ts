import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sources } from './sources.js';

/**
 * One durable state row per source, separate from individual crawl attempts.
 * The detail cursor changes only for known progress or a healthy full sweep.
 * The cooldown can only be extended, independently of cursor changes.
 * Read all three under the source crawl lock; incremental polls leave the
 * cursors alone. Each field is written by its own statement that touches no
 * other field, so a cooldown never clobbers a cursor and vice versa.
 */
export const crawlCursors = pgTable('crawl_cursors', {
  sourceId: uuid('source_id')
    .primaryKey()
    .references(() => sources.id),
  /** The `sourceRecordId` to resume from; null means "start from the top" (no cursor, or the last sweep completed fully). */
  nextSourceRecordId: text('next_source_record_id'),
  /**
   * The index page to resume the discovery walk at; null means "start at
   * page 1" (no interrupted walk, or the last walk reached the terminator).
   * The detail cursor alone cannot carry a walk forward: it is applied only
   * after discovery, so a walk stopped mid-index by a rate limit would
   * otherwise restart at page 1 every invocation and never reach the pages
   * beyond its stopping point (adversarial review, 2026-09-06).
   */
  nextDiscoveryPage: integer('next_discovery_page'),
  /** Earliest next source request, retained across CLI/scheduler invocations. */
  nextFetchAt: timestamp('next_fetch_at', { mode: 'string', withTimezone: true }),
  updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true }).notNull(),
});

export type CrawlCursorRow = typeof crawlCursors.$inferSelect;
export type NewCrawlCursorRow = typeof crawlCursors.$inferInsert;
