import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../client.js';
import type { SourcePolicy } from '../../domain/source.js';
import { syncSourcePolicy } from '../source-policies.js';
import {
  cleanupTestSource,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../test-support.js';
import {
  opportunities,
  opportunityRevisions,
  opportunitySourceMemberships,
  publicOpportunities,
  publicOpportunityMembers,
  publicSourceListings,
  sourceListingRevisions,
  sourceListings,
  sources,
  sourcePolicies,
} from './index.js';

/**
 * A minimal, schema-legal `SourcePolicy`, deliberately setting only
 * `display.mayRepublishFullContent`/`reviewDate` and leaving every other
 * field an empty-but-legal shape — this file tests the view's own
 * redaction boundary and `syncSourcePolicy()`'s revision-history behavior,
 * not the policy Zod schema itself. `id` and `policyVersion` are randomized
 * per call by default so an equality-comparison test can force them equal
 * across two calls when it specifically wants to simulate "truly no
 * change" (see the no-op test below) — real `SourcePolicy` instances don't
 * randomize either field, but `syncSourcePolicy()` doesn't use incoming
 * `id` for the stored row's identity anyway (see its own doc comment), so
 * this only affects test realism, never correctness of what's exercised.
 */
function buildPolicy(
  sourceId: string,
  mayRepublishFullContent: boolean,
  reviewDate: string = '2026-09-01T00:00:00Z',
): SourcePolicy {
  return {
    id: randomUUID(),
    sourceId: sourceId as SourcePolicy['sourceId'],
    policyVersion: `test-${randomUUID().slice(0, 8)}`,
    allowedAcquisitionModes: ['http'],
    allowedPathPatterns: [{ pattern: '/', match: 'exact' }],
    disallowedPathPatterns: [],
    disallowedHosts: [],
    allowedHosts: ['example.invalid'],
    authenticationScope: 'none',
    rateLimit: { crawlDelaySeconds: 0, maxConcurrency: 1, notes: 'test' },
    termsUrl: null,
    robotsUrl: 'https://example.invalid/robots.txt',
    retention: { rawHtmlRetentionDays: null, notes: 'test' },
    display: { mayRepublishFullContent, notes: 'test' },
    linkedResources: {
      allowedDestinationHosts: [],
      allowedRelationshipTypes: [],
      maxTraversalDepth: 0,
      maxResourcesPerOpportunity: 0,
      mayFetchExternalApplicationPages: false,
      retention: 'none',
      notes: 'test',
    },
    reviewDate,
    evidence: ['test'],
    notes: 'test',
    decisionOwner: 'test',
  };
}

/** Syncs a test source's policy through the REAL production function, not a hand-rolled insert. */
async function setSourcePolicy(
  sourceId: string,
  mayRepublishFullContent: boolean,
  reviewDate: string = '2026-09-01T00:00:00Z',
): Promise<void> {
  await syncSourcePolicy(db, buildPolicy(sourceId, mayRepublishFullContent, reviewDate));
}

/**
 * Phase 8B Stage 3: these two views are the public database role's ENTIRE
 * visible surface (see public-views.ts's own comment) — so what they
 * include and exclude is a real security property, not just a query
 * convenience, and is tested against a real database rather than assumed
 * from reading the SQL.
 */
describe('public database views', () => {
  const sourceIds: string[] = [];
  const listingIds: string[] = [];
  const opportunityIds: string[] = [];

  async function addOpportunityWithListing(spec: {
    listingStatus: 'active' | 'quarantined';
    opportunityStatus: 'active' | 'quarantined';
    superseded?: boolean;
  }): Promise<{ opportunityId: string; listingId: string; sourceId: string; title: string }> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const listing = await createTestSourceListing(sourceId, { status: spec.listingStatus });
    const resourceId = await createTestResource(sourceId);
    const revisionId = randomUUID();
    const title = `Public view test ${randomUUID().slice(0, 8)}`;
    await db.insert(sourceListingRevisions).values({
      id: revisionId,
      sourceListingId: listing.id,
      parserVersion: 'test-v1',
      extractionMethod: 'http',
      rawResourceHash: 'a'.repeat(64),
      meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      titleRaw: title,
      titleNormalized: title.toLowerCase(),
      organizationRaw: 'Public View Test Org',
      description: 'a public-safe description',
      locations: [],
      publishedDate: { raw: '', parsed: '2026-09-01T00:00:00Z' },
      deadlineDate: { raw: '', parsed: '2026-12-01T00:00:00Z' },
      applicationMethod: { type: 'email', value: 'apply@example.invalid' },
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
    listingIds.push(listing.id);

    const opportunityId = randomUUID();
    opportunityIds.push(opportunityId);
    await db.insert(opportunities).values({
      id: opportunityId,
      type: 'job',
      canonicalTitle: title,
      organizationId: null,
      canonicalStatus: spec.opportunityStatus,
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    });
    await db.insert(opportunitySourceMemberships).values({
      id: randomUUID(),
      opportunityId,
      sourceListingId: listing.id,
      decision: 'confirmed_same',
      confidence: 1,
      // Deliberately non-empty, so a test failure here would show the leak
      // plainly rather than passing on an empty-object coincidence.
      evidence: { reasons: ['this must never reach the public view'] },
      decidedBy: 'human',
      decidedAt: '2026-09-01T00:00:00Z',
      dedupeModelOrRulesetVersion: 'v1',
      supersededAt: spec.superseded === true ? '2026-09-02T00:00:00Z' : null,
    });

    return { opportunityId, listingId: listing.id, sourceId, title };
  }

  /** A source listing with no opportunity/membership at all — the shape a fresh crawl writes before dedupe has clustered it. */
  async function addBareListing(spec: {
    status: 'active' | 'quarantined';
  }): Promise<{ listingId: string; title: string }> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const listing = await createTestSourceListing(sourceId, { status: spec.status });
    const resourceId = await createTestResource(sourceId);
    const revisionId = randomUUID();
    const title = `Public view bare listing ${randomUUID().slice(0, 8)}`;
    await db.insert(sourceListingRevisions).values({
      id: revisionId,
      sourceListingId: listing.id,
      parserVersion: 'test-v1',
      extractionMethod: 'http',
      rawResourceHash: 'a'.repeat(64),
      meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      titleRaw: title,
      titleNormalized: title.toLowerCase(),
      organizationRaw: 'Public View Test Org',
      description: 'a public-safe description',
      locations: [],
      publishedDate: { raw: '', parsed: '2026-09-01T00:00:00Z' },
      deadlineDate: { raw: '', parsed: '2026-12-01T00:00:00Z' },
      applicationMethod: { type: 'email', value: 'apply@example.invalid' },
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
    listingIds.push(listing.id);
    return { listingId: listing.id, title };
  }

  afterEach(async () => {
    if (listingIds.length > 0) {
      await db
        .delete(opportunitySourceMemberships)
        .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
      listingIds.length = 0;
    }
    if (opportunityIds.length > 0) {
      await db
        .update(opportunities)
        .set({ currentCanonicalRevisionId: null })
        .where(inArray(opportunities.id, opportunityIds));
      await db
        .delete(opportunityRevisions)
        .where(inArray(opportunityRevisions.opportunityId, opportunityIds));
      await db.delete(opportunities).where(inArray(opportunities.id, opportunityIds));
      opportunityIds.length = 0;
    }
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  it('includes an active opportunity and its live member', async () => {
    const { opportunityId, listingId, title } = await addOpportunityWithListing({
      listingStatus: 'active',
      opportunityStatus: 'active',
    });

    const [opp] = await db
      .select()
      .from(publicOpportunities)
      .where(eq(publicOpportunities.id, opportunityId));
    expect(opp?.canonicalTitle).toBe(title);
    expect(opp?.canonicalStatus).toBe('active');

    const [member] = await db
      .select()
      .from(publicOpportunityMembers)
      .where(eq(publicOpportunityMembers.sourceListingId, listingId));
    expect(member?.opportunityId).toBe(opportunityId);
    expect(member?.title).toBe(title);
    // No source_policies row exists for this test source — the view's own
    // redaction CASE defaults closed, same as public-queries.ts's own
    // "defaulting closed" posture. See the dedicated redaction tests below
    // for the explicit true/false cases.
    expect(member?.description).toBe('');
    // The whole point of this view: dedupe internals are not columns it has
    // at all, not merely values it happens to omit.
    expect(member).not.toHaveProperty('evidence');
    expect(member).not.toHaveProperty('decision');
    expect(member).not.toHaveProperty('confidence');
    expect(member).not.toHaveProperty('decidedBy');
  });

  /**
   * The database-level half of the content-republishing boundary
   * (adversarial review, 2026-09-24): `scraplify_public` is granted `SELECT`
   * directly on this view, so redaction has to hold here, in the view's own
   * SQL, independent of `src/browse/public-queries.ts`'s TypeScript-side
   * `publicDescription()` — these tests query the view directly, the same
   * way the public role itself would, never through that application code.
   */
  describe('description redaction (source_policies boundary)', () => {
    it('passes description through when the source policy explicitly permits full-content republishing', async () => {
      const { listingId, sourceId } = await addOpportunityWithListing({
        listingStatus: 'active',
        opportunityStatus: 'active',
      });
      await setSourcePolicy(sourceId, true);

      const [member] = await db
        .select()
        .from(publicOpportunityMembers)
        .where(eq(publicOpportunityMembers.sourceListingId, listingId));
      expect(member?.description).toBe('a public-safe description');
    });

    it('redacts description to an empty string when the source policy explicitly forbids full-content republishing', async () => {
      const { listingId, sourceId } = await addOpportunityWithListing({
        listingStatus: 'active',
        opportunityStatus: 'active',
      });
      await setSourcePolicy(sourceId, false);

      const [member] = await db
        .select()
        .from(publicOpportunityMembers)
        .where(eq(publicOpportunityMembers.sourceListingId, listingId));
      expect(member?.description).toBe('');
    });

    // Codex-caught P1, round 12, 2026-09-25: an unresolved same-date conflict
    // leaves the pointer on whichever revision won the race, which may be the
    // permissive one -- the view must redact regardless until it's resolved.
    it('redacts description while a policy conflict is unresolved, even if the current revision permits republishing', async () => {
      const { listingId, sourceId } = await addOpportunityWithListing({
        listingStatus: 'active',
        opportunityStatus: 'active',
      });
      await setSourcePolicy(sourceId, true);
      await db
        .update(sources)
        .set({ policyConflictAt: new Date().toISOString() })
        .where(eq(sources.id, sourceId));

      const [member] = await db
        .select()
        .from(publicOpportunityMembers)
        .where(eq(publicOpportunityMembers.sourceListingId, listingId));
      expect(member?.description).toBe('');
    });

    it('redacts description to an empty string when no source_policies row exists at all', async () => {
      // No setSourcePolicy call — proves the LEFT JOIN's default-closed
      // behavior, not merely a false value, is what redacts.
      const { listingId } = await addOpportunityWithListing({
        listingStatus: 'active',
        opportunityStatus: 'active',
      });

      const [member] = await db
        .select()
        .from(publicOpportunityMembers)
        .where(eq(publicOpportunityMembers.sourceListingId, listingId));
      expect(member?.description).toBe('');
    });

    /**
     * `syncSourcePolicy()` (`src/db/source-policies.ts`) is round 6 of the
     * same adversarial review (2026-09-24), replacing round 5's `.unique()`
     * upsert-in-place design after it was found to regress
     * `docs/scraplify-concept.md` §5.3's "versioned policy record"
     * requirement — an update in place destroys the prior revision's
     * `evidence`/`decisionOwner` the moment a new one lands. These tests
     * prove the real invariants: a genuine content change creates a NEW
     * revision (history preserved, not overwritten) and repoints
     * `sources.currentPolicyRevisionId`; an identical resync is a no-op
     * (no revision spam on every crawl run); and a stale/older policy
     * cannot downgrade a newer, more restrictive one already in effect.
     */
    it('a genuine content change creates a NEW revision and repoints current, without destroying the old revision', async () => {
      const { listingId, sourceId } = await addOpportunityWithListing({
        listingStatus: 'active',
        opportunityStatus: 'active',
      });
      await setSourcePolicy(sourceId, true, '2026-01-01T00:00:00Z');
      await setSourcePolicy(sourceId, false, '2026-09-01T00:00:00Z');

      const policyRows = await db
        .select()
        .from(sourcePolicies)
        .where(eq(sourcePolicies.sourceId, sourceId));
      // Both revisions still exist — history preserved, not overwritten.
      expect(policyRows).toHaveLength(2);
      expect(policyRows.some((row) => row.display === null)).toBe(false);

      const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
      const current = policyRows.find((row) => row.id === source?.currentPolicyRevisionId);
      expect(
        (current?.display as { mayRepublishFullContent: boolean } | undefined)
          ?.mayRepublishFullContent,
      ).toBe(false);

      const rows = await db
        .select()
        .from(publicOpportunityMembers)
        .where(eq(publicOpportunityMembers.sourceListingId, listingId));
      // Exactly one row, not one per revision the source happens to have —
      // the view joins through the explicit pointer, not source_id.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.description).toBe('');
    });

    it('re-syncing identical content is a no-op — no new revision row, current unchanged', async () => {
      const { sourceId } = await addOpportunityWithListing({
        listingStatus: 'active',
        opportunityStatus: 'active',
      });
      const policy = buildPolicy(sourceId, true, '2026-01-01T00:00:00Z');
      await syncSourcePolicy(db, policy);
      const [sourceAfterFirst] = await db.select().from(sources).where(eq(sources.id, sourceId));
      const firstRevisionId = sourceAfterFirst?.currentPolicyRevisionId;

      // The EXACT same policy object again — matching real behavior, where
      // every crawl re-syncs the same unchanged TypeScript policy file.
      await syncSourcePolicy(db, policy);

      const policyRows = await db
        .select()
        .from(sourcePolicies)
        .where(eq(sourcePolicies.sourceId, sourceId));
      expect(policyRows).toHaveLength(1);
      const [sourceAfterSecond] = await db.select().from(sources).where(eq(sources.id, sourceId));
      expect(sourceAfterSecond?.currentPolicyRevisionId).toBe(firstRevisionId);
    });

    /**
     * Codex-caught P1, round 10, 2026-09-25: an earlier version of
     * `syncSourcePolicy` read the current revision UNLOCKED first and
     * returned 'no-op' immediately when content already matched, skipping
     * `db.transaction()`/the row lock entirely as a performance
     * optimization. That read could be answered from a snapshot already
     * stale by the time the caller acted on it -- if another deployment
     * updated `currentPolicyRevisionId` or set `policyConflictAt` in the
     * instant between the read and the return, the caller would proceed
     * believing its policy was still current when the database had already
     * moved on. Fixed by removing the unlocked fast path: every call now
     * re-confirms under the same `SELECT ... FOR UPDATE` lock as an
     * accepted write, whether or not anything ends up written. This test
     * pins that down at the mechanism level (not just the outcome, which
     * the no-op test above already covers) — a regression back to the
     * unlocked shortcut would pass every outcome-level assertion while
     * reopening exactly this race.
     */
    it('re-syncing identical content still takes a real transaction, not an unlocked shortcut', async () => {
      const { sourceId } = await addOpportunityWithListing({
        listingStatus: 'active',
        opportunityStatus: 'active',
      });
      const policy = buildPolicy(sourceId, true, '2026-01-01T00:00:00Z');
      await syncSourcePolicy(db, policy);

      const transactionSpy = vi.spyOn(db, 'transaction');
      await syncSourcePolicy(db, policy);
      expect(transactionSpy).toHaveBeenCalled();
      transactionSpy.mockRestore();
    });

    it('refuses to activate a policy older than the one already current, and does not create a revision for it', async () => {
      const { listingId, sourceId } = await addOpportunityWithListing({
        listingStatus: 'active',
        opportunityStatus: 'active',
      });
      // The CURRENT revision is restrictive and recent.
      await setSourcePolicy(sourceId, false, '2026-09-05T00:00:00Z');
      // A stale worker or a stale deployment tries to sync an OLDER,
      // permissive policy -- must be refused, not silently applied.
      await setSourcePolicy(sourceId, true, '2026-01-01T00:00:00Z');

      const policyRows = await db
        .select()
        .from(sourcePolicies)
        .where(eq(sourcePolicies.sourceId, sourceId));
      // The stale attempt created no new row at all.
      expect(policyRows).toHaveLength(1);

      const rows = await db
        .select()
        .from(publicOpportunityMembers)
        .where(eq(publicOpportunityMembers.sourceListingId, listingId));
      // Still redacted -- the newer, more restrictive policy still governs.
      expect(rows[0]?.description).toBe('');
    });

    /**
     * A same-day TIE, not an older date (round 7 of the same adversarial
     * review, 2026-09-25): the guard above used strict `<`, so two
     * revisions sharing a `reviewDate` -- a real case, since this
     * project's real policy files use date-at-midnight timestamps -- were
     * NOT caught by it, letting a stale worker's differently-content
     * policy through whenever it happened to share today's date with
     * whatever's already current. This test is the one that would have
     * failed against the pre-fix `<` comparison.
     */
    it('refuses to activate a policy that TIES the current revision on reviewDate but has different content', async () => {
      const { listingId, sourceId } = await addOpportunityWithListing({
        listingStatus: 'active',
        opportunityStatus: 'active',
      });
      const sameDay = '2026-09-05T00:00:00Z';
      await setSourcePolicy(sourceId, false, sameDay);
      await setSourcePolicy(sourceId, true, sameDay);

      const policyRows = await db
        .select()
        .from(sourcePolicies)
        .where(eq(sourcePolicies.sourceId, sourceId));
      expect(policyRows).toHaveLength(1);

      const rows = await db
        .select()
        .from(publicOpportunityMembers)
        .where(eq(publicOpportunityMembers.sourceListingId, listingId));
      expect(rows[0]?.description).toBe('');
    });

    /**
     * Codex-caught P1, round 8, 2026-09-25: the tie test above only proves
     * the SECOND caller of two same-date, differing-content syncs is
     * refused — it does not prove the FIRST caller (the one whose write
     * actually won the race to become current) is ever affected. Without
     * `sources.policyConflictAt`, a first-writer-wins race meant whichever
     * of two concurrently-deployed policies happened to sync first would
     * become current and stay current indefinitely — a stale/permissive
     * winner would never know anything was wrong, since its own next
     * routine re-sync of unchanged content would just see 'no-op'. This
     * test proves the fix: once the tie is detected, EVERY sync for the
     * source is refused, including the winner's own unchanged content,
     * until an operator resolves it with a genuinely later reviewDate.
     */
    it('fails closed for BOTH sides of a same-date conflict, not just the losing caller — until a later reviewDate resolves it', async () => {
      const { sourceId } = await addOpportunityWithListing({
        listingStatus: 'active',
        opportunityStatus: 'active',
      });
      const sameDay = '2026-09-05T00:00:00Z';

      // An older baseline, so the "winner" below is a genuine (unambiguous)
      // acceptance, not itself a tie.
      await setSourcePolicy(sourceId, false, '2026-01-01T00:00:00Z');

      // Deployment A "wins the race": its sync reaches the database first,
      // is strictly newer than the baseline, and is accepted as current.
      const winnerPolicy = buildPolicy(sourceId, true, sameDay);
      expect((await syncSourcePolicy(db, winnerPolicy)).outcome).toBe('created');

      // Deployment B loses the race: same reviewDate, different content.
      // Refused, as the tie test above already proves — but this ALSO must
      // flag the conflict.
      const loserPolicy = buildPolicy(sourceId, false, sameDay);
      expect((await syncSourcePolicy(db, loserPolicy)).outcome).toBe('refused-stale');

      const [flagged] = await db.select().from(sources).where(eq(sources.id, sourceId));
      expect(flagged?.policyConflictAt).not.toBeNull();

      // The winner's OWN next routine re-sync of its UNCHANGED content —
      // before this fix, this returned 'no-op' silently, since it matches
      // whatever is current. It must now be refused too.
      expect((await syncSourcePolicy(db, winnerPolicy)).outcome).toBe('refused-stale');

      // Still flagged, current still points at the winner's revision —
      // refusing the winner's re-sync must not have touched either.
      const [stillFlagged] = await db.select().from(sources).where(eq(sources.id, sourceId));
      expect(stillFlagged?.policyConflictAt).not.toBeNull();
      const policyRowsBeforeResolution = await db
        .select()
        .from(sourcePolicies)
        .where(eq(sourcePolicies.sourceId, sourceId));
      expect(policyRowsBeforeResolution).toHaveLength(2); // baseline + winner only

      // An operator resolves the conflict the documented way: a genuinely
      // LATER reviewDate. Accepted, and the flag clears.
      const resolvingPolicy = buildPolicy(sourceId, false, '2026-09-06T00:00:00Z');
      expect((await syncSourcePolicy(db, resolvingPolicy)).outcome).toBe('created');

      const [resolved] = await db.select().from(sources).where(eq(sources.id, sourceId));
      expect(resolved?.policyConflictAt).toBeNull();

      const policyRowsAfterResolution = await db
        .select()
        .from(sourcePolicies)
        .where(eq(sourcePolicies.sourceId, sourceId));
      // History preserved throughout — nothing was ever overwritten or
      // deleted, including the losing/conflicting attempt's own content,
      // which never got a row at all since it was refused before insert.
      expect(policyRowsAfterResolution).toHaveLength(3);
    });
  });

  it('excludes a quarantined opportunity', async () => {
    const { opportunityId } = await addOpportunityWithListing({
      listingStatus: 'quarantined',
      opportunityStatus: 'quarantined',
    });

    const rows = await db
      .select()
      .from(publicOpportunities)
      .where(eq(publicOpportunities.id, opportunityId));
    expect(rows).toHaveLength(0);
  });

  it('excludes a quarantined listing from the members view even under an active opportunity', async () => {
    const { listingId } = await addOpportunityWithListing({
      listingStatus: 'quarantined',
      opportunityStatus: 'active',
    });

    const rows = await db
      .select()
      .from(publicOpportunityMembers)
      .where(eq(publicOpportunityMembers.sourceListingId, listingId));
    expect(rows).toHaveLength(0);
  });

  it('excludes a superseded (retired) membership', async () => {
    const { listingId } = await addOpportunityWithListing({
      listingStatus: 'active',
      opportunityStatus: 'active',
      superseded: true,
    });

    const rows = await db
      .select()
      .from(publicOpportunityMembers)
      .where(eq(publicOpportunityMembers.sourceListingId, listingId));
    expect(rows).toHaveLength(0);
  });

  /**
   * `public_source_listings` (Stage 4 round 3): unlike `public_opportunity_members`
   * above, this one has no join to `opportunities`/`opportunity_source_memberships`
   * at all, precisely so a listing dedupe hasn't clustered yet is still visible
   * to the public `/listings` screen (Codex, 2026-09-24) — `getSourceHealth`'s
   * own `unlinkedRows` already tracks this as a normal, expected gap, not a
   * rare edge case.
   */
  it('public_source_listings includes a listing with no opportunity membership at all', async () => {
    const { listingId, title } = await addBareListing({ status: 'active' });

    // Absent from the membership-based view — proving this really is an
    // UNCLUSTERED listing, not a fixture bug.
    const memberRows = await db
      .select()
      .from(publicOpportunityMembers)
      .where(eq(publicOpportunityMembers.sourceListingId, listingId));
    expect(memberRows).toHaveLength(0);

    const [row] = await db
      .select()
      .from(publicSourceListings)
      .where(eq(publicSourceListings.sourceListingId, listingId));
    expect(row?.title).toBe(title);
    expect(row?.status).toBe('active');
  });

  it('public_source_listings excludes a quarantined listing', async () => {
    const { listingId } = await addBareListing({ status: 'quarantined' });

    const rows = await db
      .select()
      .from(publicSourceListings)
      .where(eq(publicSourceListings.sourceListingId, listingId));
    expect(rows).toHaveLength(0);
  });
});
