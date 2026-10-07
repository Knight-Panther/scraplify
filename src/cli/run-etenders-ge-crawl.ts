import { sql } from 'drizzle-orm';
import { runEtendersGeCrawl } from '../adapters/etenders-ge/crawl.js';
import { db, pool } from '../db/client.js';
import { acquireCrawlProcessLock } from '../db/crawl-process-lock.js';
import { CrawlAlreadyRunningError } from '../db/ingest.js';
import { logger } from '../logger.js';
import { createHttpFetcher } from '../net/http-fetcher.js';
import { createRateLimiter } from '../net/rate-limiter.js';
import { resolveUserAgent } from '../net/user-agent.js';
import {
  etendersGePolicy,
  etendersGeSource,
  isEtendersGeUrlAllowed,
} from '../policies/etenders-ge.js';
import { parseEtendersGeOptions } from './etenders-ge-options.js';

/**
 * Slow IIS host: most pages answer in 0.2–1.5 s, but outliers of 8 s and
 * 34 s were measured, and one connect timed out at 90 s (docs/addEtender.md
 * §4). 60 s covers the slow pages without hanging a run on a dead socket.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * One-shot entry point for a single etenders.ge run, the same shape as
 * src/cli/run-hr-ge-crawl.ts (see src/cli/run-jobs-ge-crawl.ts for the
 * reasoning behind the preflight, the process lock, and why a skipped or
 * partial run must never exit 0).
 */
async function main(): Promise<void> {
  const options = parseEtendersGeOptions(process.argv.slice(2));
  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    logger.error(
      { err },
      'etenders.ge crawl: database preflight check failed — aborting rather than skipping silently',
    );
    throw err;
  }

  const lock = await acquireCrawlProcessLock(pool, etendersGeSource.id);
  if (lock === null) {
    logger.error(
      { sourceId: etendersGeSource.id },
      'etenders.ge crawl: another crawl process for this source is running — skipping this invocation',
    );
    process.exitCode = 1;
    return;
  }
  if (lock.settledOrphanRunIds.length > 0) {
    logger.warn(
      { crawlRunIds: lock.settledOrphanRunIds },
      'etenders.ge crawl: settled runs left unsettled by a crawl process that died, as failed',
    );
  }

  const rateLimiter = createRateLimiter(etendersGePolicy.rateLimit);
  const httpFetcher = createHttpFetcher({
    isUrlAllowed: isEtendersGeUrlAllowed,
    rateLimiter,
    userAgent: resolveUserAgent(),
    // The site answers "not found" and "page out of range" with 302s; the
    // adapter reads them instead of following them.
    redirect: 'manual',
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });

  const startedAtMs = Date.now();
  try {
    const { crawlRun, stats } = await runEtendersGeCrawl({ db, httpFetcher }, options);
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
      'etenders.ge crawl finished',
    );
    if (crawlRun.status !== 'completed') process.exitCode = 1;
  } catch (err) {
    if (err instanceof CrawlAlreadyRunningError) {
      logger.error(
        { sourceId: err.sourceId },
        'etenders.ge crawl: an unsettled run exists for this source that no lock-holding process owns — skipping this invocation',
      );
      process.exitCode = 1;
      return;
    }
    logger.error({ err }, 'etenders.ge crawl: run failed');
    process.exitCode = 1;
  } finally {
    await httpFetcher.close();
    await lock.release();
  }
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'etenders.ge crawl: unexpected top-level failure');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
