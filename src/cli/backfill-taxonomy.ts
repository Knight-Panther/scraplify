import { sql } from 'drizzle-orm';
import { ADVISORY_LOCKS, withAdvisoryLock } from '../db/advisory-lock.js';
import { db, pool } from '../db/client.js';
import { logger } from '../logger.js';
import { classifyListings } from '../taxonomy/classify-listings.js';
import { seedTaxonomyTerms } from '../taxonomy/seed-terms.js';

/**
 * One-shot taxonomy seed + backfill (§15.2), Phase 3C-2.
 *
 * Run after a full-coverage hr.ge crawl with the corrected adapter (Stage 2)
 * has landed the tree-shaped `structuredAttributes.specialty`/`.industry` —
 * a listing whose current revision still holds the old flat-string shape
 * contributes nothing here (no `sourceTermId` to seed from), not an error.
 *
 * Seeding runs before classifying: a node must have a `taxonomyTerms` row
 * and a `sourceTaxonomyMappings` row before any listing can be classified
 * against it.
 *
 * Also chained after every scheduled crawl (scripts/run-crawl.ps1, Phase 7A
 * follow-up), since nothing else ever classified newly crawled listings. Held
 * under an advisory lock for that reason: two schedules' backfills overlapping
 * would both try to seed the same new term and collide on
 * `taxonomy_terms_code_unique`.
 */
async function main(): Promise<void> {
  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    logger.error({ err }, 'taxonomy backfill: database preflight check failed');
    throw err;
  }

  const startedAtMs = Date.now();
  const { seedResult, classifyResult } = await withAdvisoryLock(
    pool,
    ADVISORY_LOCKS.taxonomyBackfill,
    async () => ({
      seedResult: await seedTaxonomyTerms(db),
      classifyResult: await classifyListings(db),
    }),
  );

  logger.info(
    {
      durationMs: Date.now() - startedAtMs,
      seed: seedResult,
      classify: classifyResult,
    },
    'taxonomy backfill finished',
  );
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'taxonomy backfill: run failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
