import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  adminAuditEvents,
  listingClassifications,
  sourceListingRevisions,
  sourceListings,
  sources,
  taxonomyTerms,
} from '../../src/db/schema/index.js';
import { correctClassification } from '../../src/taxonomy/correct-classification.js';
import {
  cleanupTestSource,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../../src/db/test-support.js';

/**
 * Mocks `requireAdmin()` AND `isDeniedError()` — not `importOriginal()`,
 * which would load the REAL `admin-auth.js`, which imports `../auth.js`,
 * which pulls in next-auth's full GitHub-provider config and hits the same
 * `next/server` nodenext resolution gap `web/types/next-server.d.ts` exists
 * to patch for `tsc` only (not for vitest's own module resolution at
 * runtime) — confirmed directly, not assumed: `importOriginal()` here fails
 * the whole suite with `ERR_MODULE_NOT_FOUND` for `next/server`.
 * `isDeniedError`'s own reimplementation below matches `admin-auth.ts`'s
 * real one exactly (`error instanceof Error && 'deniedActorGithubId' in
 * error`) — its own logic is `admin-auth.test.ts`'s job, already covered;
 * this predicate is trivial enough that duplicating it here is lower risk
 * than importing the module that triggers the resolution gap.
 */
const requireAdminMock = vi.fn();
vi.mock('./admin-auth.js', () => ({
  requireAdmin: () => requireAdminMock(),
  isDeniedError: (error: unknown) => error instanceof Error && 'deniedActorGithubId' in error,
}));

const { recordRefusal, requireAdminAudited, auditedMutation, recordFailure } = await import(
  './admin-audit.js'
);

const UNAUTHENTICATED = Object.assign(new Error('NEXT_REDIRECT'), {
  digest: 'NEXT_REDIRECT;replace;/api/auth/signin;307;',
});
/** Shaped exactly like `requireAdmin()`'s own real 'deny' throw (see admin-auth.ts). */
function deniedError(githubId: string | null): Error {
  return Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK;404'), {
    digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
    deniedActorGithubId: githubId,
  });
}

/**
 * Every `admin_audit_events` row this file's tests create is tracked here by
 * its `entityId` and swept in one shared `afterEach` — this table has no
 * FK/cascade tying it to any test fixture (Codex, 2026-09-24: an earlier
 * version of this file left every refusal/success/failure row it created
 * permanently in the shared development database, since only source
 * fixtures were cleaned up). `entityId` is unique-enough per test here
 * (always a fresh `randomUUID()` or a fresh fixture's own id), so cleanup by
 * that column is exact — it never risks deleting a real, pre-existing row.
 */
const auditedEntityIds: string[] = [];
function trackAudit(entityId: string): string {
  auditedEntityIds.push(entityId);
  return entityId;
}
afterEach(async () => {
  const ids = auditedEntityIds.splice(0);
  if (ids.length > 0) {
    await db.delete(adminAuditEvents).where(inArray(adminAuditEvents.entityId, ids));
  }
});

async function latestAuditRowFor(entityId: string) {
  const [row] = await db
    .select()
    .from(adminAuditEvents)
    .where(eq(adminAuditEvents.entityId, entityId))
    .orderBy(adminAuditEvents.occurredAt);
  return row;
}

/**
 * `recordRefusal` only writes when `writesEnabled()` (Codex, 2026-09-24: an
 * earlier version wrote unconditionally, so a rejected request against a
 * `local`-configured instance pointed at the real corpus with writes
 * "disabled" — this app's one hard rule — still mutated it). Every test
 * below that needs a real refusal row written sets this explicitly, rather
 * than relying on whatever the ambient test environment happens to have.
 */
