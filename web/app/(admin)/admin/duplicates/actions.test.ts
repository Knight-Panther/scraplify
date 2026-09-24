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
 * Stage 10 (auth coverage) + Stage 11 (audit wiring). Mocks
 * `requireAdminAudited`/`auditedMutation` from `web/lib/admin-audit.js` —
 * the module these actions actually call now — not `admin-auth.js`
 * directly: their own logic (including the audit rows they write) is
 * `web/lib/admin-audit.test.ts`'s job. `auditedMutationMock` is a thin
 * passthrough (`params.mutate(db)`) so the REAL underlying business logic
 * still runs against the real `db` here — these tests exist to prove each
 * action calls the guard FIRST and wires the real mutation correctly, not
 * to re-prove the audit machinery itself.
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
const ADMIN_SESSION = { user: { isAdmin: true, name: 'Test Admin', githubId: '424242' } };

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
      requireAdminAuditedMock.mockRejectedValueOnce(UNAUTHENTICATED);
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
      requireAdminAuditedMock.mockRejectedValueOnce(NOT_ADMIN);
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
      requireAdminAuditedMock.mockResolvedValueOnce(ADMIN_SESSION);
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

    it('audits a preflight failure (no live membership) even though it never reaches auditedMutation', async () => {
      // The exact gap Codex flagged (2026-09-24): a genuinely authorized,
      // writes-enabled admin whose attempt fails BEFORE `auditedMutation`
      // ever starts must still get a `failed` audit row, not silence.
      requireAdminAuditedMock.mockResolvedValueOnce(ADMIN_SESSION);
      process.env.XTELO_WRITES_ENABLED = 'true';
      // Both mocks accumulate call history across every test in this file
      // (no global `vi.clearAllMocks()` here) — cleared so this test's own
      // "not called"/"called once" assertions reflect only its own attempt.
      recordFailureMock.mockClear();
      auditedMutationMock.mockClear();
      const { candidateId, movingListingId } = await pendingPairFixture();
      const membershiplessListingId = await makeListing('No membership at all');

      await expect(
        acceptReviewPair(
          formData({
            candidateId,
            survivorListingId: membershiplessListingId,
            movingListingId,
          }),
        ),
      ).rejects.toThrow('has no live membership to merge into');

      expect(auditedMutationMock).not.toHaveBeenCalled();
      expect(recordFailureMock).toHaveBeenCalledTimes(1);
      expect(recordFailureMock).toHaveBeenCalledWith(
        expect.objectContaining({
          actorGithubId: '424242',
          entityType: 'duplicate_candidate',
          entityId: candidateId,
          action: 'duplicate_accept',
        }),
      );
    });
  });

  describe('rejectReviewPair', () => {
    it('rejects and mutates nothing when unauthenticated', async () => {
      requireAdminAuditedMock.mockRejectedValueOnce(UNAUTHENTICATED);
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
      requireAdminAuditedMock.mockRejectedValueOnce(NOT_ADMIN);
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
      requireAdminAuditedMock.mockResolvedValueOnce(ADMIN_SESSION);
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
