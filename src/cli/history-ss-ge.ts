import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { ssGeSource } from '../policies/ss-ge.js';
import { recordListingHistory } from '../realestate/history.js';

/**
 * Records the ss.ge listing history by hand (`npm run history:ss-ge`), as
 * every nightly crawl does after its groups (Phase 17A): for the first night
 * after the deploy, or to heal a night the step failed. Makes no request to
 * ss.ge. A run at any instant is harmless: spells are judged at each run's
 * instant, and the night's totals take their own with the step beside them.
 */
async function main(): Promise<void> {
  const result = await recordListingHistory(db, {
    sourceId: ssGeSource.id,
    now: new Date().toISOString(),
    crawlRunId: null,
  });
  if (result.ok) {
    logger.info(result, 'ss.ge listing history recorded');
  } else {
    logger.error(result, 'ss.ge listing history failed');
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'ss.ge listing history failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
