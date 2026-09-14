import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  sourceListingRevisions,
  sourceListings,
  sourceTaxonomyMappings,
  taxonomyTerms,
} from '../db/schema/index.js';
import {
  cleanupTestSource,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../db/test-support.js';
import { TAXONOMY_VERSION, seedTaxonomyTerms } from './seed-terms.js';

/** A fresh, realistic-shaped (24-hex-char, mongo-ObjectId-like) hr.ge node id. */
function fakeSourceTermId(): string {
  return randomBytes(12).toString('hex');
}

/**
 * Real specialty/industry node SHAPES and LABELS, copied from a live hr.ge
 * fixture (`src/adapters/hr-ge/fixtures/detail-492368-email-application.html`)
 * rather than composed — including the quirk that industry's two nodes share
 * the exact same Georgian label ("საცალო ვაჭრობა") despite having different
 * hr.ge ids, which is real data, not a typo. The `sourceTermId` values are
 * generated fresh per call rather than the exact captured ids: `code` is
 * globally unique across the whole `taxonomy_terms` table (not scoped per
 * source), and vitest runs test FILES concurrently — reusing the literal
 * captured id here collided with `classify-listings.test.ts`'s own copy of
 * this same fixture the moment both ran at once, tripping the real unique
 * constraint (and the real-data guard, since the resulting leaked rows
 * changed its fingerprint) rather than a mocked failure (found running the
 * full suite, 2026-09-15). The ids themselves are internal database keys,
 * not user-facing content, so synthesizing them is consistent with how every
 * other row id in this test suite is already a `randomUUID()`.
 */
function specialtyTree(): Array<{
  sourceTermId: string;
  code: string | null;
  name: string;
  children: unknown;
}> {
  return [
    {
      sourceTermId: fakeSourceTermId(),
      code: '739',
      name: 'გაყიდვები',
      children: [
        {
          sourceTermId: fakeSourceTermId(),
          code: '1961',
          name: 'გაყიდვების კონსულტაცია და რჩევა',
          children: null,
        },
      ],
    },
  ];
}

function industryTree(): Array<{
  sourceTermId: string;
  code: string | null;
  name: string;
  children: unknown;
}> {
  return [
    {
      sourceTermId: fakeSourceTermId(),
      code: null,
      name: 'საცალო ვაჭრობა',
      children: [
        {
          sourceTermId: fakeSourceTermId(),
          code: null,
          name: 'საცალო ვაჭრობა',
          children: null,
        },
      ],
    },
  ];
}

describe('seedTaxonomyTerms', () => {
  const sourceIds: string[] = [];
  const termIds: string[] = [];

  async function addListing(
    sourceId: string,
    structuredAttributes: Record<string, unknown>,
  ): Promise<void> {
    const listing = await createTestSourceListing(sourceId, { status: 'active' });
    const resourceId = await createTestResource(sourceId);
    const revisionId = randomUUID();
    await db.insert(sourceListingRevisions).values({
      id: revisionId,
      sourceListingId: listing.id,
      parserVersion: 'v3',
      extractionMethod: 'http',
      rawResourceHash: 'a'.repeat(64),
      meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      titleRaw: 'გაყიდვების კონსულტანტი',
      titleNormalized: 'გაყიდვების კონსულტანტი',
      organizationRaw: 'ბებე +',
      description: 'description',
      locations: [],
      publishedDate: { raw: '', parsed: '2026-09-01T00:00:00Z' },
      deadlineDate: { raw: '', parsed: '2026-10-01T00:00:00Z' },
      applicationMethod: null,
      sourceCategories: [],
      structuredAttributes,
      createdAt: '2026-09-01T00:00:00Z',
      provenanceResourceId: resourceId,
      provenanceFetchedAt: '2026-09-01T00:00:00Z',
      provenanceNotes: null,
    });
    await db
      .update(sourceListings)
      .set({ currentRevisionId: revisionId })
      .where(eq(sourceListings.id, listing.id));
  }

  afterEach(async () => {
    // termIds is passed as EXPLICIT ownership proof, not inferred by
    // cleanupTestSource itself — see that function's own doc comment for
    // why (commit gate, 2026-09-15). trackTermIds must already have run
    // (every test below calls it right after seedTaxonomyTerms) for this to
    // have anything to pass.
    const ownedTermIds = termIds.splice(0);
    for (const sourceId of sourceIds.splice(0)) {
      await cleanupTestSource(sourceId, { taxonomyTermIds: ownedTermIds });
    }
  });

  /**
   * Tracks exactly the term ids `seedTaxonomyTerms` created for ONE source,
   * via `sourceTaxonomyMappings.sourceId` — never the whole `taxonomyTerms`
   * table. A first version of this helper queried every row in the table
   * unscoped, which would delete real, already-seeded terms the moment the
   * real backfill (Phase 3C-2 Stage 4/5) had ever run against this same
   * database — caught before it shipped, not after.
   */
  async function trackTermIds(sourceId: string): Promise<void> {
    const rows = await db
      .select({ taxonomyTermId: sourceTaxonomyMappings.taxonomyTermId })
      .from(sourceTaxonomyMappings)
      .where(eq(sourceTaxonomyMappings.sourceId, sourceId));
    termIds.push(...rows.map((row) => row.taxonomyTermId));
  }

  it('seeds a term and its child, preserving the real parent/child relationship', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    await addListing(sourceId, { specialty: specialtyTree(), industry: [] });

    const result = await seedTaxonomyTerms(db, { sourceSlug });
    await trackTermIds(sourceId);

    expect(result).toEqual({
      listingsScanned: 1,
      termsCreated: 2,
      mappingsCreated: 2,
      termsUpdated: 0,
    });

    const rows = await db
      .select()
      .from(taxonomyTerms)
      .where(inArray(taxonomyTerms.id, termIds))
      .orderBy(taxonomyTerms.label);
    const parent = rows.find((row) => row.label === 'გაყიდვები');
    const child = rows.find((row) => row.label === 'გაყიდვების კონსულტაცია და რჩევა');
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(parent?.parentId).toBeNull();
    expect(parent?.axis).toBe('profession');
    expect(child?.parentId).toBe(parent?.id);
  });

  it('classifies specialty as profession and industry as industry, even when two industry nodes share one label', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    await addListing(sourceId, { specialty: [], industry: industryTree() });

    const result = await seedTaxonomyTerms(db, { sourceSlug });
    await trackTermIds(sourceId);

    // Two DISTINCT terms, despite sharing a label — proven by real hr.ge ids,
    // not by name, since name-based dedup is exactly what real stable ids
    // were meant to replace (docs/STATUS.md, Phase 3C-2).
    expect(result).toEqual({
      listingsScanned: 1,
      termsCreated: 2,
      mappingsCreated: 2,
      termsUpdated: 0,
    });
    const rows = await db.select().from(taxonomyTerms).where(inArray(taxonomyTerms.id, termIds));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.axis === 'industry')).toBe(true);
    expect(rows.every((row) => row.label === 'საცალო ვაჭრობა')).toBe(true);
    expect(new Set(rows.map((row) => row.code)).size).toBe(2);
  });

  it('is idempotent: re-running against the same corpus creates no duplicate terms', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    await addListing(sourceId, { specialty: specialtyTree(), industry: [] });

    const first = await seedTaxonomyTerms(db, { sourceSlug });
    await trackTermIds(sourceId);
    const second = await seedTaxonomyTerms(db, { sourceSlug });

    expect(first.termsCreated).toBe(2);
    expect(second).toEqual({
      listingsScanned: 1,
      termsCreated: 0,
      mappingsCreated: 0,
      termsUpdated: 0,
    });
    const rows = await db.select().from(taxonomyTerms).where(inArray(taxonomyTerms.id, termIds));
    expect(rows).toHaveLength(2);
  });

  it('reports zero when the source has no listings at all', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;

    const result = await seedTaxonomyTerms(db, { sourceSlug });
    expect(result).toEqual({
      listingsScanned: 0,
      termsCreated: 0,
      mappingsCreated: 0,
      termsUpdated: 0,
    });
  });

  /**
   * §15.2's "versioned deterministic mappings" means a TAXONOMY_VERSION bump
   * actually reprocesses already-mapped nodes, not just applies to new ones
   * going forward — a first version of this function treated "already
   * mapped" as permanently settled regardless of version, so a version bump
   * silently left every existing term stale (commit gate, 2026-09-15).
   * Simulated here by directly ageing the stored rows to a fake older
   * version, rather than changing the real TAXONOMY_VERSION constant.
   */
  it('re-derives a term whose stored mapping is under an older taxonomy version', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    await addListing(sourceId, { specialty: specialtyTree(), industry: [] });

    await seedTaxonomyTerms(db, { sourceSlug });
    await trackTermIds(sourceId);
    await db
      .update(sourceTaxonomyMappings)
      .set({ taxonomyVersion: 'v0-fake-older' })
      .where(eq(sourceTaxonomyMappings.sourceId, sourceId));

    const result = await seedTaxonomyTerms(db, { sourceSlug });

    expect(result).toEqual({
      listingsScanned: 1,
      termsCreated: 0,
      mappingsCreated: 0,
      termsUpdated: 2,
    });
    const mappings = await db
      .select({ taxonomyVersion: sourceTaxonomyMappings.taxonomyVersion })
      .from(sourceTaxonomyMappings)
      .where(eq(sourceTaxonomyMappings.sourceId, sourceId));
    expect(mappings.every((row) => row.taxonomyVersion === TAXONOMY_VERSION)).toBe(true);
    // Re-derivation must not create a second term for the same raw id.
    const rows = await db.select().from(taxonomyTerms).where(inArray(taxonomyTerms.id, termIds));
    expect(rows).toHaveLength(2);
  });
});
