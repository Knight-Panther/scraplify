import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  opportunities,
  opportunityRevisions,
  opportunitySourceMemberships,
  sourceListingRevisions,
  sourceListings,
  sources,
} from '../db/schema/index.js';
import {
  cleanupTestSource,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../db/test-support.js';
import {
  publicCountListings,
  publicCountOpportunities,
  publicGetOpportunity,
  publicLastSeen,
  publicSearchListings,
  publicSearchOpportunities,
  publicSourceOverview,
} from './public-queries.js';

/**
 * Real-database tests for the public query boundary (Phase 8B Stage 4).
 * `public-views.test.ts` already proves the underlying SQL views exclude
 * dedupe internals and quarantined/superseded rows at the column/row level —
 * this file proves the QUERY LOGIC built on top of them (filters, sorting,
 * the mayRepublishFullContent policy, the changedOnly refusal) is correct.
 */
describe('public queries', () => {
  const sourceIds: string[] = [];
  const listingIds: string[] = [];
  const opportunityIds: string[] = [];

  async function addOpportunity(spec: {
    title: string;
    status?: 'active' | 'missing_suspected' | 'closed' | 'expired' | 'quarantined';
    deadlineAt?: string | null;
    firstSeenAt?: string;
    sourceSlug?: string;
    /** Reuse an already-created source (e.g. to put two listings on one board) rather than creating a new one. */
    existingSourceId?: string;
    description?: string;
    /** Attach this member to an already-created opportunity instead of a new one — for a cross-posted cluster with one hidden (quarantined) and one visible member. */
    opportunityId?: string;
    /** Force `source_listings.id` rather than a random uuid — for tests where the sort tie-break matters. */
    listingId?: string;
  }): Promise<{ opportunityId: string; listingId: string; sourceId: string }> {
    let sourceId = spec.existingSourceId;
    if (sourceId === undefined) {
      sourceId = await createTestSource();
      sourceIds.push(sourceId);
      if (spec.sourceSlug !== undefined) {
        // A fixed, known slug for filter tests — createTestSource always
        // generates a random one, so this overwrites it directly.
        await db.update(sources).set({ slug: spec.sourceSlug }).where(eq(sources.id, sourceId));
      }
    }
    const listing = await createTestSourceListing(sourceId, {
      ...(spec.listingId !== undefined ? { id: spec.listingId } : {}),
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
      organizationRaw: 'Public Query Test Org',
      description: spec.description ?? 'a public-safe description',
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

    let opportunityId = spec.opportunityId;
    if (opportunityId === undefined) {
      opportunityId = randomUUID();
      opportunityIds.push(opportunityId);
      await db.insert(opportunities).values({
        id: opportunityId,
        type: 'job',
        canonicalTitle: spec.title,
        organizationId: null,
        canonicalStatus: spec.status === 'quarantined' ? 'quarantined' : 'active',
        currentCanonicalRevisionId: null,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      });
    }
    await db.insert(opportunitySourceMemberships).values({
      id: randomUUID(),
      opportunityId,
      sourceListingId: listing.id,
      decision: 'confirmed_same',
      confidence: 1,
      evidence: {},
      decidedBy: 'ruleset',
      decidedAt: '2026-09-01T00:00:00Z',
      dedupeModelOrRulesetVersion: 'v1',
      supersededAt: null,
    });

    return { opportunityId, listingId: listing.id, sourceId };
  }

  /** A source listing with no opportunity/membership at all — the shape a fresh crawl writes before dedupe has clustered it. */
  async function addBareListing(spec: {
    title: string;
    status?: 'active' | 'quarantined';
  }): Promise<{ listingId: string; sourceId: string }> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const listing = await createTestSourceListing(sourceId, {
      status: spec.status ?? 'active',
      sourceDeadlineAt: '2026-12-01T00:00:00Z',
      firstSeenAt: '2026-09-01T00:00:00Z',
      lastSeenAt: '2026-09-01T00:00:00Z',
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
      organizationRaw: 'Public Query Test Org',
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
    return { listingId: listing.id, sourceId };
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

  it('finds an active opportunity by text and excludes a quarantined one', async () => {
    const title = `Public search test ${randomUUID().slice(0, 8)}`;
    const { opportunityId } = await addOpportunity({ title, status: 'active' });
    const quarantinedTitle = `Public search quarantined ${randomUUID().slice(0, 8)}`;
    await addOpportunity({ title: quarantinedTitle, status: 'quarantined' });

    const rows = await publicSearchOpportunities(db, { text: 'Public search' });
    const ids = rows.map((r) => r.opportunityId);
    expect(ids).toContain(opportunityId);
    // Not merely absent from the text match — genuinely excluded, since its
    // only live member is quarantined and public_opportunity_members drops it.
    const quarantined = rows.find((r) => r.canonicalTitle === quarantinedTitle);
    expect(quarantined).toBeUndefined();

    const total = await publicCountOpportunities(db, { text: 'Public search' });
    expect(total).toBe(1);
  });

  it('derives the public canonical title from a visible member, never a hidden quarantined one', async () => {
    const opportunityId = randomUUID();
    opportunityIds.push(opportunityId);
    const quarantinedTitle = `Contaminated title ${randomUUID().slice(0, 8)}`;
    const visibleTitle = `Real visible title ${randomUUID().slice(0, 8)}`;

    // Simulates what `resolveCanonicalOpportunity`'s own "first member by id"
    // tie-break can produce today: the STORED canonical title came from the
    // quarantined member, because resolution runs over EVERY live member of
    // the cluster, not just the ones a public visitor can see.
    await db.insert(opportunities).values({
      id: opportunityId,
      type: 'job',
      canonicalTitle: quarantinedTitle,
      organizationId: null,
      canonicalStatus: 'active',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    });
    await addOpportunity({ title: quarantinedTitle, status: 'quarantined', opportunityId });
    await addOpportunity({ title: visibleTitle, status: 'active', opportunityId });

    const byHiddenText = await publicSearchOpportunities(db, { text: 'Contaminated title' });
    expect(byHiddenText.find((r) => r.opportunityId === opportunityId)).toBeUndefined();

    const byVisibleText = await publicSearchOpportunities(db, { text: 'Real visible title' });
    const match = byVisibleText.find((r) => r.opportunityId === opportunityId);
    expect(match?.canonicalTitle).toBe(visibleTitle);

    const detail = await publicGetOpportunity(db, opportunityId);
    expect(detail?.canonicalTitle).toBe(visibleTitle);
    expect(detail?.members).toHaveLength(1);
    expect(detail?.members[0]?.title).toBe(visibleTitle);
  });

  it('publicGetOpportunity rejects a detail record with no public-visible member', async () => {
    const opportunityId = randomUUID();
    opportunityIds.push(opportunityId);
    await db.insert(opportunities).values({
      id: opportunityId,
      type: 'job',
      canonicalTitle: 'Emptied cluster',
      organizationId: null,
      // What `resolveCanonicalOpportunity`'s own "members.length === 0"
      // branch sets — the row survives because nothing supports 'quarantined'
      // either, so `public_opportunities` alone cannot tell this apart from
      // an ordinary row.
      canonicalStatus: 'closed',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    });
    // No live memberships at all — every membership was detached.

    expect(await publicGetOpportunity(db, opportunityId)).toBeNull();
  });

  it('excludes closed/expired opportunities from the default public catalogue with no filters', async () => {
    const suffix = randomUUID().slice(0, 8);
    const openTitle = `Public eligible open ${suffix}`;
    const closedTitle = `Public eligible closed ${suffix}`;
    const expiredTitle = `Public eligible expired ${suffix}`;
    await addOpportunity({
      title: openTitle,
      status: 'active',
      deadlineAt: '2027-01-01T00:00:00Z',
    });
    await addOpportunity({ title: closedTitle, status: 'closed' });
    await addOpportunity({
      title: expiredTitle,
      status: 'active',
      deadlineAt: '2020-01-01T00:00:00Z',
    });

    // No `genuinelyOpenAsOf` passed — the shared eligibility policy must
    // apply automatically, not only when a caller opts in (Codex, 2026-09-24).
    // `text: suffix` alone, not the shared "Public eligible" prefix: each
    // title has a different word between "eligible" and the suffix, so only
    // the suffix itself is guaranteed to substring-match all three.
    const rows = await publicSearchOpportunities(db, { text: suffix });
    expect(rows.map((r) => r.canonicalTitle)).toEqual([openTitle]);

    const total = await publicCountOpportunities(db, { text: suffix });
    expect(total).toBe(1);
  });

  it('publicGetOpportunity refuses a direct link to an opportunity with no eligible member', async () => {
    const title = `Public detail ineligible ${randomUUID().slice(0, 8)}`;
    // Active status, but its own deadline has already passed — non-quarantined
    // (so public_opportunity_members still carries it), just not eligible.
    const { opportunityId } = await addOpportunity({
      title,
      status: 'active',
      deadlineAt: '2020-01-01T00:00:00Z',
    });

    // Enforced here too, not just in Browse — a bookmarked/direct URL must not
    // bypass the same eligibility policy `publicSearchOpportunities` applies
    // by default (Codex, 2026-09-24).
    expect(await publicGetOpportunity(db, opportunityId)).toBeNull();
    // A fixed `asOf` before the deadline proves it's genuinely the deadline
    // gate, not some other refusal path (e.g. the member-count check).
    const detail = await publicGetOpportunity(db, opportunityId, '2019-01-01T00:00:00Z');
    expect(detail?.canonicalTitle).toBe(title);
  });

  it('derives the public canonical status from current members, not the possibly-stale stored column', async () => {
    const opportunityId = randomUUID();
    opportunityIds.push(opportunityId);
    const title = `Public status reopened ${randomUUID().slice(0, 8)}`;

    // Simulates a crawl reopening a member before resolveCanonicalOpportunity
    // has re-run: the stored column still says 'closed', but a live, eligible
    // active member already exists.
    await db.insert(opportunities).values({
      id: opportunityId,
      type: 'job',
      canonicalTitle: title,
      organizationId: null,
      canonicalStatus: 'closed',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    });
    await addOpportunity({
      title,
      status: 'active',
      deadlineAt: '2027-01-01T00:00:00Z',
      opportunityId,
    });

    const rows = await publicSearchOpportunities(db, { text: title });
    const row = rows.find((r) => r.opportunityId === opportunityId);
    expect(row?.canonicalStatus).toBe('active');

    const detail = await publicGetOpportunity(db, opportunityId);
    expect(detail?.canonicalStatus).toBe('active');

    // The stale stored 'closed' must not leak through `?status=closed`
    // either, and the freshly-derived 'active' must actually match `?status=active`.
    const closedMatch = await publicSearchOpportunities(db, {
      text: title,
      statuses: ['closed'],
    });
    expect(closedMatch.find((r) => r.opportunityId === opportunityId)).toBeUndefined();
    const activeMatch = await publicSearchOpportunities(db, {
      text: title,
      statuses: ['active'],
    });
    expect(activeMatch.find((r) => r.opportunityId === opportunityId)).toBeDefined();
  });

  it('requires the SAME member to satisfy both eligibility and a deadline window', async () => {
    const opportunityId = randomUUID();
    opportunityIds.push(opportunityId);
    const title = `Public deadline mismatch ${randomUUID().slice(0, 8)}`;
    await db.insert(opportunities).values({
      id: opportunityId,
      type: 'job',
      canonicalTitle: title,
      organizationId: null,
      canonicalStatus: 'active',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    });
    // Eligible, but its deadline is far outside the "closing in 7 days" window.
    await addOpportunity({
      title,
      status: 'active',
      deadlineAt: '2027-06-01T00:00:00Z',
      opportunityId,
    });
    // Inside the window, but not eligible (already closed).
    await addOpportunity({
      title,
      status: 'closed',
      deadlineAt: '2026-09-28T00:00:00Z',
      opportunityId,
    });

    const rows = await publicSearchOpportunities(db, {
      text: title,
      genuinelyOpenAsOf: '2026-09-24T00:00:00Z',
      deadlineFrom: '2026-09-24T00:00:00Z',
      deadlineTo: '2026-10-01T00:00:00Z',
    });
    // Neither member satisfies BOTH conditions at once, so the opportunity
    // must not match — matching would mean "closing in 7 days" links to a
    // vacancy whose actual open path doesn't close then at all.
    expect(rows.find((r) => r.opportunityId === opportunityId)).toBeUndefined();
  });

  it('genuinely-open-as-of excludes a past deadline', async () => {
    const openTitle = `Public open test ${randomUUID().slice(0, 8)}`;
    const closedTitle = `Public closed test ${randomUUID().slice(0, 8)}`;
    await addOpportunity({ title: openTitle, deadlineAt: '2027-01-01T00:00:00Z' });
    await addOpportunity({ title: closedTitle, deadlineAt: '2020-01-01T00:00:00Z' });

    const rows = await publicSearchOpportunities(db, {
      text: 'Public',
      genuinelyOpenAsOf: '2026-09-24T00:00:00Z',
    });
    const titles = rows.map((r) => r.canonicalTitle);
    expect(titles).toContain(openTitle);
    expect(titles).not.toContain(closedTitle);
  });

  it('sorts by title', async () => {
    const suffix = randomUUID().slice(0, 8);
    await addOpportunity({ title: `Zeta ${suffix}` });
    await addOpportunity({ title: `Alpha ${suffix}` });

    const rows = await publicSearchOpportunities(db, { text: suffix, sort: 'title' });
    expect(rows.map((r) => r.canonicalTitle)).toEqual([`Alpha ${suffix}`, `Zeta ${suffix}`]);
  });

  it('publicSearchListings finds a listing and hides a quarantined one', async () => {
    const title = `Public listing test ${randomUUID().slice(0, 8)}`;
    const { listingId } = await addOpportunity({ title, status: 'active' });
    const quarantinedTitle = `Public listing quarantined ${randomUUID().slice(0, 8)}`;
    await addOpportunity({ title: quarantinedTitle, status: 'quarantined' });

    const rows = await publicSearchListings(db, { text: 'Public listing' });
    expect(rows.map((r) => r.sourceListingId)).toContain(listingId);
    expect(rows.find((r) => r.title === quarantinedTitle)).toBeUndefined();

    const total = await publicCountListings(db, { text: 'Public listing' });
    expect(total).toBe(1);
  });

  it('publicSearchListings/publicCountListings/publicSourceOverview include a listing with no opportunity membership at all', async () => {
    // The shape a fresh crawl writes before dedupe has clustered it —
    // public_opportunity_members (an inner join through
    // opportunity_source_memberships) would silently drop this entirely,
    // undercounting a normal, expected operational state (Codex, 2026-09-24;
    // see getSourceHealth's own unlinkedRows).
    const title = `Public unclustered listing ${randomUUID().slice(0, 8)}`;
    const slug = `public-unclustered-${randomUUID().slice(0, 8)}`;
    const { listingId, sourceId } = await addBareListing({ title, status: 'active' });
    await db.update(sources).set({ slug }).where(eq(sources.id, sourceId));

    const rows = await publicSearchListings(db, { text: title });
    expect(rows.map((r) => r.sourceListingId)).toContain(listingId);

    const total = await publicCountListings(db, { text: title });
    expect(total).toBe(1);

    const overview = await publicSourceOverview(db);
    const row = overview.find((r) => r.sourceSlug === slug);
    expect(row?.trackedCount).toBe(1);
  });

  it('publicSearchListings/publicCountListings return zero for changedOnly, never an unfiltered set', async () => {
    const title = `Public changed test ${randomUUID().slice(0, 8)}`;
    await addOpportunity({ title });

    const rows = await publicSearchListings(db, { text: 'Public changed', changedOnly: true });
    expect(rows).toHaveLength(0);
    const total = await publicCountListings(db, { text: 'Public changed', changedOnly: true });
    expect(total).toBe(0);
  });

  it('publicGetOpportunity omits the description for a source without republish clearance', async () => {
    const title = `Public detail test ${randomUUID().slice(0, 8)}`;
    const { opportunityId } = await addOpportunity({
      title,
      description: 'this must not reach a public visitor verbatim',
    });

    const view = await publicGetOpportunity(db, opportunityId);
    expect(view?.canonicalTitle).toBe(title);
    expect(view?.members).toHaveLength(1);
    // The test source is unregistered in src/policies/index.ts's sourcePolicies
    // map, which fails closed exactly like a real, known-false source
    // (jobs-ge/hr-ge both currently set mayRepublishFullContent: false) —
    // there is no registered source with it set true to exercise the
    // opposite branch against yet.
    expect(view?.members[0]?.description).toBe('');
  });

  it('publicGetOpportunity returns null for a missing id and a malformed one', async () => {
    expect(await publicGetOpportunity(db, randomUUID())).toBeNull();
    expect(await publicGetOpportunity(db, 'not-a-uuid')).toBeNull();
  });

  it('publicSourceOverview groups by source with the right count and lastSeenAt', async () => {
    const slug = `public-overview-${randomUUID().slice(0, 8)}`;
    const first = await addOpportunity({
      title: `Public overview test A ${randomUUID().slice(0, 8)}`,
      sourceSlug: slug,
      firstSeenAt: '2026-09-01T00:00:00Z',
    });
    await addOpportunity({
      title: `Public overview test B ${randomUUID().slice(0, 8)}`,
      existingSourceId: first.sourceId,
      firstSeenAt: '2026-09-10T00:00:00Z',
    });

    const overview = await publicSourceOverview(db);
    const row = overview.find((r) => r.sourceSlug === slug);
    expect(row?.trackedCount).toBe(2);
    // lastSeenAt is set equal to firstSeenAt by this test's own fixture, so
    // the later of the two rows should win.
    expect(row?.lastSeenAt).toBe('2026-09-10T00:00:00.000Z');
  });

  it('publicSearchOpportunities filters by sourceSlug', async () => {
    const suffix = randomUUID().slice(0, 8);
    const slugA = `public-source-a-${suffix}`;
    const slugB = `public-source-b-${suffix}`;
    await addOpportunity({ title: `On A ${suffix}`, sourceSlug: slugA });
    await addOpportunity({ title: `On B ${suffix}`, sourceSlug: slugB });

    const rows = await publicSearchOpportunities(db, { text: suffix, sourceSlug: slugA });
    expect(rows.map((r) => r.canonicalTitle)).toEqual([`On A ${suffix}`]);
  });

  it('publicLastSeen is the oldest of each source own latest, only when every source has one', () => {
    const fixed = [
      { sourceSlug: 'a', trackedCount: 3, lastSeenAt: '2026-09-01T00:00:00Z' },
      { sourceSlug: 'b', trackedCount: 1, lastSeenAt: '2026-09-05T00:00:00Z' },
    ];
    expect(publicLastSeen(fixed)).toBe('2026-09-01T00:00:00Z');
    expect(publicLastSeen([...fixed, { sourceSlug: 'c', trackedCount: 0, lastSeenAt: null }])).toBe(
      undefined,
    );
  });
});
