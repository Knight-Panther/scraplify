import { sql } from 'drizzle-orm';
import { runJobsGeCrawl } from '../adapters/jobs-ge/crawl.js';
import { db } from '../db/client.js';
import { CrawlAlreadyRunningError } from '../db/ingest.js';
import { logger } from '../logger.js';
import { createHttpFetcher } from '../net/http-fetcher.js';
import { createRateLimiter } from '../net/rate-limiter.js';
import { resolveUserAgent } from '../net/user-agent.js';
import { isJobsGeUrlAllowed, jobsGePolicy } from '../policies/jobs-ge.js';
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
    const { crawlRun } = await runJobsGeCrawl({ db, httpFetcher }, options);

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
      // skipped run to never pass silently, and process.exitCode was
      // previously left at 0 here, which would make Task Scheduler report
      // indefinite silent "success" both for the routine case (a previous
      // run for this source is still genuinely in flight) and for the
      // stale-lock case (an earlier run crashed before ever reaching
      // reconciledAt — see docs/STATUS.md's round-2 notes — and every
      // future invocation will keep hitting this same branch until that
      // row is cleared by hand: `update crawl_runs set status = 'failed',
      // reconciled_at = now() where source_id = <id> and reconciled_at is
      // null`). This process cannot tell those two cases apart on its own,
      // so it surfaces both as a loud, actionable failure rather than
      // guessing.
      logger.error(
        { sourceId: err.sourceId },
        "jobs.ge crawl: a run is already in progress for this source, or an earlier run crashed before settling — skipping this invocation. If no crawl is actually running, clear the stale lock: update crawl_runs set status = 'failed', reconciled_at = now() where source_id = '<id>' and reconciled_at is null",
      );
      process.exitCode = 1;
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
