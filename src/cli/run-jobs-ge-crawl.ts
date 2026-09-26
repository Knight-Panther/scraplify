import { sql } from 'drizzle-orm';
import { runJobsGeCrawl } from '../adapters/jobs-ge/crawl.js';
import { db, pool } from '../db/client.js';
import { acquireCrawlProcessLock } from '../db/crawl-process-lock.js';
import { CrawlAlreadyRunningError } from '../db/ingest.js';
import { logger } from '../logger.js';
import { createHttpFetcher } from '../net/http-fetcher.js';
import { createRateLimiter } from '../net/rate-limiter.js';
import { resolveUserAgent } from '../net/user-agent.js';
import { isJobsGeUrlAllowed, jobsGePolicy, jobsGeSource } from '../policies/jobs-ge.js';
import { parseJobsGeOptions } from './jobs-ge-options.js';

/**
 * One-shot production entry point for a single jobs.ge crawl — meant to be
 * invoked by an external scheduler (Windows Task Scheduler locally per
 * concept §19.1; a future always-on deployment's own scheduler later), not
 * run as a long-lived process itself. Exits non-zero on any failure the
 * scheduler should treat as a failed run, per §19.1's "must not silently
 * skip a run."
 */
async function main(): Promise<void> {
  // Parsed before the database preflight below so a malformed flag fails
  // immediately and loudly, without opening a connection or touching the
  // source — matching src/cli/run-hr-ge-crawl.ts.
  const options = parseJobsGeOptions(process.argv.slice(2));
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

  // The fourth preflight check (lock). A live crawl process for this source
  // holds this lock; getting it means none does, so any run still
  // unsettled was left by a process that died, and is settled as failed
  // here instead of blocking every later run (src/db/crawl-process-lock.ts).
  const lock = await acquireCrawlProcessLock(pool, jobsGeSource.id);
  if (lock === null) {
    logger.error(
      { sourceId: jobsGeSource.id },
      'jobs.ge crawl: another crawl process for this source is running — skipping this invocation',
    );
    process.exitCode = 1;
    return;
  }
  if (lock.settledOrphanRunIds.length > 0) {
    logger.warn(
      { crawlRunIds: lock.settledOrphanRunIds },
      'jobs.ge crawl: settled runs left unsettled by a crawl process that died, as failed',
    );
  }

  const httpFetcher = createHttpFetcher({
    isUrlAllowed: isJobsGeUrlAllowed,
    rateLimiter: createRateLimiter(jobsGePolicy.rateLimit),
    userAgent: resolveUserAgent(),
  });

  const startedAtMs = Date.now();
  try {
    // Behind the process lock, startCrawlRun's partial unique index still
    // rejects a second unsettled run for this source, surfaced here as
    // CrawlAlreadyRunningError — see the catch block below.
    const { crawlRun, refetch } = await runJobsGeCrawl({ db, httpFetcher }, options);

    logger.info(
      {
        crawlRunId: crawlRun.id,
        status: crawlRun.status,
        // Distinguishes a bounded incremental poll from a full-corpus walk in
        // the log itself - the two have very different discoveredCounts and
        // only one of them can ever drive closure.
        fullCoverage: crawlRun.fullCoverage,
        durationMs: Date.now() - startedAtMs,
        discoveredCount: crawlRun.discoveredCount,
        vipCount: crawlRun.vipCount,
        standardCount: crawlRun.standardCount,
        newCount: crawlRun.newCount,
        changedCount: crawlRun.changedCount,
        unchangedCount: crawlRun.unchangedCount,
        skippedCount: crawlRun.skippedCount,
        // Phase 7C: detail pages fetched, bootstrap adoptions, canaries and
        // canaries whose content had changed under an unchanged fingerprint.
        refetch,
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
      // No new crawl_runs row was created here, so there is nothing THIS
      // invocation could mark failed — but this must still exit non-zero
      // (adversarial review, 2026-09-05, round 8): concept §19.1 requires a
      // skipped run to never pass silently. With the process lock held,
      // this only happens when a crawl process from before the lock
      // existed is still running, or a run was started outside this CLI.
      logger.error(
        { sourceId: err.sourceId },
        'jobs.ge crawl: an unsettled run exists for this source that no lock-holding process owns — skipping this invocation',
      );
      process.exitCode = 1;
      return;
    }
    logger.error({ err }, 'jobs.ge crawl: run failed');
    process.exitCode = 1;
  } finally {
    await httpFetcher.close();
    await lock.release();
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
