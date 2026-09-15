import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  listingClassifications,
  sourceListingRevisions,
  sourceListings,
  taxonomyTerms,
} from '../db/schema/index.js';
import {
  cleanupTestSource,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../db/test-support.js';
import {
  AMBIGUOUS_CLASSIFICATION_CONFIDENCE_THRESHOLD,
  countAmbiguousClassifications,
  countClassifications,
  countUncategorizedListings,
  listAmbiguousClassifications,
  searchClassifications,
} from './queries.js';

describe('listAmbiguousClassifications / countAmbiguousClassifications', () => {
  const sourceIds: string[] = [];
  const termIds: string[] = [];

  /** A listing with one classification at the given confidence, real Georgian title/term text. */
  async function addClassifiedListing(
    confidence: number,
  ): Promise<{ listingId: string; classificationId: string; sourceSlug: string }> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
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
      structuredAttributes: {},
      createdAt: '2026-09-01T00:00:00Z',
      provenanceResourceId: resourceId,
      provenanceFetchedAt: '2026-09-01T00:00:00Z',
      provenanceNotes: null,
    });
    await db
      .update(sourceListings)
      .set({ currentRevisionId: revisionId })
      .where(eq(sourceListings.id, listing.id));

    const termId = randomUUID();
    termIds.push(termId);
    await db.insert(taxonomyTerms).values({
      id: termId,
      axis: 'profession',
      code: `profession-${randomUUID()}`,
      label: 'გაყიდვები',
      taxonomyVersion: 'v1',
      parentId: null,
    });
    const classificationId = randomUUID();
    await db.insert(listingClassifications).values({
      id: classificationId,
      sourceListingRevisionId: revisionId,
      taxonomyTermId: termId,
      axis: 'profession',
      method: 'deterministic_rule',
      confidence,
      evidence: { reasons: ['test fixture'] },
      taxonomyVersion: 'v1',
      createdAt: '2026-09-01T00:00:00Z',
    });
    return { listingId: listing.id, classificationId, sourceSlug };
  }

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) {
      await cleanupTestSource(sourceId, { taxonomyTermIds: termIds.splice(0) });
    }
  });

  it('returns a classification below the ambiguity threshold, with real listing/term context', async () => {
    const { listingId } = await addClassifiedListing(0.5);

    const rows = await listAmbiguousClassifications(db);
    const row = rows.find((r) => r.sourceListingId === listingId);

    expect(row).toBeDefined();
    expect(row?.listingTitle).toBe('გაყიდვების კონსულტანტი');
    expect(row?.termLabel).toBe('გაყიდვები');
    expect(row?.sourceSlug.startsWith('test-source-')).toBe(true);
    expect(row?.confidence).toBe(0.5);
    // Evidence must be exposed, not discarded — a first version of this
    // query dropped it, leaving the review page unable to explain WHY a
    // low-confidence assignment was made (commit gate, 2026-09-15).
    expect(row?.evidence).toEqual({ reasons: ['test fixture'] });
    // No membership was ever created for this listing, so there is no live
    // opportunity to link to — null, not a fabricated or wrong id.
    expect(row?.opportunityId).toBeNull();
    // The fallback link for that case — a detached/never-clustered row must
    // still be verifiable against its source (commit gate, 2026-09-15).
    expect(row?.canonicalSourceUrl).toBe(`https://example.invalid/listing/${listingId}`);

    const count = await countAmbiguousClassifications(db);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('excludes a classification at or above the ambiguity threshold', async () => {
    const { listingId } = await addClassifiedListing(AMBIGUOUS_CLASSIFICATION_CONFIDENCE_THRESHOLD);

    const rows = await listAmbiguousClassifications(db);

    expect(rows.some((r) => r.sourceListingId === listingId)).toBe(false);
  });

  it('excludes hr.ge structured-field classifications at confidence 1 — the real, expected shape of this queue today', async () => {
    const { listingId } = await addClassifiedListing(1);

    const rows = await listAmbiguousClassifications(db);

    expect(rows.some((r) => r.sourceListingId === listingId)).toBe(false);
  });

  /**
   * `listAmbiguousClassifications` alone can't correct a classification the
   * real corpus actually has (everything is confidence 1 today) — Stage 7's
   * whole point is a browse/search query with no confidence filter, so a
   * reviewer can find and correct ANY classification, not only ones that
   * happen to score low (independent design review, 2026-09-15).
   */
  it('searchClassifications finds a confidence-1 row the ambiguous queue excludes', async () => {
    const { listingId, sourceSlug } = await addClassifiedListing(1);

    // Scoped to this disposable source — an unscoped text search over the
    // real, live corpus (16,000+ classifications) could push this fixture
    // past the default page size on a common term/title, same as any other
    // paginated search here.
    const rows = await searchClassifications(db, { sourceSlug });

    expect(rows.some((r) => r.sourceListingId === listingId)).toBe(true);
  });

  it('searchClassifications text filter matches by term label too, and excludes a non-matching search', async () => {
    const { listingId, sourceSlug } = await addClassifiedListing(0.9);

    const byTerm = await searchClassifications(db, { sourceSlug, text: 'გაყიდვები' });
    expect(byTerm.some((r) => r.sourceListingId === listingId)).toBe(true);

    const noMatch = await searchClassifications(db, {
      sourceSlug,
      text: 'ნინოწმინდა-არასდროს-ემთხვევა',
    });
    expect(noMatch.some((r) => r.sourceListingId === listingId)).toBe(false);
  });

  it('countClassifications agrees with searchClassifications for the same filters', async () => {
    const { sourceSlug } = await addClassifiedListing(0.9);

    const rows = await searchClassifications(db, { sourceSlug });
    const count = await countClassifications(db, { sourceSlug });

    expect(count).toBe(rows.length);
  });

  it('searchClassifications excludes a superseded (corrected-away) classification', async () => {
    const { listingId, classificationId } = await addClassifiedListing(0.9);
    await db
      .update(listingClassifications)
      .set({ supersededAt: '2026-09-15T00:00:00Z' })
      .where(eq(listingClassifications.id, classificationId));

    const rows = await searchClassifications(db, { text: 'გაყიდვების კონსულტანტი' });
    expect(rows.some((r) => r.sourceListingId === listingId)).toBe(false);
  });
});