describe('recordRefusal', () => {
  beforeEach(() => {
    process.env.XTELO_WRITES_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.XTELO_WRITES_ENABLED;
  });

  it('writes a refused row, actor null when there is none to name', async () => {
    const entityId = trackAudit(randomUUID());
    await recordRefusal({
      actorGithubId: null,
      entityType: 'duplicate_candidate',
      entityId,
      action: 'duplicate_accept',
      at: '2026-09-24T10:00:00Z',
    });
    const row = await latestAuditRowFor(entityId);
    expect(row?.outcome).toBe('refused');
    expect(row?.actorGithubId).toBeNull();
    expect(row?.action).toBe('duplicate_accept');
  });

  it('writes nothing when writes are disabled — the real safety-gate case', async () => {
    delete process.env.XTELO_WRITES_ENABLED;
    const entityId = trackAudit(randomUUID());
    await recordRefusal({
      actorGithubId: null,
      entityType: 'duplicate_candidate',
      entityId,
      action: 'duplicate_accept',
      at: '2026-09-24T10:00:00Z',
    });
    const row = await latestAuditRowFor(entityId);
    expect(row).toBeUndefined();
  });
});

describe('requireAdminAudited', () => {
  beforeEach(() => {
    process.env.XTELO_WRITES_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.XTELO_WRITES_ENABLED;
  });

  it('audits an unauthenticated refusal with no actor, then re-throws unchanged', async () => {
    requireAdminMock.mockRejectedValueOnce(UNAUTHENTICATED);
    const entityId = trackAudit(randomUUID());

    await expect(
      requireAdminAudited('taxonomy_confirm', 'listing_classification', entityId),
    ).rejects.toBe(UNAUTHENTICATED);

    const row = await latestAuditRowFor(entityId);
    expect(row?.outcome).toBe('refused');
    expect(row?.actorGithubId).toBeNull();
  });

  it('audits a non-admin refusal with the real denied actor id, then re-throws unchanged', async () => {
    const error = deniedError('111222');
    requireAdminMock.mockRejectedValueOnce(error);
    const entityId = trackAudit(randomUUID());

    await expect(
      requireAdminAudited('taxonomy_confirm', 'listing_classification', entityId),
    ).rejects.toBe(error);

    const row = await latestAuditRowFor(entityId);
    expect(row?.outcome).toBe('refused');
    expect(row?.actorGithubId).toBe('111222');
  });

  it('returns the session unchanged when admin', async () => {
    const session = { user: { isAdmin: true, githubId: '999999' } };
    requireAdminMock.mockResolvedValueOnce(session);
    await expect(
      requireAdminAudited('taxonomy_confirm', 'listing_classification', null),
    ).resolves.toBe(session);
  });
});

describe('recordFailure', () => {
  it('writes a failed row with a content-safe reason for a known conflict', async () => {
    const entityId = trackAudit(randomUUID());
    await recordFailure({
      actorGithubId: '424242',
      entityType: 'duplicate_candidate',
      entityId,
      action: 'duplicate_accept',
      at: '2026-09-24T10:00:00Z',
      error: new Error('acceptDuplicateCandidate: candidate is not awaiting review'),
    });
    const row = await latestAuditRowFor(entityId);
    expect(row?.outcome).toBe('failed');
    expect(row?.details).toMatchObject({ reason: 'known_conflict' });
  });

  it('writes a failed row with only a generic reason for an unrecognized error, never its raw message', async () => {
    const entityId = trackAudit(randomUUID());
    await recordFailure({
      actorGithubId: '424242',
      entityType: 'duplicate_candidate',
      entityId,
      action: 'duplicate_accept',
      at: '2026-09-24T10:00:00Z',
      error: new Error('some unrelated internal driver error with arbitrary content'),
    });
    const row = await latestAuditRowFor(entityId);
    expect(row?.outcome).toBe('failed');
    expect(row?.details).toEqual({ reason: 'unexpected_error' });
  });

  it('writes a failed row with entityId null when even the id itself could not be parsed', async () => {
    // A row with `entityId: null` can't be tracked by the shared
    // `auditedEntityIds` sweep (that array holds entity ids, and this row
    // deliberately has none) — so it needs its OWN exact identification. A
    // fresh, cryptographically unique `actorGithubId` (never reused anywhere
    // else, unlike the fixed `'424242'`/`'111222'` values other tests share)
    // is what makes the cleanup query below unambiguous: an
    // `entityType`+`isNull(entityId)` match alone could also match a
    // genuinely different, real `entityId: null` row already in the shared
    // development database — sorting by `occurredAt` and taking the latest
    // is a heuristic, not a guarantee, and Codex correctly flagged an
    // earlier version of this test for exactly that risk (2026-09-24): it
    // could delete a real row while leaving this test's own fabricated one
    // behind. Matching on a value only this test could ever have produced
    // removes the ambiguity entirely.
    const uniqueTestActorId = randomUUID();
    await recordFailure({
      actorGithubId: uniqueTestActorId,
      entityType: 'duplicate_candidate',
      entityId: null,
      action: 'duplicate_accept',
      at: '2026-09-24T10:00:00Z',
      error: new Error('acceptCandidateId: could not be parsed'),
    });
    try {
      const [row] = await db
        .select()
        .from(adminAuditEvents)
        .where(eq(adminAuditEvents.actorGithubId, uniqueTestActorId));
      expect(row?.outcome).toBe('failed');
      expect(row?.entityId).toBeNull();
    } finally {
      await db
        .delete(adminAuditEvents)
        .where(eq(adminAuditEvents.actorGithubId, uniqueTestActorId));
    }
  });
});

