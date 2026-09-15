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
  listAmbiguousClassifications,
} from './queries.js';

describe('listAmbiguousClassifications / countAmbiguousClassifications', () => {
  const sourceIds: string[] = [];
  const termIds: string[] = [];

  /** A listing with one classification at the given confidence, real Georgian title/term text. */
  async function addClassifiedListing(confidence: number): Promise<{ listingId: string }> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
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
    await db.insert(listingClassifications).values({
      id: randomUUID(),
      sourceListingRevisionId: revisionId,
      taxonomyTermId: termId,
      axis: 'profession',
      method: 'deterministic_rule',
      confidence,
      evidence: { reasons: ['test fixture'] },
      taxonomyVersion: 'v1',
      createdAt: '2026-09-01T00:00:00Z',
    });
    return { listingId: listing.id };
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
});
