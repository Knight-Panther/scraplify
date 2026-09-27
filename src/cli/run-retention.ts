import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { logger } from '../logger.js';
import { runRetention } from '../retention/run-retention.js';

/**
 * `npm run retention` — one bounded retention pass (Phase 7C): dry run by
 * default, `--apply` actually mutates. Follows src/cli/run-dedupe.ts's own
 * shape.
 *
 * Unlike dedupe, this takes its OWN lock rather than a shared wrapper the
 * caller opens first — `runRetention` calls `withRetentionLocks` internally,
 * since it also has to hold every source's crawl-process lock, not just its
 * own advisory lock (src/retention/retention-lock.ts).
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { apply: { type: 'boolean', default: false } },
    strict: true,
    allowPositionals: false,
  });

  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    logger.error({ err }, 'retention: database preflight check failed');
    throw err;
  }

  const startedAtMs = Date.now();
  const outcome = await runRetention(db, pool, { now: new Date(), apply: values.apply });

  if (!outcome.ran) {
    logger.info({ reason: outcome.reason }, 'retention pass skipped');
    return;
  }

  logger.info(
    {
      apply: outcome.result.apply,
      durationMs: Date.now() - startedAtMs,
      tier1: outcome.result.tier1,
      tier2: outcome.result.tier2,
      tier3: outcome.result.tier3,
    },
    'retention pass finished',
  );
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'retention: run failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
