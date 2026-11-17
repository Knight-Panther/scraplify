import { db } from '../db/client.js';
import { backfillStatusEvents } from '../db/status-events.js';
import { logger } from '../logger.js';

/**
 * Gives every job and tender listing older than the status timeline its first,
 * approximate event (`npm run status-events:backfill`, Phase 17C), once after
 * the release that brings migration 0058. Makes no request to any source. A
 * second run writes nothing, which is how the deploy checks it.
 */
async function main(): Promise<void> {
  const startedAtMs = Date.now();
  const result = await db.transaction((tx) => backfillStatusEvents(tx));
  logger.info({ ...result, durationMs: Date.now() - startedAtMs }, 'status events backfilled');
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'status events backfill failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
