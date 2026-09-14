import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
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
 */
async function main(): Promise<void> {
  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    logger.error({ err }, 'taxonomy backfill: database preflight check failed');
    throw err;
  }

  const startedAtMs = Date.now();
  const seedResult = await seedTaxonomyTerms(db);
  const classifyResult = await classifyListings(db);

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
