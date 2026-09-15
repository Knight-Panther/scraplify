import { randomBytes, randomUUID } from 'node:crypto';
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
  canUndoCorrection,
  correctClassification,
  undoClassificationCorrection,
} from './correct-classification.js';
import { listAmbiguousClassifications } from './queries.js';

describe('correctClassification / undoClassificationCorrection', () => {
  const sourceIds: string[] = [];
  const termIds: string[] = [];

  /** A live, low-confidence classification a reviewer can act on. */
  async function addClassifiedListing(confidence = 0.5): Promise<{
    classificationId: string;
    revisionId: string;
    termId: string;
  }> {
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
      code: `profession-${randomBytes(8).toString('hex')}`,
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
    return { classificationId, revisionId, termId };
  }

  afterEach(async () => {
    const ownedTermIds = termIds.splice(0);
    for (const sourceId of sourceIds.splice(0)) {
      await cleanupTestSource(sourceId, { taxonomyTermIds: ownedTermIds });
    }
  });

  it('confirm retires the original, inserts a live human_review row, and clears the ambiguous queue', async () => {
    const { classificationId, revisionId, termId } = await addClassifiedListing(0.5);

    const { newClassificationId } = await correctClassification(db, {
      classificationId,
      verdict: 'confirmed',
      evidence: { reasons: ['confirmed by a human reviewer'] },
      at: '2026-09-15T12:00:00Z',
    });

    const [original] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, classificationId));
    expect(original?.supersededAt).toBe('2026-09-15 12:00:00+00');

    const [replacement] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, newClassificationId));
    expect(replacement?.method).toBe('human_review');
    expect(replacement?.confidence).toBe(1);
    expect(replacement?.supersededAt).toBeNull();
    expect(replacement?.previousClassificationId).toBe(classificationId);
    expect(replacement?.sourceListingRevisionId).toBe(revisionId);
    expect(replacement?.taxonomyTermId).toBe(termId);

    const rows = await listAmbiguousClassifications(db);
    expect(rows.some((r) => r.classificationId === newClassificationId)).toBe(false);
    expect(rows.some((r) => r.classificationId === classificationId)).toBe(false);
  });

  it('reject leaves no live classification for the pair, but keeps a permanent record of the verdict', async () => {
    const { classificationId } = await addClassifiedListing(0.5);

    const { newClassificationId } = await correctClassification(db, {
      classificationId,
      verdict: 'rejected',
      evidence: { reasons: ['not applicable to this listing'] },
      at: '2026-09-15T12:00:00Z',
    });

    const [replacement] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, newClassificationId));
    if (replacement === undefined) throw new Error('setup: expected a replacement row');
    // Born already retired — a real row, not a live classification.
    expect(replacement.method).toBe('human_review');
    expect(replacement.confidence).toBe(0);
    expect(replacement.supersededAt).not.toBeNull();
    expect(replacement.previousClassificationId).toBe(classificationId);

    const live = await db
      .select()
      .from(listingClassifications)
      .where(
        eq(listingClassifications.sourceListingRevisionId, replacement.sourceListingRevisionId),
      );
    expect(live.every((row) => row.supersededAt !== null)).toBe(true);

    const rows = await listAmbiguousClassifications(db);
    expect(rows.some((r) => r.classificationId === newClassificationId)).toBe(false);
  });

  it('refuses a second correction on an already-superseded row', async () => {
    const { classificationId } = await addClassifiedListing(0.5);
    await correctClassification(db, {
      classificationId,
      verdict: 'confirmed',
      evidence: { reasons: ['first reviewer'] },
      at: '2026-09-15T12:00:00Z',
    });

    await expect(
      correctClassification(db, {
        classificationId,
        verdict: 'rejected',
        evidence: { reasons: ['second reviewer, too late'] },
        at: '2026-09-15T12:05:00Z',
      }),
    ).rejects.toThrow(/already corrected/);
  });

  it('undo restores the predecessor and re-retires the correction, after a confirm', async () => {
    const { classificationId } = await addClassifiedListing(0.5);
    const { newClassificationId } = await correctClassification(db, {
      classificationId,
      verdict: 'confirmed',
      evidence: { reasons: ['confirmed by a human reviewer'] },
      at: '2026-09-15T12:00:00Z',
    });

    await undoClassificationCorrection(db, {
      classificationId: newClassificationId,
      at: '2026-09-15T12:10:00Z',
    });

    const [original] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, classificationId));
    expect(original?.supersededAt).toBeNull();
    const [correction] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, newClassificationId));
    expect(correction?.supersededAt).not.toBeNull();
  });

  it('undo restores the predecessor after a reject, even though the rejection row was born retired', async () => {
    const { classificationId } = await addClassifiedListing(0.5);
    const { newClassificationId } = await correctClassification(db, {
      classificationId,
      verdict: 'rejected',
      evidence: { reasons: ['not applicable'] },
      at: '2026-09-15T12:00:00Z',
    });

    await undoClassificationCorrection(db, {
      classificationId: newClassificationId,
      at: '2026-09-15T12:10:00Z',
    });

    const [original] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, classificationId));
    expect(original?.supersededAt).toBeNull();
  });

  it('refuses to undo a row that was never itself a correction', async () => {
    const { classificationId } = await addClassifiedListing(0.5);

    await expect(
      undoClassificationCorrection(db, { classificationId, at: '2026-09-15T12:00:00Z' }),
    ).rejects.toThrow(/nothing to undo/);
  });

  /**
   * The exact scenario the commit gate found real: correct A, undo A
   * (restoring the original), correct AGAIN as B — then a STALE undo
   * request for A arrives (e.g. a reviewer's page loaded before B
   * happened). Without checking that A is still the head of the chain,
   * this would silently reactivate A's predecessor, discarding B's verdict
   * with no conflict reported at all.
   */
  it('refuses a stale undo once a later correction has landed on the same pair', async () => {
    const { classificationId, revisionId } = await addClassifiedListing(0.5);
    const first = await correctClassification(db, {
      classificationId,
      verdict: 'confirmed',
      evidence: { reasons: ['first reviewer'] },
      at: '2026-09-15T12:00:00Z',
    });
    await undoClassificationCorrection(db, {
      classificationId: first.newClassificationId,
      at: '2026-09-15T12:05:00Z',
    });
    // A second, real correction lands on the same (now-restored) pair.
    await correctClassification(db, {
      classificationId,
      verdict: 'rejected',
      evidence: { reasons: ['second reviewer disagrees entirely'] },
      at: '2026-09-15T12:10:00Z',
    });

    // The stale request: undo the FIRST correction, long after it was
    // itself already undone and superseded by the second reviewer's verdict.
    await expect(
      undoClassificationCorrection(db, {
        classificationId: first.newClassificationId,
        at: '2026-09-15T12:15:00Z',
      }),
    ).rejects.toThrow(/no longer the most recent/);

    // The second reviewer's rejection must still stand — untouched.
    const live = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.sourceListingRevisionId, revisionId));
    expect(live.every((row) => row.supersededAt !== null)).toBe(true);
  });

  it('refuses a stale undo even when the later correction is a live confirm, rather than colliding with it', async () => {
    const { classificationId } = await addClassifiedListing(0.5);
    const first = await correctClassification(db, {
      classificationId,
      verdict: 'rejected',
      evidence: { reasons: ['first reviewer'] },
      at: '2026-09-15T12:00:00Z',
    });
    await undoClassificationCorrection(db, {
      classificationId: first.newClassificationId,
      at: '2026-09-15T12:05:00Z',
    });
    const second = await correctClassification(db, {
      classificationId,
      verdict: 'confirmed',
      evidence: { reasons: ['second reviewer confirms instead'] },
      at: '2026-09-15T12:10:00Z',
    });

    await expect(
      undoClassificationCorrection(db, {
        classificationId: first.newClassificationId,
        at: '2026-09-15T12:15:00Z',
      }),
    ).rejects.toThrow(/no longer the most recent/);

    const [live] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, second.newClassificationId));
    expect(live?.supersededAt).toBeNull();
    expect(live?.confidence).toBe(1);
  });

  /**
   * `canUndoCorrection` is what protects the "Corrected. Undo?" banner from
   * showing (and offering an action guaranteed to fail) for a stale or
   * hand-edited id — it must agree with what `undoClassificationCorrection`
   * itself would actually do.
   */
  it('canUndoCorrection reports true right after a correction and false once undone or superseded', async () => {
    const { classificationId } = await addClassifiedListing(0.5);
    const { newClassificationId } = await correctClassification(db, {
      classificationId,
      verdict: 'confirmed',
      evidence: { reasons: ['confirmed by a human reviewer'] },
      at: '2026-09-15T12:00:00Z',
    });

    expect(await canUndoCorrection(db, newClassificationId)).toBe(true);

    await undoClassificationCorrection(db, {
      classificationId: newClassificationId,
      at: '2026-09-15T12:05:00Z',
    });
    // Already undone — no longer the pair's head.
    expect(await canUndoCorrection(db, newClassificationId)).toBe(false);

    // Never a correction at all (the original deterministic row).
    expect(await canUndoCorrection(db, classificationId)).toBe(false);

    // A fresh correction on the same (now-restored) pair is itself
    // undoable, and undoing THAT one leaves the original correction above
    // still correctly reported as not undoable (it's no longer the head).
    const second = await correctClassification(db, {
      classificationId,
      verdict: 'rejected',
      evidence: { reasons: ['second reviewer'] },
      at: '2026-09-15T12:10:00Z',
    });
    expect(await canUndoCorrection(db, second.newClassificationId)).toBe(true);
    expect(await canUndoCorrection(db, newClassificationId)).toBe(false);
  });

  it('canUndoCorrection reports false for a nonexistent id, without throwing', async () => {
    expect(await canUndoCorrection(db, randomUUID())).toBe(false);
  });
});
