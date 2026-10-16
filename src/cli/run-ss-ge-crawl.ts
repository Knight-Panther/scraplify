import { sql } from 'drizzle-orm';
import { runSsGeCrawl, SsGeNoBaselineError } from '../adapters/ss-ge/crawl.js';
import { db, pool } from '../db/client.js';
import { acquireCrawlProcessLock } from '../db/crawl-process-lock.js';
import { logger } from '../logger.js';
import { createHttpFetcher } from '../net/http-fetcher.js';
import { createRateLimiter } from '../net/rate-limiter.js';
import { resolveUserAgent } from '../net/user-agent.js';
import { isSsGeUrlAllowed, ssGePolicy, ssGeSource } from '../policies/ss-ge.js';
import { parseSsGeOptions } from './ss-ge-options.js';

/**
 * Results pages are slow: a median of 6.8 s on the broad lists, and 8 to
 * 20 s when a request passes the end of one (guideline §4.5). 60 s covers
 * those without hanging a run on a dead socket.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * One-shot entry point for a single ss.ge run, the same shape as
 * src/cli/run-etenders-ge-crawl.ts (see src/cli/run-jobs-ge-crawl.ts for the
 * reasoning behind the preflight, the process lock, and why a skipped or
 * partial run must never exit 0).
 *
 * The run rows are in `realestate.crawl_runs`, which the process lock knows
 * nothing about, so `runSsGeCrawl` settles a dead process's run itself; it
 * relies on the lock taken here to know that such a run is dead.
 */
async function main(): Promise<void> {
  const options = parseSsGeOptions(process.argv.slice(2));
  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    logger.error(
      { err },
      'ss.ge crawl: database preflight check failed — aborting rather than skipping silently',
    );
    throw err;
  }

  const lock = await acquireCrawlProcessLock(pool, ssGeSource.id);
  if (lock === null) {
    logger.error(
      { sourceId: ssGeSource.id },
      'ss.ge crawl: another crawl process for this source is running — skipping this invocation',
    );
    process.exitCode = 1;
    return;
  }

  const rateLimiter = createRateLimiter(ssGePolicy.rateLimit);
  const httpFetcher = createHttpFetcher({
    isUrlAllowed: isSsGeUrlAllowed,
    rateLimiter,
    userAgent: resolveUserAgent(),
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });

  const startedAtMs = Date.now();
  try {
    const { crawlRun } = await runSsGeCrawl({ db, httpFetcher }, options);
    logger.info(
      {
        crawlRunId: crawlRun.id,
        mode: crawlRun.mode,
        status: crawlRun.status,
        durationMs: Date.now() - startedAtMs,
        requestCount: crawlRun.requestCount,
        failedRequestCount: crawlRun.failedRequestCount,
        pageCount: crawlRun.pageCount,
        rowCount: crawlRun.rowCount,
        newCount: crawlRun.newCount,
        changedCount: crawlRun.changedCount,
        bumpedCount: crawlRun.bumpedCount,
        unchangedCount: crawlRun.unchangedCount,
        reopenedCount: crawlRun.reopenedCount,
        goneCount: crawlRun.goneCount,
        verifiedCount: crawlRun.verifiedCount,
        progress: crawlRun.progress,
        notes: crawlRun.notes,
        rateLimitBackOffs: rateLimiter.backOffCount,
      },
      'ss.ge crawl finished',
    );
    if (crawlRun.status !== 'completed') process.exitCode = 1;
  } catch (err) {
    if (err instanceof SsGeNoBaselineError) {
      logger.error({ sourceId: ssGeSource.id }, err.message);
    } else {
      logger.error({ err }, 'ss.ge crawl: run failed');
    }
    process.exitCode = 1;
  } finally {
    await httpFetcher.close();
    await lock.release();
  }
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'ss.ge crawl: unexpected top-level failure');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
