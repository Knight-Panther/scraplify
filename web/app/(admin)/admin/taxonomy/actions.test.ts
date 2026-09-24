import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../../../src/db/client.js';
import {
  listingClassifications,
  sourceListingRevisions,
  sourceListings,
  taxonomyTerms,
} from '../../../../../src/db/schema/index.js';
import {
  cleanupTestSource,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../../../../../src/db/test-support.js';

/**
 * Stage 10 (change.md §14's own test-gate line: "auth coverage for every
 * admin page, action and handler, not only its rejections") + Stage 11
 * (audit wiring). Mocks `requireAdminAudited`/`auditedMutation` from
 * `web/lib/admin-audit.js` — the module these actions actually call now —
 * not `admin-auth.js` directly: their own logic (including the audit rows
 * they write) is `web/lib/admin-audit.test.ts`'s job. What THESE tests prove
 * is that each action actually calls the guard, FIRST, and genuinely does
 * nothing when it rejects — exactly the class of bug ("a `requireAdmin()`
 * accidentally omitted from one mutation") the Stage 10 plan names as what
 * route-level tests alone cannot catch. `auditedMutationMock` is a thin
 * passthrough (`params.mutate(db)`) so the REAL underlying business logic
 * still runs against the real `db`.
 */
const requireAdminAuditedMock = vi.fn();
const auditedMutationMock = vi.fn(async (params: { mutate: (tx: typeof db) => Promise<unknown> }) =>
  params.mutate(db),
);
const recordFailureMock = vi.fn();
vi.mock('../../../../lib/admin-audit.js', () => ({
  requireAdminAudited: (...args: unknown[]) => requireAdminAuditedMock(...args),
  auditedMutation: (...args: [{ mutate: (tx: typeof db) => Promise<unknown> }]) =>
    auditedMutationMock(...args),
  recordFailure: (...args: unknown[]) => recordFailureMock(...args),
}));

// `revalidatePath` needs Next's own internal request-scoped "static
// generation store" (an AsyncLocalStorage this bare vitest run has no
// reason to set up) and throws an Invariant outside it — unlike
// `redirect()`/`notFound()`, which work standalone (verified directly
// before writing this file) and are left real below. Cache invalidation
// itself touches no database row, so mocking it costs nothing real.
vi.mock('next/cache.js', () => ({ revalidatePath: vi.fn() }));

const { confirmClassification, rejectClassification, undoCorrection } = await import(
  './actions.js'
);

const UNAUTHENTICATED = Object.assign(new Error('NEXT_REDIRECT'), {
  digest: 'NEXT_REDIRECT;replace;/api/auth/signin;307;',
});
const NOT_ADMIN = Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK;404'), {
  digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
});
const ADMIN_SESSION = { user: { isAdmin: true, name: 'Test Admin', githubId: '424242' } };