describe('auditedMutation', () => {
  const sourceIds: string[] = [];
  afterEach(async () => {
    for (const id of sourceIds.splice(0)) {
      await db
        .delete(sources)
        .where(eq(sources.id, id))
        .catch(() => {});
    }
  });

  it('commits the mutation and the succeeded audit row atomically', async () => {
    const sourceId = randomUUID();
    const entityId = trackAudit(randomUUID());

    const result = await auditedMutation({
      actorGithubId: '424242',
      entityType: 'duplicate_candidate',
      entityId,
      action: 'duplicate_accept',
      at: '2026-09-24T10:00:00Z',
      mutate: async (tx) => {
        await tx.insert(sources).values({
          id: sourceId,
          slug: `admin-audit-test-${sourceId}`,
          displayName: 'x',
          baseUrl: 'https://example.invalid/',
        });
        sourceIds.push(sourceId);
        return { ok: true };
      },
    });

    expect(result).toEqual({ ok: true });

    const [sourceRow] = await db.select().from(sources).where(eq(sources.id, sourceId));
    expect(sourceRow).toBeDefined();

    const auditRow = await latestAuditRowFor(entityId);
    expect(auditRow?.outcome).toBe('succeeded');
    expect(auditRow?.actorGithubId).toBe('424242');
  });

  it("rolls back the mutation on a throw — auditing the failure is the CALLER's job, not this function's", async () => {
    const sourceId = randomUUID();
    const entityId = trackAudit(randomUUID());
    const at = '2026-09-24T10:00:00Z';

    // Mirrors exactly what a real admin action does (Codex, 2026-09-24: an
    // earlier version had `auditedMutation` write its own `failed` row
    // internally, which meant a preflight failure BEFORE `auditedMutation`
    // ever ran — a missing membership, a malformed field — got no audit row
    // at all. Moving `recordFailure` to the caller's own `catch` means every
    // failure in one action, preflight or not, is audited exactly once, at
    // the same point.)
    try {
      await auditedMutation({
        actorGithubId: '424242',
        entityType: 'duplicate_candidate',
        entityId,
        action: 'duplicate_reject',
        at,
        mutate: async (tx) => {
          // A real write, deliberately followed by a throw — proves the
          // OUTER transaction genuinely rolls this back too (the whole
          // reason `auditedMutation` opens its own outer transaction), not
          // just that a failure gets audited.
          await tx.insert(sources).values({
            id: sourceId,
            slug: `admin-audit-test-${sourceId}`,
            displayName: 'x',
            baseUrl: 'https://example.invalid/',
          });
          sourceIds.push(sourceId);
          throw new Error('acceptDuplicateCandidate: forced failure for this test');
        },
      });
      expect.unreachable('auditedMutation should have thrown');
    } catch (error) {
      await recordFailure({
        actorGithubId: '424242',
        entityType: 'duplicate_candidate',
        entityId,
        action: 'duplicate_reject',
        at,
        error,
      });
    }

    const [sourceRow] = await db.select().from(sources).where(eq(sources.id, sourceId));
    expect(sourceRow).toBeUndefined();

    const auditRow = await latestAuditRowFor(entityId);
    expect(auditRow?.outcome).toBe('failed');
    expect(auditRow?.actorGithubId).toBe('424242');
    expect(auditRow?.details).toMatchObject({ reason: 'known_conflict' });
  });
});