describe('countUncategorizedListings', () => {
  const sourceIds: string[] = [];
  const termIds: string[] = [];

  afterEach(async () => {
    const ownedTermIds = termIds.splice(0);
    for (const sourceId of sourceIds.splice(0)) {
      await cleanupTestSource(sourceId, { taxonomyTermIds: ownedTermIds });
    }
  });

  async function addListing(sourceId: string): Promise<{ revisionId: string; listingId: string }> {
    const listing = await createTestSourceListing(sourceId, { status: 'active' });
    const resourceId = await createTestResource(sourceId);
    const revisionId = randomUUID();
    await db.insert(sourceListingRevisions).values({
      id: revisionId,
      sourceListingId: listing.id,
      parserVersion: 'v1',
      extractionMethod: 'http',
      rawResourceHash: 'a'.repeat(64),
      meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      titleRaw: 'უცნობი ვაკანსია',
      titleNormalized: 'უცნობი ვაკანსია',
      organizationRaw: 'უცნობი',
      description: 'description',
      locations: [],
      publishedDate: { raw: '', parsed: '2026-09-01T00:00:00Z' },
      deadlineDate: { raw: '', parsed: '2026-10-01T00:00:00Z' },
      applicationMethod: null,
      sourceCategories: [],
      structuredAttributes: {},
      createdAt: '2026-09-01T00:00:00Z',
      provenanceResourceId: resourceId,
      provenanceFetchedAt: '2026-09-01T00:00:00Z',
      provenanceNotes: null,
    });
    await db
      .update(sourceListings)
      .set({ currentRevisionId: revisionId })
      .where(eq(sourceListings.id, listing.id));
    return { revisionId, listingId: listing.id };
  }

  it('counts a listing with no classification row at all', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    await addListing(sourceId);

    const count = await countUncategorizedListings(db, { sourceSlug });

    expect(count).toBe(1);
  });

  it('excludes a listing with a live classification', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    const { revisionId } = await addListing(sourceId);
    const termId = randomUUID();
    termIds.push(termId);
    await db.insert(taxonomyTerms).values({
      id: termId,
      axis: 'profession',
      code: `profession-${randomUUID()}`,
      label: 'უცნობი',
      taxonomyVersion: 'v1',
      parentId: null,
    });
    await db.insert(listingClassifications).values({
      id: randomUUID(),
      sourceListingRevisionId: revisionId,
      taxonomyTermId: termId,
      axis: 'profession',
      method: 'deterministic_rule',
      confidence: 1,
      evidence: { reasons: ['test fixture'] },
      taxonomyVersion: 'v1',
      createdAt: '2026-09-01T00:00:00Z',
    });

    const count = await countUncategorizedListings(db, { sourceSlug });

    expect(count).toBe(0);
  });

  it('counts a listing again once its only classification was rejected (superseded, no live replacement)', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    const { revisionId } = await addListing(sourceId);
    const termId = randomUUID();
    termIds.push(termId);
    await db.insert(taxonomyTerms).values({
      id: termId,
      axis: 'profession',
      code: `profession-${randomUUID()}`,
      label: 'უცნობი',
      taxonomyVersion: 'v1',
      parentId: null,
    });
    await db.insert(listingClassifications).values({
      id: randomUUID(),
      sourceListingRevisionId: revisionId,
      taxonomyTermId: termId,
      axis: 'profession',
      method: 'human_review',
      confidence: 0,
      evidence: { reasons: ['rejected'] },
      taxonomyVersion: 'v1',
      createdAt: '2026-09-01T00:00:00Z',
      supersededAt: '2026-09-01T00:00:00Z',
    });

    const count = await countUncategorizedListings(db, { sourceSlug });

    expect(count).toBe(1);
  });
});
