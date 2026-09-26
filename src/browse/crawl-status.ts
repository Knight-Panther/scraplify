import { inArray } from 'drizzle-orm';
import { CRAWL_SCHEDULES } from '../crawl-schedule.js';
import { publicCrawlStatus } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import type { CrawlStatusSnapshot } from './crawl-status-view.js';

export type { CrawlStatusSnapshot } from './crawl-status-view.js';

/**
 * "Last update / next update" per source, for the landing pages on every
 * surface. Reads only `public_crawl_status`, so the same query serves the
 * `public` role. `describeCrawlStatus` (`./crawl-status-view.ts`) turns a
 * snapshot into what to show at a given moment.
 */

/**
 * Postgres's own timestamp text ("2026-09-26 17:11:19.917+00") is not a
 * format every browser's `Date.parse` accepts, and these values are parsed
 * in the browser; ISO 8601 is.
 */
function iso(value: string | null | undefined): string | null {
  return value == null ? null : new Date(value).toISOString();
}

/** Sources listed in `CRAWL_SCHEDULES`, in that order; a source with no row yet still appears. */
export async function getCrawlStatus(
  db: DatabaseOrTransaction,
  sourceSlugs: readonly string[] = Object.keys(CRAWL_SCHEDULES),
): Promise<CrawlStatusSnapshot[]> {
  if (sourceSlugs.length === 0) return [];
  const rows = await db
    .select()
    .from(publicCrawlStatus)
    .where(inArray(publicCrawlStatus.sourceSlug, [...sourceSlugs]));
  const bySlug = new Map(rows.map((row) => [row.sourceSlug, row]));
  return sourceSlugs.map((sourceSlug) => {
    const row = bySlug.get(sourceSlug);
    return {
      sourceSlug,
      lastRunStartedAt: iso(row?.lastRunStartedAt),
      lastRunStatus: row?.lastRunStatus ?? null,
      lastCompletedAt: iso(row?.lastCompletedAt),
    };
  });
}
