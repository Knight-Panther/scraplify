import { sql } from 'drizzle-orm';
import { runSummerSchoolsCrawl } from '../adapters/summerschoolsineurope-eu/crawl.js';
import { db, pool } from '../db/client.js';
import { acquireCrawlProcessLock } from '../db/crawl-process-lock.js';
import { CrawlAlreadyRunningError } from '../db/ingest.js';
import { logger } from '../logger.js';
import { createHttpFetcher } from '../net/http-fetcher.js';
import { createRateLimiter } from '../net/rate-limiter.js';
import { resolveUserAgent } from '../net/user-agent.js';
import {
  isSummerSchoolsEuUrlAllowed,
  summerSchoolsEuPolicy,
  summerSchoolsEuSource,
} from '../policies/summerschoolsineurope-eu.js';
import { parseSummerSchoolsEuOptions } from './summerschoolsineurope-eu-options.js';

/**
 * Filtered listings are built uncached at the origin and took up to 4.7 s
 * (2026-11-13); 30 s covers a slow one without hanging a run on a dead socket.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * One-shot entry point for a single summerschoolsineurope.eu run, the same
 * shape as src/cli/run-etenders-ge-crawl.ts (see src/cli/run-jobs-ge-crawl.ts
 * for the reasoning behind the preflight, the process lock, and why a
 * skipped or partial run must never exit 0). Requests keep to the site's
 * `Crawl-delay: 15` through the policy's rate limit.
 */
async function main(): Promise<void> {
  const options = parseSummerSchoolsEuOptions(process.argv.slice(2));
  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    logger.error(
      { err },
      'summerschoolsineurope.eu crawl: database preflight check failed — aborting rather than skipping silently',
    );
    throw err;
  }

  const lock = await acquireCrawlProcessLock(pool, summerSchoolsEuSource.id);
  if (lock === null) {
    logger.error(
      { sourceId: summerSchoolsEuSource.id },
      'summerschoolsineurope.eu crawl: another crawl process for this source is running — skipping this invocation',
    );
    process.exitCode = 1;
    return;
  }
  if (lock.settledOrphanRunIds.length > 0) {
    logger.warn(
      { crawlRunIds: lock.settledOrphanRunIds },
      'summerschoolsineurope.eu crawl: settled runs left unsettled by a crawl process that died, as failed',
    );
  }

  const rateLimiter = createRateLimiter(summerSchoolsEuPolicy.rateLimit);
  const httpFetcher = createHttpFetcher({
    isUrlAllowed: isSummerSchoolsEuUrlAllowed,
    rateLimiter,
    userAgent: resolveUserAgent(),
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });

  const startedAtMs = Date.now();
  try {
    const { crawlRun, stats } = await runSummerSchoolsCrawl({ db, httpFetcher }, options);
    logger.info(
      {
        crawlRunId: crawlRun.id,
        status: crawlRun.status,
        durationMs: Date.now() - startedAtMs,
        discoveredCount: crawlRun.discoveredCount,
        newCount: crawlRun.newCount,
        changedCount: crawlRun.changedCount,
        unchangedCount: crawlRun.unchangedCount,
        skippedCount: crawlRun.skippedCount,
        missingCount: crawlRun.missingCount,
        expiredCount: crawlRun.expiredCount,
        reopenedCount: crawlRun.reopenedCount,
        quarantinedCount: crawlRun.quarantinedCount,
        failedCount: crawlRun.failedCount,
        rateLimitBackOffs: rateLimiter.backOffCount,
        ...stats,
      },
      'summerschoolsineurope.eu crawl finished',
    );
    if (crawlRun.status !== 'completed') process.exitCode = 1;
  } catch (err) {
    if (err instanceof CrawlAlreadyRunningError) {
      logger.error(
        { sourceId: err.sourceId },
        'summerschoolsineurope.eu crawl: an unsettled run exists for this source that no lock-holding process owns — skipping this invocation',
      );
      process.exitCode = 1;
      return;
    }
    logger.error({ err }, 'summerschoolsineurope.eu crawl: run failed');
    process.exitCode = 1;
  } finally {
    await httpFetcher.close();
    await lock.release();
  }
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'summerschoolsineurope.eu crawl: unexpected top-level failure');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
