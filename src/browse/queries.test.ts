import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  duplicateCandidates,
  opportunities,
  opportunitySourceMemberships,
  sourceListingRevisions,
  sourceListings,
} from '../db/schema/index.js';
import {
  cleanupTestSource,
  createTestCrawlRun,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../db/test-support.js';
import {
  getSourceHealth,
  listReviewQueue,
  searchListings,
  searchOpportunities,
} from './queries.js';

/**
 * Assertions are scoped to this test's own rows throughout: these queries are
 * corpus-wide by design, and a shared dev database also holds real crawled
 * listings. Asserting on total counts would make the tests depend on whatever
 * a developer last crawled.
 */

describe('browse queries', () => {
  const sourceIds: string[] = [];
  const listingIds: string[] = [];
  const opportunityIds: string[] = [];

  async function addListing(
    sourceId: string,
    spec: {
      title: string;
      organization?: string | null;
      status?: 'active' | 'missing_suspected' | 'closed' | 'expired';
      deadlineAt?: string | null;
      firstSeenAt?: string;
    },
  ): Promise<string> {
    const listing = await createTestSourceListing(sourceId, {
      status: spec.status ?? 'active',
      sourceDeadlineAt: spec.deadlineAt ?? '2026-12-01T00:00:00Z',
      firstSeenAt: spec.firstSeenAt ?? '2026-09-01T00:00:00Z',
      lastSeenAt: spec.firstSeenAt ?? '2026-09-01T00:00:00Z',
    });
    const resourceId = await createTestResource(sourceId);
    const revisionId = randomUUID();
    await db.insert(sourceListingRevisions).values({
      id: revisionId,
      sourceListingId: listing.id,
      parserVersion: 'test-v1',
      extractionMethod: 'http',
      rawResourceHash: 'a'.repeat(64),
      meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      titleRaw: spec.title,
      titleNormalized: spec.title.toLowerCase(),
      organizationRaw: spec.organization ?? 'Browse Test Org',
      description: 'description',
      locations: [],
      publishedDate: { raw: '', parsed: '2026-09-01T00:00:00Z' },
      deadlineDate: { raw: '', parsed: spec.deadlineAt ?? '2026-12-01T00:00:00Z' },
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
    return listing.id;
  }

  afterEach(async () => {
    if (listingIds.length > 0) {
      await db
        .delete(opportunitySourceMemberships)
        .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
      await db
        .delete(duplicateCandidates)
        .where(inArray(duplicateCandidates.sourceListingIdA, listingIds));
      listingIds.length = 0;
    }
    if (opportunityIds.length > 0) {
      await db.delete(opportunities).where(inArray(opportunities.id, opportunityIds));
      opportunityIds.length = 0;
    }
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  it('finds a listing by title and by organization substring', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const marker = randomUUID().slice(0, 8);
    const listingId = await addListing(sourceId, {
      title: `Zorbulon Engineer ${marker}`,
      organization: `Zorbulon Ltd ${marker}`,
    });

    const byTitle = await searchListings(db, { text: `Zorbulon Engineer ${marker}` });
    expect(byTitle.map((row) => row.sourceListingId)).toContain(listingId);

    const byOrganization = await searchListings(db, { text: `Zorbulon Ltd ${marker}` });
    expect(byOrganization.map((row) => row.sourceListingId)).toContain(listingId);
  });

  it('filters by status and by source', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const active = await addListing(sourceId, { title: 'Active role', status: 'active' });
    const closed = await addListing(sourceId, { title: 'Closed role', status: 'closed' });

    const closedOnly = await searchListings(db, { statuses: ['closed'], limit: 500 });
    const ids = closedOnly.map((row) => row.sourceListingId);
    expect(ids).toContain(closed);
    expect(ids).not.toContain(active);
  });

  it('supports the "closing soon" view via a deadline upper bound', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const soon = await addListing(sourceId, {
      title: 'Closing soon',
      deadlineAt: '2026-09-10T00:00:00Z',
    });
    const later = await addListing(sourceId, {
      title: 'Closing later',
      deadlineAt: '2026-11-30T00:00:00Z',
    });

    const rows = await searchListings(db, { deadlineTo: '2026-09-15T00:00:00Z', limit: 500 });
    const ids = rows.map((row) => row.sourceListingId);
    expect(ids).toContain(soon);
    expect(ids).not.toContain(later);
  });

  it('supports the "new listings" view via a first-seen lower bound', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const fresh = await addListing(sourceId, {
      title: 'Fresh',
      firstSeenAt: '2026-09-06T00:00:00Z',
    });
    const old = await addListing(sourceId, { title: 'Old', firstSeenAt: '2026-01-01T00:00:00Z' });

    const rows = await searchListings(db, { firstSeenFrom: '2026-09-05T00:00:00Z', limit: 500 });
    const ids = rows.map((row) => row.sourceListingId);
    expect(ids).toContain(fresh);
    expect(ids).not.toContain(old);
  });

  it('clamps an absurd limit instead of returning the whole corpus', async () => {
    const rows = await searchListings(db, { limit: 100_000 });
    expect(rows.length).toBeLessThanOrEqual(500);
  });

  it('shows a canonical opportunity with its clustered source listings', async () => {
    const sourceA = await createTestSource();
    const sourceB = await createTestSource();
    sourceIds.push(sourceA, sourceB);
    const title = `Clustered role ${randomUUID().slice(0, 8)}`;
    const listingA = await addListing(sourceA, { title });
    const listingB = await addListing(sourceB, { title });

    const opportunityId = randomUUID();
    opportunityIds.push(opportunityId);
    await db.insert(opportunities).values({
      id: opportunityId,
      type: 'job',
      canonicalTitle: title,
      organizationId: null,
      canonicalStatus: 'active',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-06T12:00:00Z',
      updatedAt: '2026-09-06T12:00:00Z',
    });
    for (const listingId of [listingA, listingB]) {
      await db.insert(opportunitySourceMemberships).values({
        id: randomUUID(),
        opportunityId,
        sourceListingId: listingId,
        decision: 'confirmed_same',
        confidence: 0.97,
        evidence: {},
        decidedBy: 'ruleset',
        decidedAt: '2026-09-06T12:00:00Z',
        dedupeModelOrRulesetVersion: 'v1',
        supersededAt: null,
      });
    }

    const [view] = await searchOpportunities(db, { text: title });
    expect(view?.opportunityId).toBe(opportunityId);
    expect(view?.members).toHaveLength(2);
    expect(view?.members.map((m) => m.sourceListingId).sort()).toEqual([listingA, listingB].sort());
  });

  it('drops a retired membership from the opportunity view but keeps the row', async () => {
    // The browse view must reflect a review correction immediately, while the
    // audit trail behind it survives (§12.5).
    const sourceA = await createTestSource();
    const sourceB = await createTestSource();
    sourceIds.push(sourceA, sourceB);
    const title = `Retired member ${randomUUID().slice(0, 8)}`;
    const listingA = await addListing(sourceA, { title });
    const listingB = await addListing(sourceB, { title });

    const opportunityId = randomUUID();
    opportunityIds.push(opportunityId);
    await db.insert(opportunities).values({
      id: opportunityId,
      type: 'job',
      canonicalTitle: title,
      organizationId: null,
      canonicalStatus: 'active',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-06T12:00:00Z',
      updatedAt: '2026-09-06T12:00:00Z',
    });
    await db.insert(opportunitySourceMemberships).values([
      {
        id: randomUUID(),
        opportunityId,
        sourceListingId: listingA,
        decision: 'confirmed_same',
        confidence: 0.97,
        evidence: {},
        decidedBy: 'ruleset',
        decidedAt: '2026-09-06T12:00:00Z',
        dedupeModelOrRulesetVersion: 'v1',
        supersededAt: null,
      },
      {
        id: randomUUID(),
        opportunityId,
        sourceListingId: listingB,
        decision: 'confirmed_same',
        confidence: 0.97,
        evidence: {},
        decidedBy: 'ruleset',
        decidedAt: '2026-09-06T12:00:00Z',
        dedupeModelOrRulesetVersion: 'v1',
        // Retired by a review correction.
        supersededAt: '2026-09-06T13:00:00Z',
      },
    ]);

    const [view] = await searchOpportunities(db, { text: title });
    expect(view?.members).toHaveLength(1);
    expect(view?.members[0]?.sourceListingId).toBe(listingA);

    const allRows = await db
      .select()
      .from(opportunitySourceMemberships)
      .where(eq(opportunitySourceMemberships.opportunityId, opportunityId));
    expect(allRows).toHaveLength(2);
  });

  it('renders both sides of a review-queue pair', async () => {
    const sourceA = await createTestSource();
    const sourceB = await createTestSource();
    sourceIds.push(sourceA, sourceB);
    const listingA = await addListing(sourceA, { title: 'Review side A' });
    const listingB = await addListing(sourceB, { title: 'Review side B' });
    const [a, b] = [listingA, listingB].sort() as [string, string];

    const candidateId = randomUUID();
    await db.insert(duplicateCandidates).values({
      id: candidateId,
      sourceListingIdA: a,
      sourceListingIdB: b,
      generatedAt: '2026-09-06T12:00:00Z',
      generationMethod: 'deterministic_match',
      similarityScore: 0.9,
      status: 'evaluated',
      resultingDecision: 'needs_review',
    });

    const queue = await listReviewQueue(db, { limit: 500 });
    const entry = queue.find((row) => row.candidateId === candidateId);
    expect(entry).toBeDefined();
    // Both sides fully rendered, so a reviewer needs no second lookup.
    expect(entry?.a.title).toBeTruthy();
    expect(entry?.b.title).toBeTruthy();
    expect(entry?.a.sourceListingId).not.toBe(entry?.b.sourceListingId);
  });

  it('reports source health, separating last run from last FULL-coverage run', async () => {
    // The distinction that matters operationally: a source polled constantly
    // by bounded runs can still be far past its last full-coverage run, and in
    // that state absence reconciliation is silently not happening (§10.2).
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    await addListing(sourceId, { title: 'Health listing', status: 'active' });
    await createTestCrawlRun(sourceId, {
      status: 'completed',
      fullCoverage: false,
      startedAt: '2026-09-06T10:00:00Z',
      reconciledAt: '2026-09-06T10:30:00Z',
    });

    const health = await getSourceHealth(db);
    // Matched by this test's OWN source, not by prefix: other test files create
    // 'test-source-*' sources in parallel, and a prefix match found one of theirs.
    const row = health.find((entry) => entry.sourceSlug === `test-source-${sourceId}`);
    expect(row).toBeDefined();
    expect(row?.listingsByStatus.active).toBe(1);
    expect(row?.lastRunAt).not.toBeNull();
    // Only a bounded run exists, so full coverage has never happened.
    expect(row?.lastFullCoverageRunAt).toBeNull();
  });
});
