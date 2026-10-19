import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { ssGeSource } from '../policies/ss-ge.js';
import { regroupListings } from '../realestate/grouping.js';

/**
 * Regroups ss.ge's active listings by hand (`npm run group:ss-ge`), as every
 * nightly crawl does at its end: for the first pass after Phase 11D is
 * deployed, or after a change to the rule. Makes no request to ss.ge.
 */
async function main(): Promise<void> {
  const startedAtMs = Date.now();
  const result = await regroupListings(db, {
    sourceId: ssGeSource.id,
    now: new Date().toISOString(),
  });
  logger.info(
    { ...result, durationMs: Date.now() - startedAtMs },
    'ss.ge look-alike groups updated',
  );
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'ss.ge grouping failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
