import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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
import { seedTaxonomyTerms, TAXONOMY_VERSION } from './seed-terms.js';

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

  /**
   * A pair classified by a DIFFERENT method (human_review here, though this
   * function has never produced one itself — the enum permits it) must
   * survive an older-version rerun untouched, not be silently overwritten
   * with deterministic backfill values while still claiming its original
   * method. A first version of the version-bump fix above re-derived every
   * old-version row unconditionally, which would have corrupted a human
   * reviewer's classification into one that LOOKS human-reviewed but
   * actually carries this function's own mechanical confidence/evidence —
   * the same audit-trail corruption `run-dedupe.ts`'s "never overwrite a
   * human verdict" rule exists to prevent elsewhere (commit gate finding,
   * 2026-09-15).
   */
  it('leaves a classification made by a different method untouched, even under an older taxonomy version', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    const { revisionId } = await addListing(sourceId, { specialty: specialtyTree(), industry: [] });
    await seedTaxonomyTerms(db, { sourceSlug });
    await trackTermIds(sourceId);
    await classifyListings(db, { sourceSlug });
    await db
      .update(listingClassifications)
      .set({
        method: 'human_review',
        confidence: 0.5,
        evidence: { reasons: ['a reviewer judged this by hand'] },
        taxonomyVersion: 'v0-fake-older',
      })
      .where(eq(listingClassifications.sourceListingRevisionId, revisionId));

    const result = await classifyListings(db, { sourceSlug });

    expect(result).toEqual({
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
    expect(rows.every((row) => row.method === 'human_review')).toBe(true);
    expect(rows.every((row) => row.confidence === 0.5)).toBe(true);
    expect(rows.every((row) => row.taxonomyVersion === 'v0-fake-older')).toBe(true);
  });

  /**
   * Stage 7 (taxonomy correction) gave `listing_classifications` a
   * `supersededAt` column: a correction retires the old row and inserts a
   * new one for the SAME pair. `alreadyClassified`'s lookup must resolve to
   * the MOST RECENT row per pair, not just the live one — a rejection
   * leaves no live row at all, and filtering to `isNull(supersededAt)`
   * (a first version of this fix) would make a rejected pair look entirely
   * unclassified, so the very next backfill run would silently re-insert
   * the deterministic category the human just rejected (commit gate
   * finding, 2026-09-15, on the actual committed code — not merely a design
   * review of the plan). Fixed by ordering the lookup explicitly by
   * `createdAt` instead: the Map then holds whichever row is genuinely most
   * recent, live or not, which is correct for a confirm (live), a reject
   * (retired, but still the pair's real current verdict), and an untouched
   * pair (its only row) alike.
   *
   * Simulates a correction directly, rather than via `correctClassification`
   * (this file's job is `classifyListings`'s own lookup, not the correction
   * write path) — retires the original under a deliberately STALE version
   * AND an explicitly LATER `createdAt` than the original's real one (the
   * original's `createdAt` is whatever `classifyListings`'s own first run
   * set it to — "now" at test time — so the correction must be later than
   * that, not a hardcoded past date, or the ordering fix would pick the
   * wrong row for the wrong reason). Proven deterministically, not by
   * racing Postgres's row order: if the retired row's `taxonomyVersion` is
   * still the stale value after a re-run, the lookup picked the correction,
   * not the original.
   */
  it('leaves a corrected pair alone: a retired original and its live human_review replacement', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    const { revisionId } = await addListing(sourceId, { specialty: specialtyTree(), industry: [] });
    await seedTaxonomyTerms(db, { sourceSlug });
    await trackTermIds(sourceId);
    await classifyListings(db, { sourceSlug });

    const [original] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.sourceListingRevisionId, revisionId))
      .limit(1);
    if (original === undefined) throw new Error('setup: expected a classification row');
    const originalEvidence = original.evidence;
    const correctedAt = new Date(Date.parse(original.createdAt) + 60_000).toISOString();

    await db
      .update(listingClassifications)
      .set({ supersededAt: correctedAt, taxonomyVersion: 'v0-fake-older' })
      .where(eq(listingClassifications.id, original.id));
    const correctionId = randomUUID();
    await db.insert(listingClassifications).values({
      id: correctionId,
      sourceListingRevisionId: original.sourceListingRevisionId,
      taxonomyTermId: original.taxonomyTermId,
      axis: original.axis,
      method: 'human_review',
      confidence: 1,
      evidence: { reasons: ['confirmed by a human reviewer'] },
      taxonomyVersion: original.taxonomyVersion,
      createdAt: correctedAt,
      supersededAt: null,
      previousClassificationId: original.id,
    });

    const result = await classifyListings(db, { sourceSlug });

    expect(result.classificationsUpdated).toBe(0);
    const [retiredAfter] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, original.id));
    // Untouched: still the stale version and original evidence — proof the
    // lookup resolved to the correction, not the retired original.
    expect(retiredAfter?.taxonomyVersion).toBe('v0-fake-older');
    expect(retiredAfter?.evidence).toEqual(originalEvidence);
    const [liveAfter] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, correctionId));
    expect(liveAfter?.method).toBe('human_review');
    expect(liveAfter?.confidence).toBe(1);
    expect(liveAfter?.supersededAt).toBeNull();
  });

  /**
   * The other half of the same fix: a REJECTION (no live row at all for its
   * pair) must also block re-derivation, not just a confirmation (live).
   * This is the exact scenario Codex's review of the actual committed code
   * found and the design-review pass missed: `isNull(supersededAt)` would
   * have made this pair look entirely unclassified, and the run below would
   * have silently re-created the deterministic row the human just rejected.
   */
  it('does not resurrect a rejected classification on the next backfill run', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    const { revisionId } = await addListing(sourceId, { specialty: specialtyTree(), industry: [] });
    await seedTaxonomyTerms(db, { sourceSlug });
    await trackTermIds(sourceId);
    await classifyListings(db, { sourceSlug });

    const [original] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.sourceListingRevisionId, revisionId))
      .limit(1);
    if (original === undefined) throw new Error('setup: expected a classification row');
    const rejectedAt = new Date(Date.parse(original.createdAt) + 60_000).toISOString();

    await db
      .update(listingClassifications)
      .set({ supersededAt: rejectedAt })
      .where(eq(listingClassifications.id, original.id));
    const rejectionId = randomUUID();
    await db.insert(listingClassifications).values({
      id: rejectionId,
      sourceListingRevisionId: original.sourceListingRevisionId,
      taxonomyTermId: original.taxonomyTermId,
      axis: original.axis,
      method: 'human_review',
      confidence: 0,
      evidence: { reasons: ['rejected by a human reviewer'] },
      taxonomyVersion: original.taxonomyVersion,
      createdAt: rejectedAt,
      // Born already retired — a rejection has no live representation.
      supersededAt: rejectedAt,
      previousClassificationId: original.id,
    });

    const result = await classifyListings(db, { sourceSlug });

    // Not created (it would be a fresh row for an "unclassified" pair) and
    // not updated (that only counts a deterministic_rule row re-derived) —
    // the fixture's OTHER pair (the child term, still live and untouched)
    // legitimately contributes neither either, since its version already
    // matches.
    expect(result.classificationsCreated).toBe(0);
    expect(result.classificationsUpdated).toBe(0);
    const rows = await db
      .select()
      .from(listingClassifications)
      .where(
        and(
          eq(listingClassifications.sourceListingRevisionId, revisionId),
          eq(listingClassifications.taxonomyTermId, original.taxonomyTermId),
        ),
      );
    // Scoped to just this ONE pair (the fixture has two): still exactly the
    // original (retired) and the rejection — no third, resurrected row.
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.supersededAt !== null)).toBe(true);
  });

  /**
   * An UNDO makes an OLDER row live again while a NEWER row stays retired —
   * "most recent by createdAt" alone (a second version of this fix) would
   * then pick the retired, human_review-method row as the pair's
   * "existing" entry and skip it forever, even on a genuine
   * TAXONOMY_VERSION bump — silently freezing a plain deterministic pair
   * that should still be eligible for reprocessing (commit gate finding,
   * 2026-09-15). A live row must always win over a retired one, regardless
   * of which is chronologically newer.
   */
  it('still re-derives a live deterministic row on a version bump, even though a retired correction is chronologically newer (simulating an undo)', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sourceSlug = `test-source-${sourceId}`;
    const { revisionId } = await addListing(sourceId, { specialty: specialtyTree(), industry: [] });
    await seedTaxonomyTerms(db, { sourceSlug });
    await trackTermIds(sourceId);
    await classifyListings(db, { sourceSlug });

    const [original] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.sourceListingRevisionId, revisionId))
      .limit(1);
    if (original === undefined) throw new Error('setup: expected a classification row');
    const laterButRetired = new Date(Date.parse(original.createdAt) + 60_000).toISOString();

    // Simulates confirm-then-undo directly: a human_review row exists,
    // chronologically AFTER the original, but it is RETIRED (as an undo
    // would leave it) — while the original itself is live again, and
    // deliberately aged to an older taxonomy version so a real bump would
    // need to re-derive it.
    await db
      .update(listingClassifications)
      .set({ taxonomyVersion: 'v0-fake-older' })
      .where(eq(listingClassifications.id, original.id));
    await db.insert(listingClassifications).values({
      id: randomUUID(),
      sourceListingRevisionId: original.sourceListingRevisionId,
      taxonomyTermId: original.taxonomyTermId,
      axis: original.axis,
      method: 'human_review',
      confidence: 1,
      evidence: { reasons: ['confirmed, then undone'] },
      taxonomyVersion: original.taxonomyVersion,
      createdAt: laterButRetired,
      supersededAt: laterButRetired,
      previousClassificationId: original.id,
    });

    const result = await classifyListings(db, { sourceSlug });

    // The live original — still deterministic_rule — must be picked up and
    // re-derived, not skipped because a chronologically newer but retired
    // human_review row exists for the same pair.
    expect(result.classificationsUpdated).toBeGreaterThanOrEqual(1);
    const [liveAfter] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, original.id));
    expect(liveAfter?.taxonomyVersion).toBe(TAXONOMY_VERSION);
    expect(liveAfter?.supersededAt).toBeNull();
  });
});
