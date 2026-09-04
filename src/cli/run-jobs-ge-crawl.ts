import { sql } from 'drizzle-orm';
import { DEFAULT_MISSING_STREAK_THRESHOLD, runJobsGeCrawl } from '../adapters/jobs-ge/crawl.js';
import { db } from '../db/client.js';
import { CrawlAlreadyRunningError } from '../db/ingest.js';
import { logger } from '../logger.js';
import { createHttpFetcher } from '../net/http-fetcher.js';
import { createRateLimiter } from '../net/rate-limiter.js';
import { resolveUserAgent } from '../net/user-agent.js';
import { isJobsGeUrlAllowed, jobsGePolicy } from '../policies/jobs-ge.js';

/**
 * One-shot production entry point for a single jobs.ge crawl — meant to be
 * invoked by an external scheduler (Windows Task Scheduler locally per
 * concept §19.1; a future always-on deployment's own scheduler later), not
 * run as a long-lived process itself. Exits non-zero on any failure the
 * scheduler should treat as a failed run, per §19.1's "must not silently
 * skip a run."
 */
async function main(): Promise<void> {
  // Configuration and source-policy validity are enforced at import time
  // (db/client.ts throws if DATABASE_URL is unset; policies/jobs-ge.ts's
  // Zod .parse() throws if the policy is malformed) — reaching here already
  // satisfies those two of §19.1's four preflight checks. The database
  // check below is the one that can only be done by actually asking the
  // database, not by inspecting local state.
  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    logger.error(
      { err },
      'jobs.ge crawl: database preflight check failed — aborting rather than skipping silently',
    );
    throw err;
  }

  const httpFetcher = createHttpFetcher({
    isUrlAllowed: isJobsGeUrlAllowed,
    rateLimiter: createRateLimiter(jobsGePolicy.rateLimit),
    userAgent: resolveUserAgent(),
  });

  const startedAtMs = Date.now();
  try {
    // The fourth preflight check (lock): startCrawlRun's partial unique
    // index rejects a second concurrent run for this source, surfaced here
    // as CrawlAlreadyRunningError — see the catch block below.
    const { crawlRun } = await runJobsGeCrawl(
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
      'jobs.ge crawl finished',
    );

    // 'completed' is the only fully-healthy outcome; 'partial' and
    // 'quarantined' mean the run finished without crashing but discovery or
    // parsing tripped one of runJobsGeCrawl's own health guards — real
    // conditions worth a non-zero exit so a scheduler surfaces them, not a
    // crash to investigate the same way as a thrown error below.
    if (crawlRun.status !== 'completed') {
      process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof CrawlAlreadyRunningError) {
      // Not a failure — see its own doc comment in db/ingest.ts: no run was
      // created, so there is nothing to mark failed or retry.
      logger.warn(
        { sourceId: err.sourceId },
        'jobs.ge crawl: a run is already in progress for this source — skipping this invocation',
      );
      return;
    }
    logger.error({ err }, 'jobs.ge crawl: run failed');
    process.exitCode = 1;
  } finally {
    await httpFetcher.close();
  }
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'jobs.ge crawl: unexpected top-level failure');
    process.exitCode = 1;
  })
  .finally(async () => {
    // A one-shot CLI process, unlike the test suite's shared long-lived
    // pool — an open Pool would otherwise keep the event loop alive and the
    // scheduler would never see this process exit.
    await db.$client.end();
  });
