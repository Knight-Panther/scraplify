import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  listingClassifications,
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
import { classifyListings } from './classify-listings.js';
import { seedTaxonomyTerms } from './seed-terms.js';

/** A fresh, realistic-shaped (24-hex-char, mongo-ObjectId-like) hr.ge node id. */
function fakeSourceTermId(): string {
  return randomBytes(12).toString('hex');
}

/**
 * Same real fixture SHAPE and LABELS as `seed-terms.test.ts` — see that
 * file's comment. `sourceTermId` is generated fresh per call rather than
 * hardcoded: `taxonomy_terms.code` is globally unique, and vitest runs test
 * files concurrently, so a literal id shared with `seed-terms.test.ts`
 * collided with it the moment both files ran at once (found running the
 * full suite, 2026-09-15) — a real unique-constraint violation and a
 * real-data-guard trip, not a mocked failure.
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

describe('classifyListings', () => {
  const sourceIds: string[] = [];
  const termIds: string[] = [];

  async function addListing(
    sourceId: string,
    structuredAttributes: Record<string, unknown>,
  ): Promise<{ revisionId: string }> {
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
    return { revisionId };
  }

  afterEach(async () => {
    // termIds is passed as EXPLICIT ownership proof — see
    // cleanupTestSource's own doc comment (src/db/test-support.ts) for why
    // inferring it from "nothing currently references it" was rejected.
    const ownedTermIds = termIds.splice(0);
    for (const sourceId of sourceIds.splice(0)) {
      await cleanupTestSource(sourceId, { taxonomyTermIds: ownedTermIds });
    }
  });

  async function trackTermIds(sourceId: string): Promise<void> {
    const rows = await db
      .select({ taxonomyTermId: sourceTaxonomyMappings.taxonomyTermId })
      .from(sourceTaxonomyMappings)
      .where(eq(sourceTaxonomyMappings.sourceId, sourceId));
    termIds.push(...rows.map((row) => row.taxonomyTermId));
  }

  it('classifies a listing under both the parent and the child it selected', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    const { revisionId } = await addListing(sourceId, { specialty: specialtyTree(), industry: [] });

    await seedTaxonomyTerms(db, { sourceSlug });
    await trackTermIds(sourceId);
    const result = await classifyListings(db, { sourceSlug });

    expect(result).toEqual({
      listingsScanned: 1,
      classificationsCreated: 2,
      unmappedNodes: 0,
      classificationsUpdated: 0,
    });

    const rows = await db
      .select({
        axis: listingClassifications.axis,
        confidence: listingClassifications.confidence,
        method: listingClassifications.method,
        label: taxonomyTerms.label,
      })
      .from(listingClassifications)
      .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, listingClassifications.taxonomyTermId))
      .where(eq(listingClassifications.sourceListingRevisionId, revisionId));

    const labels = rows.map((row) => row.label).sort();
    expect(labels).toEqual(['გაყიდვები', 'გაყიდვების კონსულტაცია და რჩევა'].sort());
    expect(rows.every((row) => row.axis === 'profession')).toBe(true);
    expect(rows.every((row) => row.confidence === 1)).toBe(true);
    expect(rows.every((row) => row.method === 'deterministic_rule')).toBe(true);
  });

  it('counts an unmapped node rather than guessing, when a listing carries a node seedTaxonomyTerms never saw', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    // Deliberately classify WITHOUT seeding first — every node in this
    // fixture is genuinely unmapped from classifyListings's point of view.
    await addListing(sourceId, { specialty: specialtyTree(), industry: [] });

    const result = await classifyListings(db, { sourceSlug });

    expect(result).toEqual({
      listingsScanned: 1,
      classificationsCreated: 0,
      unmappedNodes: 2,
      classificationsUpdated: 0,
    });
    const rows = await db
      .select()
      .from(listingClassifications)
      .innerJoin(
        sourceListingRevisions,
        eq(sourceListingRevisions.id, listingClassifications.sourceListingRevisionId),
      )
      .innerJoin(sourceListings, eq(sourceListings.id, sourceListingRevisions.sourceListingId))
      .where(eq(sourceListings.sourceId, sourceId));
    expect(rows).toHaveLength(0);
  });

  it('is idempotent: re-running against the same listing creates no duplicate classifications', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    const { revisionId } = await addListing(sourceId, { specialty: specialtyTree(), industry: [] });
    await seedTaxonomyTerms(db, { sourceSlug });
    await trackTermIds(sourceId);

    const first = await classifyListings(db, { sourceSlug });
    const second = await classifyListings(db, { sourceSlug });

    expect(first.classificationsCreated).toBe(2);
    expect(second).toEqual({
      listingsScanned: 1,
      classificationsCreated: 0,
      unmappedNodes: 0,
      classificationsUpdated: 0,
    });
    const rows = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.sourceListingRevisionId, revisionId));
    expect(rows).toHaveLength(2);
  });

  it('reports zero when the source has no listings at all', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;

    const result = await classifyListings(db, { sourceSlug });
    expect(result).toEqual({
      listingsScanned: 0,
      classificationsCreated: 0,
      unmappedNodes: 0,
      classificationsUpdated: 0,
    });
  });

  /**
   * Same reasoning as seed-terms.test.ts's own version-bump test: a first
   * version of this function treated an already-classified revision/term
   * pair as permanently complete regardless of TAXONOMY_VERSION, silently
   * leaving stale classifications behind a version bump (commit gate,
   * 2026-09-15). Simulated by ageing the stored row directly rather than
   * changing the real constant.
   */
  it('re-derives a classification whose stored row is under an older taxonomy version', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    const { revisionId } = await addListing(sourceId, { specialty: specialtyTree(), industry: [] });
    await seedTaxonomyTerms(db, { sourceSlug });
    await trackTermIds(sourceId);
    await classifyListings(db, { sourceSlug });
    await db
      .update(listingClassifications)
      .set({ taxonomyVersion: 'v0-fake-older' })
      .where(eq(listingClassifications.sourceListingRevisionId, revisionId));

    const result = await classifyListings(db, { sourceSlug });

    expect(result).toEqual({
      listingsScanned: 1,
      classificationsCreated: 0,
      unmappedNodes: 0,
      classificationsUpdated: 2,
    });
    const rows = await db
      .select({ taxonomyVersion: listingClassifications.taxonomyVersion })
      .from(listingClassifications)
      .where(eq(listingClassifications.sourceListingRevisionId, revisionId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.taxonomyVersion !== 'v0-fake-older')).toBe(true);
  });
});
