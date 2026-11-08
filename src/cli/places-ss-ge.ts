import { db, pool } from '../db/client.js';
import { acquireCrawlProcessLock } from '../db/crawl-process-lock.js';
import { logger } from '../logger.js';
import { ssGeSource } from '../policies/ss-ge.js';
import { refreshListingLocations } from '../realestate/location.js';
import { backfillStoredListings, syncPlaces } from '../realestate/places.js';
import { refreshPlaceCatalogue } from '../realestate/places/catalogue.js';
import { loadCuratedPlaces } from '../realestate/places/curated.js';
import { loadOfficialMap } from '../realestate/places/official.js';

/**
 * Builds ss.ge's place tree from the stored listings by hand
 * (`npm run places:ss-ge`), as every nightly crawl does at its end: at Phase
 * 14A's deploy, so the first night already has each sub-district's district.
 * With `--backfill`, also writes what a sighting would to rows no results
 * page shows again soon: house numbers, and districts the source left out.
 * Then refreshes the place catalogue on both maps (Phase 14B) and judges each
 * active listing's location (Phase 14C), as the crawl's last steps do: at
 * 14C's deploy, so the site and Hermes have it before the first night. Makes
 * no request to ss.ge. Holds the crawl's lock, so it never runs beside a
 * crawl writing the same rows.
 */
async function main(): Promise<void> {
  const backfill = process.argv.slice(2).includes('--backfill');
  const lock = await acquireCrawlProcessLock(pool, ssGeSource.id);
  if (lock === null) {
    logger.error({ sourceId: ssGeSource.id }, 'ss.ge places: a crawl is running; try later');
    process.exitCode = 1;
    return;
  }
  try {
    const startedAtMs = Date.now();
    const added = await syncPlaces(db, { sourceId: ssGeSource.id, at: new Date().toISOString() });
    logger.info({ added, durationMs: Date.now() - startedAtMs }, 'ss.ge place tree updated');
    if (backfill) {
      const backfillStartedAtMs = Date.now();
      const result = await backfillStoredListings(db, { sourceId: ssGeSource.id });
      logger.info(
        { ...result, durationMs: Date.now() - backfillStartedAtMs },
        'ss.ge stored listings backfilled',
      );
    }
    const map = await loadOfficialMap();
    const catalogueStartedAtMs = Date.now();
    const catalogue = await refreshPlaceCatalogue(db, {
      sourceId: ssGeSource.id,
      at: new Date().toISOString(),
      map,
      curated: await loadCuratedPlaces(),
    });
    logger.info(
      { ...catalogue, durationMs: Date.now() - catalogueStartedAtMs },
      'ss.ge place catalogue refreshed',
    );
    const locationsStartedAtMs = Date.now();
    const locations = await refreshListingLocations(db, { sourceId: ssGeSource.id, map });
    logger.info(
      { ...locations, durationMs: Date.now() - locationsStartedAtMs },
      'ss.ge listing locations judged',
    );
  } finally {
    await lock.release();
  }
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'ss.ge places failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
