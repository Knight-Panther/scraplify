import { sql } from 'drizzle-orm';
import { DEFAULT_MISSING_STREAK_THRESHOLD, runHrGeCrawl } from '../adapters/hr-ge/crawl.js';
import { db } from '../db/client.js';
import { CrawlAlreadyRunningError } from '../db/ingest.js';
import { logger } from '../logger.js';
import { createHttpFetcher } from '../net/http-fetcher.js';
import { createRateLimiter } from '../net/rate-limiter.js';
import { resolveUserAgent } from '../net/user-agent.js';
import { hrGePolicy, isHrGeUrlAllowed } from '../policies/hr-ge.js';

/**
 * One-shot production entry point for a single hr.ge crawl — mirrors
 * src/cli/run-jobs-ge-crawl.ts exactly (see there for the fuller rationale
 * behind every piece here: the four §19.1 preflight checks, the
 * CrawlAlreadyRunningError branch's "cannot tell routine-overlap from a
 * stale lock apart" reasoning, and why this must never exit 0 on a skipped
 * run). Meant to be invoked by an external scheduler, not run as a
 * long-lived process itself.
 */
async function main(): Promise<void> {
  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    logger.error(
      { err },
      'hr.ge crawl: database preflight check failed — aborting rather than skipping silently',
    );
    throw err;
  }

  const httpFetcher = createHttpFetcher({
    isUrlAllowed: isHrGeUrlAllowed,
    rateLimiter: createRateLimiter(hrGePolicy.rateLimit),
    userAgent: resolveUserAgent(),
  });

  const startedAtMs = Date.now();
  try {
    const { crawlRun } = await runHrGeCrawl(
      { db, httpFetcher },
      { missingStreakThreshold: DEFAULT_MISSING_STREAK_THRESHOLD },
    );

    logger.info(
      {
        crawlRunId: crawlRun.id,
        status: crawlRun.status,
        durationMs: Date.now() - startedAtMs,
        discoveredCount: crawlRun.discoveredCount,
        vipCount: crawlRun.vipCount,
        standardCount: crawlRun.standardCount,
        newCount: crawlRun.newCount,
        changedCount: crawlRun.changedCount,
        unchangedCount: crawlRun.unchangedCount,
        missingCount: crawlRun.missingCount,
        expiredCount: crawlRun.expiredCount,
        reopenedCount: crawlRun.reopenedCount,
        quarantinedCount: crawlRun.quarantinedCount,
        failedCount: crawlRun.failedCount,
      },
      'hr.ge crawl finished',
    );

    if (crawlRun.status !== 'completed') {
      process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof CrawlAlreadyRunningError) {
      logger.error(
        { sourceId: err.sourceId },
        "hr.ge crawl: a run is already in progress for this source, or an earlier run crashed before settling — skipping this invocation. If no crawl is actually running, clear the stale lock: update crawl_runs set status = 'failed', reconciled_at = now() where source_id = '<id>' and reconciled_at is null",
      );
      process.exitCode = 1;
      return;
    }
    logger.error({ err }, 'hr.ge crawl: run failed');
    process.exitCode = 1;
  } finally {
    await httpFetcher.close();
  }
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'hr.ge crawl: unexpected top-level failure');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
