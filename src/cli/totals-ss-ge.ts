import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { ssGeSource } from '../policies/ss-ge.js';
import { recordListingHistory } from '../realestate/history.js';
import { takeDailyTotals } from '../realestate/totals.js';

/**
 * Takes today's ss.ge totals by hand (`npm run totals:ss-ge`), as every
 * nightly crawl does at its end: for the first day after Phase 13D is
 * deployed, or after a change to the rules. Replaces any totals already
 * taken today. Makes no request to ss.ge.
 *
 * Records the listing history first at the same instant, as the crawl does
 * (Phase 17A), so the day's spells on show still hold exactly the listings
 * its totals count.
 */
async function main(): Promise<void> {
  const now = new Date().toISOString();
  const history = await recordListingHistory(db, {
    sourceId: ssGeSource.id,
    now,
    crawlRunId: null,
  });
  if (history.ok) logger.info(history, 'ss.ge listing history recorded');
  else logger.error(history, 'ss.ge listing history failed; the totals are taken all the same');
  const startedAtMs = Date.now();
  const result = await takeDailyTotals(db, {
    sourceId: ssGeSource.id,
    now,
    crawlRunId: null,
  });
  logger.info({ ...result, durationMs: Date.now() - startedAtMs }, 'ss.ge daily totals taken');
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'ss.ge daily totals failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
