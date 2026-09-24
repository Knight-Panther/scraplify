import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../../../src/db/client.js';
import { getLiveMembership } from '../../../../../src/dedupe/membership-review.js';
import {
  duplicateCandidates,
  opportunities,
  opportunitySourceMemberships,
  sourceListingRevisions,
  sourceListings,
} from '../../../../../src/db/schema/index.js';
import {
  cleanupTestSource,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../../../../../src/db/test-support.js';

/**
 * Stage 10 — same reasoning as `../taxonomy/actions.test.ts`'s own header
 * comment: mocks `requireAdmin()` directly (its own logic is
 * `web/lib/admin-auth.test.ts`'s job), proving instead that each action
 * calls it FIRST and genuinely mutates nothing when it rejects.
 */
const requireAdminMock = vi.fn();
vi.mock('../../../../lib/admin-auth.js', () => ({ requireAdmin: () => requireAdminMock() }));
// See ../taxonomy/actions.test.ts's own comment: revalidatePath needs a
// request-scoped store this bare test run has no reason to set up.
vi.mock('next/cache.js', () => ({ revalidatePath: vi.fn() }));

const { acceptReviewPair, rejectReviewPair } = await import('./actions.js');

const UNAUTHENTICATED = Object.assign(new Error('NEXT_REDIRECT'), {
  digest: 'NEXT_REDIRECT;replace;/api/auth/signin;307;',
});
const NOT_ADMIN = Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK;404'), {
  digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
});
const ADMIN_SESSION = { user: { isAdmin: true, name: 'Test Admin' } };

