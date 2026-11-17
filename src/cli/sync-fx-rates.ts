import { db } from '../db/client.js';
import { nbgFetcher } from '../fx/nbg.js';
import { syncFxRates } from '../fx/sync.js';
import { logger } from '../logger.js';
import { resolveUserAgent } from '../net/user-agent.js';

/**
 * Brings the National Bank of Georgia's exchange rates up to date
 * (`npm run fx:sync`, Phase 17D): from the day after the last one stored, or
 * from 2026-01-01 on an empty table (the back-fill, about 320 requests a
 * second apart), to tomorrow once NBG has set it. Run after each job
 * pipeline (`deploy/run-pipeline.sh`), where it costs a request or two and
 * never changes the pipeline's exit code.
 *
 *   --from=YYYY-MM-DD   re-check from that day; stored days are kept as they are
 */
function parseFrom(argv: readonly string[]): string | undefined {
  const arg = argv.find((value) => value.startsWith('--from='));
  if (!arg) return undefined;
  const day = arg.slice('--from='.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) {
    throw new Error(`--from wants a day as YYYY-MM-DD, got "${day}"`);
  }
  return day;
}

async function main(): Promise<void> {
  const result = await syncFxRates(db, {
    fetchJson: nbgFetcher(resolveUserAgent()),
    now: new Date().toISOString(),
    from: parseFrom(process.argv.slice(2)),
    delayMs: 1000,
  });
  if (result.ok) {
    logger.info(result, 'exchange rates synced');
  } else {
    logger.error(result, 'exchange rates sync stopped');
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'exchange rates sync failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
