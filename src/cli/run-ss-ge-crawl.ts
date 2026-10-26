import { sql } from 'drizzle-orm';
import { runSsGeCrawl, SsGeNoBaselineError } from '../adapters/ss-ge/crawl.js';
import { db, pool } from '../db/client.js';
import { acquireCrawlProcessLock } from '../db/crawl-process-lock.js';
import { logger } from '../logger.js';
import { createHttpFetcher } from '../net/http-fetcher.js';
import { answersThroughProxy, proxyDispatcherFromEnv } from '../net/proxy-dispatcher.js';
import { withProxyRecovery } from '../net/proxy-recovery.js';
import { createRateLimiter } from '../net/rate-limiter.js';
import { resolveUserAgent } from '../net/user-agent.js';
import { isSsGeUrlAllowed, ssGePolicy, ssGeSource } from '../policies/ss-ge.js';
import { regroupListings } from '../realestate/grouping.js';
import { parseSsGeOptions } from './ss-ge-options.js';

/**
 * Results pages are slow: a median of 6.8 s on the broad lists, and 8 to
 * 20 s when a request passes the end of one (guideline §4.5). 60 s covers
 * those without hanging a run on a dead socket.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * How long one run may wait, over all outages together, for the Georgian
 * proxy to come back (RUNBOOK §3 step 9): the laptop may be off when the
 * 21:30 UTC run starts, or reboot or lose its internet during it. Ten hours
 * keeps the run inside its unit's 20-hour limit and clear of the next night.
 */
const PROXY_MAX_WAIT_MS = 10 * 60 * 60 * 1000;
/** Between checks while waiting: a check of a tunnel that is down sends nothing to ss.ge. */
const PROXY_POLL_MS = 60_000;

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

  // ss.ge answers only Georgian addresses (2026-10-22), so on the French host
  // its requests leave through a Georgian proxy when SS_GE_PROXY_URL is set.
  const proxy = proxyDispatcherFromEnv('SS_GE_PROXY_URL');
  if (proxy !== null) logger.info({ proxy: proxy.label }, 'ss.ge crawl: fetching through a proxy');
  const rateLimiter = createRateLimiter(ssGePolicy.rateLimit);
  const userAgent = resolveUserAgent();
  const directFetcher = createHttpFetcher({
    isUrlAllowed: isSsGeUrlAllowed,
    rateLimiter,
    userAgent,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    ...(proxy === null ? {} : { dispatcher: proxy.dispatcher }),
  });
  const httpFetcher =
    proxy === null
      ? directFetcher
      : withProxyRecovery(directFetcher, {
          label: proxy.label,
          probe: () => answersThroughProxy(proxy.dispatcher, ssGePolicy.robotsUrl, userAgent),
          maxWaitMs: PROXY_MAX_WAIT_MS,
          pollMs: PROXY_POLL_MS,
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
    await regroup();
  } catch (err) {
    if (err instanceof SsGeNoBaselineError) {
      logger.error({ sourceId: ssGeSource.id }, err.message);
    } else {
      logger.error({ err }, 'ss.ge crawl: run failed');
    }
    process.exitCode = 1;
  } finally {
    await httpFetcher.close();
    await proxy?.dispatcher.close();
    await lock.release();
  }
}

/**
 * Look-alike groups over every active listing (Phase 11D), after any run that
 * got as far as a crawl row, partial ones included: what changed is in the
 * table either way. A failure here is logged and leaves the exit code to the
 * crawl, so Hermes is not told a good crawl failed; the tab shows last
 * night's groups until the next run.
 */
async function regroup(): Promise<void> {
  const startedAtMs = Date.now();
  try {
    const result = await regroupListings(db, {
      sourceId: ssGeSource.id,
      now: new Date().toISOString(),
    });
    logger.info(
      { ...result, durationMs: Date.now() - startedAtMs },
      'ss.ge look-alike groups updated',
    );
  } catch (err) {
    logger.error({ err }, 'ss.ge look-alike grouping failed; the previous groups stay');
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