function formData(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

describe('admin duplicate actions', () => {
  const sourceIds: string[] = [];

  async function makeOpportunity(title: string): Promise<string> {
    const id = randomUUID();
    await db.insert(opportunities).values({
      id,
      type: 'job',
      canonicalTitle: title,
      organizationId: null,
      canonicalStatus: 'active',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-06T12:00:00Z',
      updatedAt: '2026-09-06T12:00:00Z',
    });
    return id;
  }

  /** A listing with a real, titled revision — `rejectReviewPair` reads this title directly before acting. */
  async function makeListing(title: string): Promise<string> {
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
      titleRaw: title,
      titleNormalized: title,
      organizationRaw: 'Test employer',
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
    return listing.id;
  }

  async function addMembership(opportunityId: string, sourceListingId: string): Promise<void> {
    await db.insert(opportunitySourceMemberships).values({
      id: randomUUID(),
      opportunityId,
      sourceListingId,
      decision: 'confirmed_same',
      confidence: 0.97,
      evidence: { reasons: ['test fixture'] },
      decidedBy: 'ruleset',
      decidedAt: '2026-09-06T12:00:00Z',
      dedupeModelOrRulesetVersion: 'v1',
      supersededAt: null,
    });
  }

  async function pendingCandidate(a: string, b: string): Promise<string> {
    const candidateId = randomUUID();
    await db.insert(duplicateCandidates).values({
      id: candidateId,
      sourceListingIdA: a,
      sourceListingIdB: b,
      generatedAt: '2026-09-08T12:00:00Z',
      generationMethod: 'deterministic_match',
      similarityScore: 0.9,
      status: 'pending',
      resultingDecision: 'needs_review',
      evidence: {},
    });
    return candidateId;
  }

  /** Survivor (with a live membership) + moving listing + a pending candidate between them. */
  async function pendingPairFixture(): Promise<{
    candidateId: string;
    survivorListingId: string;
    movingListingId: string;
  }> {
    const survivorOpportunity = await makeOpportunity('Survivor role');
    const survivorListingId = await makeListing('Survivor role');
    await addMembership(survivorOpportunity, survivorListingId);

    const movingOpportunity = await makeOpportunity('Moving role');
    const movingListingId = await makeListing('Moving role');
    await addMembership(movingOpportunity, movingListingId);

    const candidateId = await pendingCandidate(survivorListingId, movingListingId);
    return { candidateId, survivorListingId, movingListingId };
  }

  afterEach(async () => {
    delete process.env.XTELO_WRITES_ENABLED;
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  describe('acceptReviewPair', () => {
    it('rejects and mutates nothing when unauthenticated', async () => {
      requireAdminMock.mockRejectedValueOnce(UNAUTHENTICATED);
      const { candidateId, survivorListingId, movingListingId } = await pendingPairFixture();

      await expect(
        acceptReviewPair(formData({ candidateId, survivorListingId, movingListingId })),
      ).rejects.toBe(UNAUTHENTICATED);

      expect(await getLiveMembership(db, movingListingId)).not.toBeNull();
      const [candidate] = await db
        .select()
        .from(duplicateCandidates)
        .where(eq(duplicateCandidates.id, candidateId));
      expect(candidate?.resultingDecision).toBe('needs_review');
    });

    it('rejects and mutates nothing when authenticated but not an admin', async () => {
      requireAdminMock.mockRejectedValueOnce(NOT_ADMIN);
      const { candidateId, survivorListingId, movingListingId } = await pendingPairFixture();

      await expect(
        acceptReviewPair(formData({ candidateId, survivorListingId, movingListingId })),
      ).rejects.toBe(NOT_ADMIN);

      const [candidate] = await db
        .select()
        .from(duplicateCandidates)
        .where(eq(duplicateCandidates.id, candidateId));
      expect(candidate?.resultingDecision).toBe('needs_review');
    });

    it('genuinely merges the pair for an allowlisted admin session', async () => {
      requireAdminMock.mockResolvedValueOnce(ADMIN_SESSION);
      process.env.XTELO_WRITES_ENABLED = 'true';
      const { candidateId, survivorListingId, movingListingId } = await pendingPairFixture();

      await expect(
        acceptReviewPair(formData({ candidateId, survivorListingId, movingListingId })),
      ).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT') });

      const survivorMembership = await getLiveMembership(db, survivorListingId);
      const movingMembership = await getLiveMembership(db, movingListingId);
      expect(movingMembership?.opportunityId).toBe(survivorMembership?.opportunityId);

      const [candidate] = await db
        .select()
        .from(duplicateCandidates)
        .where(eq(duplicateCandidates.id, candidateId));
      expect(candidate?.resultingDecision).not.toBe('needs_review');
    });
  });

  describe('rejectReviewPair', () => {
    it('rejects and mutates nothing when unauthenticated', async () => {
      requireAdminMock.mockRejectedValueOnce(UNAUTHENTICATED);
      const { candidateId, movingListingId } = await pendingPairFixture();

      await expect(rejectReviewPair(formData({ candidateId, movingListingId }))).rejects.toBe(
        UNAUTHENTICATED,
      );

      const [candidate] = await db
        .select()
        .from(duplicateCandidates)
        .where(eq(duplicateCandidates.id, candidateId));
      expect(candidate?.resultingDecision).toBe('needs_review');
    });

    it('rejects and mutates nothing when authenticated but not an admin', async () => {
      requireAdminMock.mockRejectedValueOnce(NOT_ADMIN);
      const { candidateId, movingListingId } = await pendingPairFixture();

      await expect(rejectReviewPair(formData({ candidateId, movingListingId }))).rejects.toBe(
        NOT_ADMIN,
      );

      const [candidate] = await db
        .select()
        .from(duplicateCandidates)
        .where(eq(duplicateCandidates.id, candidateId));
      expect(candidate?.resultingDecision).toBe('needs_review');
    });

    it('genuinely records the verdict for an allowlisted admin session', async () => {
      requireAdminMock.mockResolvedValueOnce(ADMIN_SESSION);
      process.env.XTELO_WRITES_ENABLED = 'true';
      const { candidateId, movingListingId } = await pendingPairFixture();

      await expect(
        rejectReviewPair(formData({ candidateId, movingListingId })),
      ).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT') });

      const [candidate] = await db
        .select()
        .from(duplicateCandidates)
        .where(eq(duplicateCandidates.id, candidateId));
      expect(candidate?.resultingDecision).not.toBe('needs_review');
    });
  });
});
