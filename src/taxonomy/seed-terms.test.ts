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
interface FakeTaxonomyNode {
  sourceTermId: string;
  code: string | null;
  name: string;
  children: FakeTaxonomyNode[] | null;
}

function specialtyTree(): FakeTaxonomyNode[] {
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

function industryTree(): FakeTaxonomyNode[] {
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
  let addListingCallCount = 0;

  async function addListing(
    sourceId: string,
    structuredAttributes: Record<string, unknown>,
    // Distinct per call by default (not a single hardcoded constant) —
    // seedTaxonomyTerms picks its authoritative observation of a raw node
    // by comparing provenanceFetchedAt across listings, so two listings
    // sharing one fixed timestamp can never prove which one is "newer",
    // exactly the ambiguity a relabeling test needs to avoid (commit gate
    // finding, 2026-09-15).
    provenanceFetchedAt: string = new Date(
      Date.parse('2026-09-01T00:00:00Z') + addListingCallCount++ * 1000,
    ).toISOString(),
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
      provenanceFetchedAt,
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

  /**
   * A DIFFERENT gap from the version-bump one above, found in the same
   * commit gate round: the fast path originally skipped re-derivation on
   * version match ALONE, so hr.ge renaming a category (or moving it under a
   * different parent) while keeping the same node id — an ordinary source
   * edit, no code change or version bump involved — would never be picked
   * up on a later rerun, leaving the canonical label permanently stale
   * despite §15.2 step 1's "preserve source labels exactly" (commit gate,
   * 2026-09-15). This never touches TAXONOMY_VERSION; only the source data
   * changes between the two seed calls.
   */
  it("re-derives a term's label when hr.ge renamed it, even at the same taxonomy version", async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    const originalTree = specialtyTree();
    const [originalParent] = originalTree;
    if (originalParent === undefined || originalParent.children === null) {
      throw new Error('specialtyTree() fixture shape changed — expected one parent with one child');
    }
    const [originalChild] = originalParent.children;
    if (originalChild === undefined) {
      throw new Error('specialtyTree() fixture shape changed — expected one parent with one child');
    }
    await addListing(sourceId, { specialty: originalTree, industry: [] });

    await seedTaxonomyTerms(db, { sourceSlug });
    await trackTermIds(sourceId);

    // Same sourceTermId, same code, but hr.ge has since renamed the label —
    // the shape a real re-crawl would produce for an edited category.
    const renamedTree: FakeTaxonomyNode[] = [
      {
        ...originalParent,
        name: 'ახალი გაყიდვების სახელი',
        children: [{ ...originalChild, name: 'ახალი ქვეკატეგორია' }],
      },
    ];
    await addListing(sourceId, { specialty: renamedTree, industry: [] });

    const result = await seedTaxonomyTerms(db, { sourceSlug });

    expect(result).toEqual({
      listingsScanned: 2,
      termsCreated: 0,
      mappingsCreated: 0,
      termsUpdated: 2,
    });
    const rows = await db
      .select({ label: taxonomyTerms.label, taxonomyVersion: taxonomyTerms.taxonomyVersion })
      .from(taxonomyTerms)
      .where(inArray(taxonomyTerms.id, termIds));
    const labels = rows.map((row) => row.label).sort();
    expect(labels).toEqual(['ახალი გაყიდვების სახელი', 'ახალი ქვეკატეგორია'].sort());
    // Confirms this genuinely reran under the SAME version, not a version
    // bump — the whole point of this test is the same-version case.
    expect(rows.every((row) => row.taxonomyVersion === TAXONOMY_VERSION)).toBe(true);
  });

  /**
   * The scenario the commit gate actually named: two listings disagree
   * about the SAME node's label WITHIN one `seedTaxonomyTerms` call (a
   * revision crawled before hr.ge's rename sitting alongside one crawled
   * after, both still "current" for their own listing at the same moment).
   * A version that applied whichever observation it encountered last in
   * scan order would make the final label depend on the database's
   * unordered row order — this proves the NEWER `provenanceFetchedAt`
   * always wins, deterministically, regardless of which row the scan
   * visits first.
   */
  it('picks the newer observation when two listings disagree about the same node in one run', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    // A single node, no child — this test is scoped to the conflicting-
    // observation resolution itself, not the parent/child mechanics
    // already covered by the tests above.
    const rawId = fakeSourceTermId();
    const originalTree: FakeTaxonomyNode[] = [
      { sourceTermId: rawId, code: '1', name: 'ძველი სახელი', children: null },
    ];
    const renamedTree: FakeTaxonomyNode[] = [
      { sourceTermId: rawId, code: '1', name: 'ახალი სახელი', children: null },
    ];

    // The OLDER observation is added SECOND (later database row), so a
    // scan-order-dependent implementation would be tempted to let it win —
    // it must not. provenanceFetchedAt, not insertion order, decides.
    await addListing(sourceId, { specialty: renamedTree, industry: [] }, '2026-09-05T00:00:00Z');
    await addListing(sourceId, { specialty: originalTree, industry: [] }, '2026-09-01T00:00:00Z');

    const result = await seedTaxonomyTerms(db, { sourceSlug });
    await trackTermIds(sourceId);

    expect(result.termsCreated).toBe(1);
    const [term] = await db
      .select({ label: taxonomyTerms.label })
      .from(taxonomyTerms)
      .where(inArray(taxonomyTerms.id, termIds));
    expect(term?.label).toBe('ახალი სახელი');
  });
});