/**
 * `auditedMutation` wrapping a REAL business-logic function
 * (`correctClassification`, not a synthetic `mutate` closure) — closes the
 * gap the dedupe-correctness-reviewer flagged: the tests above prove the
 * general nested-transaction mechanism works, but none of them exercise the
 * exact composition this change exists for (a real function's own internal
 * `db.transaction()`/`for('update')` lock, nested as a savepoint inside
 * `auditedMutation`'s outer transaction). This closes that specific gap.
 */
describe('auditedMutation composed with a real business-logic function', () => {
  const sourceIds: string[] = [];
  const termIds: string[] = [];

  async function addClassifiedListing(): Promise<{ classificationId: string }> {
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
      confidence: 0.5,
      evidence: { reasons: ['test fixture'] },
      taxonomyVersion: 'v1',
      createdAt: '2026-09-01T00:00:00Z',
    });
    return { classificationId };
  }

  afterEach(async () => {
    const ownedTermIds = termIds.splice(0);
    for (const sourceId of sourceIds.splice(0)) {
      await cleanupTestSource(sourceId, { taxonomyTermIds: ownedTermIds });
    }
  });

  it('commits the real classification correction and the audit row together', async () => {
    const { classificationId } = await addClassifiedListing();
    trackAudit(classificationId);

    const result = await auditedMutation({
      actorGithubId: '424242',
      entityType: 'listing_classification',
      entityId: classificationId,
      action: 'taxonomy_confirm',
      at: '2026-09-24T12:00:00Z',
      mutate: (tx) =>
        correctClassification(tx, {
          classificationId,
          verdict: 'confirmed',
          evidence: { reasons: ['real end-to-end test'] },
          at: '2026-09-24T12:00:00Z',
        }),
    });

    const [original] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, classificationId));
    expect(original?.supersededAt).toBe('2026-09-24 12:00:00+00');

    const [replacement] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, result.newClassificationId));
    expect(replacement?.method).toBe('human_review');

    const auditRow = await latestAuditRowFor(classificationId);
    expect(auditRow?.outcome).toBe('succeeded');
  });

  it('rolls back a real correction attempt AND its own internal for-update lock together, when it throws a real business conflict', async () => {
    const { classificationId } = await addClassifiedListing();
    trackAudit(classificationId);
    const at = '2026-09-24T12:00:00Z';
    // Correct it once for real, so the SECOND attempt below hits
    // `correctClassification`'s own real "already corrected" guard — a
    // genuine business-logic throw, not a synthetic one.
    await correctClassification(db, {
      classificationId,
      verdict: 'confirmed',
      evidence: { reasons: ['first, real correction'] },
      at: '2026-09-24T11:00:00Z',
    });

    try {
      await auditedMutation({
        actorGithubId: '424242',
        entityType: 'listing_classification',
        entityId: classificationId,
        action: 'taxonomy_confirm',
        at,
        mutate: (tx) =>
          correctClassification(tx, {
            classificationId,
            verdict: 'confirmed',
            evidence: { reasons: ['second attempt, should conflict'] },
            at,
          }),
      });
      expect.unreachable('auditedMutation should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('already corrected');
      await recordFailure({
        actorGithubId: '424242',
        entityType: 'listing_classification',
        entityId: classificationId,
        action: 'taxonomy_confirm',
        at,
        error,
      });
    }

    // Real proof the nested savepoint rolled back cleanly: the original
    // classification's `supersededAt` still reflects the FIRST correction
    // (11:00, not 12:00) — a broken rollback would show 12:00 here, or a
    // second `human_review` row that should not exist.
    const [original] = await db
      .select()
      .from(listingClassifications)
      .where(eq(listingClassifications.id, classificationId));
    expect(original?.supersededAt).toBe('2026-09-24 11:00:00+00');

    const auditRow = await latestAuditRowFor(classificationId);
    expect(auditRow?.outcome).toBe('failed');
    expect(auditRow?.details).toMatchObject({ reason: 'known_conflict' });
  });
});