function formData(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

describe('admin taxonomy actions', () => {
  const sourceIds: string[] = [];
  const termIds: string[] = [];

  /** Mirrors `src/taxonomy/correct-classification.test.ts`'s own fixture exactly — same shape, same reason. */
  async function addClassifiedListing(confidence = 0.5): Promise<{ classificationId: string }> {
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
      titleRaw: 'ტესტის ვაკანსია',
      titleNormalized: 'ტესტის ვაკანსია',
      organizationRaw: 'ტესტი',
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
      label: 'ტესტი',
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
    return { classificationId };
  }

  afterEach(async () => {
    delete process.env.XTELO_WRITES_ENABLED;
    const ownedTermIds = termIds.splice(0);
    for (const sourceId of sourceIds.splice(0)) {
      await cleanupTestSource(sourceId, { taxonomyTermIds: ownedTermIds });
    }
  });

  describe.each([
    ['confirmClassification', confirmClassification],
    ['rejectClassification', rejectClassification],
  ] as const)('%s', (_name, action) => {
    it('rejects and mutates nothing when unauthenticated', async () => {
      requireAdminAuditedMock.mockRejectedValueOnce(UNAUTHENTICATED);
      const { classificationId } = await addClassifiedListing();

      await expect(action(formData({ classificationId }))).rejects.toBe(UNAUTHENTICATED);

      const [row] = await db
        .select()
        .from(listingClassifications)
        .where(eq(listingClassifications.id, classificationId));
      expect(row?.supersededAt).toBeNull();
    });

    it('rejects and mutates nothing when authenticated but not an admin', async () => {
      requireAdminAuditedMock.mockRejectedValueOnce(NOT_ADMIN);
      const { classificationId } = await addClassifiedListing();

      await expect(action(formData({ classificationId }))).rejects.toBe(NOT_ADMIN);

      const [row] = await db
        .select()
        .from(listingClassifications)
        .where(eq(listingClassifications.id, classificationId));
      expect(row?.supersededAt).toBeNull();
    });

    it('genuinely commits for an allowlisted admin session', async () => {
      requireAdminAuditedMock.mockResolvedValueOnce(ADMIN_SESSION);
      process.env.XTELO_WRITES_ENABLED = 'true';
      const { classificationId } = await addClassifiedListing();

      // redirect() throws — the success path IS a thrown NEXT_REDIRECT.
      await expect(action(formData({ classificationId }))).rejects.toMatchObject({
        digest: expect.stringContaining('NEXT_REDIRECT'),
      });

      const [row] = await db
        .select()
        .from(listingClassifications)
        .where(eq(listingClassifications.id, classificationId));
      // Retired either way (confirm and reject both supersede the original) —
      // this proves the mutation genuinely reached the database, not that a
      // specific verdict was recorded (that correctness is already
      // `src/taxonomy/correct-classification.test.ts`'s own job).
      expect(row?.supersededAt).not.toBeNull();
    });

    it('audits a preflight failure (malformed classificationId) even though it never reaches auditedMutation', async () => {
      // The exact gap Codex flagged (2026-09-24): a genuinely authorized,
      // writes-enabled admin whose attempt fails BEFORE `auditedMutation`
      // ever starts must still get a `failed` audit row, not silence — here
      // via the strict re-read inside the try, since `entityId` couldn't be
      // parsed even loosely (`safeClassificationId` also returns `null`).
      requireAdminAuditedMock.mockResolvedValueOnce(ADMIN_SESSION);
      process.env.XTELO_WRITES_ENABLED = 'true';
      recordFailureMock.mockClear();
      auditedMutationMock.mockClear();

      await expect(action(formData({ classificationId: 'not-a-real-uuid' }))).rejects.toThrow();

      expect(auditedMutationMock).not.toHaveBeenCalled();
      expect(recordFailureMock).toHaveBeenCalledTimes(1);
      expect(recordFailureMock).toHaveBeenCalledWith(
        expect.objectContaining({
          actorGithubId: '424242',
          entityType: 'listing_classification',
          entityId: null,
        }),
      );
    });
  });

  describe('undoCorrection', () => {
    async function correctedClassification(): Promise<{ correctionId: string }> {
      const { classificationId } = await addClassifiedListing();
      // A real correction, via the actual business logic — not hand-inserted
      // — so its shape (previousClassificationId, method, etc.) is genuine.
      const { correctClassification } = await import(
        '../../../../../src/taxonomy/correct-classification.js'
      );
      const { newClassificationId } = await correctClassification(db, {
        classificationId,
        verdict: 'confirmed',
        evidence: { reasons: ['fixture setup'] },
        at: '2026-09-01T01:00:00Z',
      });
      return { correctionId: newClassificationId };
    }

    it('rejects and mutates nothing when unauthenticated', async () => {
      requireAdminAuditedMock.mockRejectedValueOnce(UNAUTHENTICATED);
      const { correctionId } = await correctedClassification();

      await expect(undoCorrection(formData({ classificationId: correctionId }))).rejects.toBe(
        UNAUTHENTICATED,
      );

      const [row] = await db
        .select()
        .from(listingClassifications)
        .where(eq(listingClassifications.id, correctionId));
      expect(row?.supersededAt).toBeNull();
    });

    it('rejects and mutates nothing when authenticated but not an admin', async () => {
      requireAdminAuditedMock.mockRejectedValueOnce(NOT_ADMIN);
      const { correctionId } = await correctedClassification();

      await expect(undoCorrection(formData({ classificationId: correctionId }))).rejects.toBe(
        NOT_ADMIN,
      );

      const [row] = await db
        .select()
        .from(listingClassifications)
        .where(eq(listingClassifications.id, correctionId));
      expect(row?.supersededAt).toBeNull();
    });

    it('genuinely commits for an allowlisted admin session', async () => {
      requireAdminAuditedMock.mockResolvedValueOnce(ADMIN_SESSION);
      process.env.XTELO_WRITES_ENABLED = 'true';
      const { correctionId } = await correctedClassification();

      await expect(
        undoCorrection(formData({ classificationId: correctionId })),
      ).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT') });

      const [row] = await db
        .select()
        .from(listingClassifications)
        .where(eq(listingClassifications.id, correctionId));
      expect(row?.supersededAt).not.toBeNull();
    });
  });
});
