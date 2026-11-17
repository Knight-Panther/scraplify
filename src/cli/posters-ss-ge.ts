import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { ssGeSource } from '../policies/ss-ge.js';
import { backfillDescriptionContacts } from '../realestate/poster-backfill.js';
import { recordPosterStep } from '../realestate/poster-identity.js';

/**
 * The ss.ge poster directory's nightly step by hand (`npm run posters:ss-ge`,
 * Phase 17B): links, identities and tonight's sizes, as every nightly crawl
 * does after its totals. With `--backfill` (`npm run posters:backfill`) it
 * first reads the phones and emails in every live listing's stored
 * description, once after the release that brings migration 0060. Makes no
 * request to ss.ge or anywhere else; a second run writes nothing new.
 *
 * Logs counts only: no phone, email, name or account id is ever printed.
 */
async function main(): Promise<void> {
  if (process.argv.includes('--backfill')) {
    const startedAtMs = Date.now();
    const result = await backfillDescriptionContacts(db, { sourceId: ssGeSource.id });
    logger.info(
      { ...result, durationMs: Date.now() - startedAtMs },
      'ss.ge description contacts backfilled',
    );
  }
  const step = await recordPosterStep(db, {
    sourceId: ssGeSource.id,
    now: new Date().toISOString(),
    crawlRunId: null,
  });
  if (step.ok) {
    logger.info(step, 'ss.ge poster step recorded');
  } else {
    logger.error(step, 'ss.ge poster step failed');
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    // Only the error's name: a failed query's message carries its parameters.
    logger.error({ name: err instanceof Error ? err.name : 'Error' }, 'ss.ge poster step failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
