import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { countPendingReview, runDedupe } from '../dedupe/run-dedupe.js';
import { logger } from '../logger.js';

/**
 * One-shot cross-source deduplication pass (§14).
 *
 * `--auto-link` is opt-in and off by default, deliberately. Without it the
 * pass is read-only with respect to canonical state: it scores every candidate
 * pair and records the decisions, but creates no opportunities and no
 * memberships. That makes "look at what it would do" the default and "act on
 * it" an explicit choice — the right default for the operation §14.2 calls out
 * as the one where false positives are most damaging.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { 'auto-link': { type: 'boolean', default: false } },
    strict: true,
    allowPositionals: false,
  });

  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    logger.error({ err }, 'dedupe: database preflight check failed');
    throw err;
  }

  const startedAtMs = Date.now();
  const result = await runDedupe(db, { autoLink: values['auto-link'] });
  const pendingReview = await countPendingReview(db);

  logger.info(
    {
      autoLink: values['auto-link'],
      durationMs: Date.now() - startedAtMs,
      listingsConsidered: result.listingsConsidered,
      pairsCompared: result.pairsCompared,
      candidatesWritten: result.candidatesWritten,
      byDecision: result.byDecision,
      opportunitiesCreated: result.opportunitiesCreated,
      membershipsCreated: result.membershipsCreated,
      pendingReview,
    },
    'dedupe pass finished',
  );
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'dedupe: run failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
