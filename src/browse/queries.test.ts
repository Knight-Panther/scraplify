import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  duplicateCandidates,
  opportunities,
  opportunityRevisions,
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
  getOpportunity,
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
      // Only the detail query reads these; the list query never has.
      description?: string;
      structuredAttributes?: Record<string, unknown>;
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
      description: spec.description ?? 'description',
      locations: [],
      publishedDate: { raw: '', parsed: '2026-09-01T00:00:00Z' },
      deadlineDate: { raw: '', parsed: spec.deadlineAt ?? '2026-12-01T00:00:00Z' },
      applicationMethod: { type: 'email', value: 'apply@example.invalid' },
      sourceCategories: [],
      structuredAttributes: spec.structuredAttributes ?? {},
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

  /**
   * Every step runs even after one fails, and the test still fails if any did.
   *
   * Both halves are load-bearing, and each fixes a different way this has
   * already gone wrong. The original version stopped at the first failure, so
   * a delete that threw on an FK ordering never reached `cleanupTestSource`
   * and stranded two test sources and two opportunities in the shared dev
   * database — where they rendered on the source-health screen as real
   * sources named "Test source". Simply catching and continuing fixes that
   * and introduces a worse one: cleanup fails silently, the suite stays
   * green, and the next contamination is discovered by someone looking at a
   * screen rather than by the tests. So failures are collected and rethrown
   * once every step has had its turn.
   */
  const cleanupFailures: unknown[] = [];

  async function attempt(step: () => Promise<unknown>): Promise<unknown> {
    return step().catch((error: unknown) => {
      cleanupFailures.push(error);
    });
  }

  afterEach(async () => {
    if (listingIds.length > 0) {
      await attempt(() =>
        db
          .delete(opportunitySourceMemberships)
          .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds)),
      );
      await attempt(() =>
        db
          .delete(duplicateCandidates)
          .where(inArray(duplicateCandidates.sourceListingIdA, listingIds)),
      );
      listingIds.length = 0;
    }
    if (opportunityIds.length > 0) {
      // The pointer is dropped before the revisions it points at: the
      // composite ownership FK runs both ways, so deleting a revision an
      // opportunity still names is refused, and so is deleting the
      // opportunity while any revision references it.
      await attempt(() =>
        db
          .update(opportunities)
          .set({ currentCanonicalRevisionId: null })
          .where(inArray(opportunities.id, opportunityIds)),
      );
      await attempt(() =>
        db
          .delete(opportunityRevisions)
          .where(inArray(opportunityRevisions.opportunityId, opportunityIds)),
      );
      await attempt(() =>
        db.delete(opportunities).where(inArray(opportunities.id, opportunityIds)),
      );
      opportunityIds.length = 0;
    }
    for (const sourceId of sourceIds.splice(0)) await attempt(() => cleanupTestSource(sourceId));

    if (cleanupFailures.length > 0) {
      const failures = cleanupFailures.splice(0);
      throw new AggregateError(
        failures,
        `${failures.length} cleanup step(s) failed; rows may be stranded in the dev database`,
      );
    }
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

    const rows = await searchListings(db, {
      sourceSlug: `test-source-${sourceId}`,
      deadlineTo: '2026-09-15T00:00:00Z',
      limit: 500,
    });
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

    const rows = await searchListings(db, {
      sourceSlug: `test-source-${sourceId}`,
      firstSeenFrom: '2026-09-05T00:00:00Z',
      limit: 500,
    });
    const ids = rows.map((row) => row.sourceListingId);
    expect(ids).toContain(fresh);
    expect(ids).not.toContain(old);
  });

  /**
   * The "changed" view, and the reason it is defined by revision count.
   *
   * A revision is written only when the MEANINGFUL content hash changes — ads,
   * timestamps and tracking markup vary on every fetch and deliberately do not
   * produce one — so a second revision is by construction a real change to the
   * vacancy rather than noise.
   *
   * Worth recording: every one of the 412 listings in the corpus currently has
   * exactly one revision, so this view is honestly empty until a re-crawl
   * finds a difference. That is a fact about elapsed crawl time, not about the
   * filter, which is why it is tested with rows this test creates itself.
   */
  it('finds only listings whose content has been revised', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const marker = randomUUID().slice(0, 8);
    const unchanged = await addListing(sourceId, { title: `Unchanged ${marker}` });
    const changed = await addListing(sourceId, { title: `Changed ${marker}` });

    // A second revision, exactly as a re-crawl producing different meaningful
    // content would write one. The listing keeps pointing at the newer.
    const resourceId = await createTestResource(sourceId);
    const secondRevisionId = randomUUID();
    await db.insert(sourceListingRevisions).values({
      id: secondRevisionId,
      sourceListingId: changed,
      parserVersion: 'test-v2',
      extractionMethod: 'http',
      rawResourceHash: 'f'.repeat(64),
      meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      titleRaw: `Changed ${marker}`,
      titleNormalized: `changed ${marker}`,
      organizationRaw: 'Browse Test Org',
      description: 'the description the board changed',
      locations: [],
      publishedDate: { raw: '', parsed: '2026-09-01T00:00:00Z' },
      deadlineDate: { raw: '', parsed: '2026-12-01T00:00:00Z' },
      applicationMethod: { type: 'email', value: 'apply@example.invalid' },
      sourceCategories: [],
      structuredAttributes: {},
      createdAt: '2026-09-08T00:00:00Z',
      provenanceResourceId: resourceId,
      provenanceFetchedAt: '2026-09-08T00:00:00Z',
      provenanceNotes: null,
    });
    await db
      .update(sourceListings)
      .set({ currentRevisionId: secondRevisionId })
      .where(eq(sourceListings.id, changed));

    const rows = await searchListings(db, {
      sourceSlug: `test-source-${sourceId}`,
      changedOnly: true,
      limit: 500,
    });
    const ids = rows.map((row) => row.sourceListingId);
    expect(ids).toContain(changed);
    expect(ids).not.toContain(unchanged);

    // And the filter composes rather than replacing the others.
    const scoped = await searchListings(db, {
      sourceSlug: `test-source-${sourceId}`,
      changedOnly: true,
      text: `Unchanged ${marker}`,
      limit: 500,
    });
    expect(scoped).toHaveLength(0);
  });

  /**
   * Pages a fully tied result set and checks nothing is duplicated or lost.
   *
   * **Mutation-checked on 2026-09-08, and it does NOT discriminate**: removing
   * the `sourceListings.id` tie-breaker leaves this green. Postgres returns a
   * small heap scan in a stable order, so the nondeterminism the tie-breaker
   * exists for cannot be provoked at this size — it depends on plan choice and
   * physical row order, neither of which a test controls.
   *
   * The tie-breaker stays because the guarantee is structural rather than
   * observed: an ORDER BY that is not total permits the database to return
   * tied rows in any order, and LIMIT/OFFSET over that duplicates some rows
   * onto the next batch and drops others. Not a live defect today — 411 of the
   * 412 first-seen values are distinct, because listings are inserted one at a
   * time — but it stops being latent the first time a crawl stamps one run
   * timestamp across a batch, and the listings screen pages this query.
   *
   * Kept rather than deleted: the paging check is still worth having, and a
   * test that quietly proves less than its name claims is worse than one that
   * says so out loud.
   */
  it('pages a tied result set without duplicating or dropping a row', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const sharedInstant = '2026-09-05T12:00:00Z';
    const created: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      created.push(
        await addListing(sourceId, { title: `Tied ${index}`, firstSeenAt: sharedInstant }),
      );
    }

    const first = await searchListings(db, { limit: 3, offset: 0 });
    const second = await searchListings(db, { limit: 3, offset: 3 });
    const paged = [...first, ...second].map((row) => row.sourceListingId);

    // No listing appears on both pages, which is what a missing tie-breaker
    // silently breaks.
    expect(new Set(paged).size).toBe(paged.length);
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

  /** A real singleton opportunity, matching what every listing gets on ingestion (§12.5). */
  async function makeSingletonOpportunity(listingId: string, title: string): Promise<string> {
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
    await db.insert(opportunitySourceMemberships).values({
      id: randomUUID(),
      opportunityId,
      sourceListingId: listingId,
      decision: 'confirmed_same',
      confidence: 1,
      evidence: {},
      decidedBy: 'ruleset',
      decidedAt: '2026-09-06T12:00:00Z',
      dedupeModelOrRulesetVersion: 'v1',
      supersededAt: null,
    });
    return opportunityId;
  }

  it('renders both sides of a review-queue pair', async () => {
    const sourceA = await createTestSource();
    const sourceB = await createTestSource();
    sourceIds.push(sourceA, sourceB);
    const listingA = await addListing(sourceA, { title: 'Review side A' });
    const listingB = await addListing(sourceB, { title: 'Review side B' });
    // Every listing has its own singleton opportunity from ingestion — the
    // ordinary shape for a fresh pending pair, matching real corpus data
    // rather than the unrealistic "no opportunity at all" this fixture had
    // before (commit gate, 2026-09-14: that gap let a wrong cluster-size
    // fallback pass this very test).
    await makeSingletonOpportunity(listingA, 'Review side A');
    await makeSingletonOpportunity(listingB, 'Review side B');
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
    // Each is its own singleton opportunity — neither shares a cluster.
    expect(entry?.aClusterSize).toBe(1);
    expect(entry?.bClusterSize).toBe(1);
  });

  /**
   * The case the previous test's fixture accidentally exercised without
   * meaning to, and which had a real bug behind it: a listing with NO live
   * membership at all — exactly what `undoAcceptedMerge` leaves behind —
   * must report 0, not 1. Reporting 1 claims a singleton opportunity that
   * does not exist, and a caller comparing sizes to pick a merge survivor
   * (`pickSurvivor`) would then treat it as equal to a genuine singleton
   * rather than strictly worse than one.
   */
  it('reports zero cluster size for a listing with no live membership at all', async () => {
    const sourceA = await createTestSource();
    const sourceB = await createTestSource();
    sourceIds.push(sourceA, sourceB);
    const unclustered = await addListing(sourceA, { title: 'Just detached' });
    const clustered = await addListing(sourceB, { title: 'Has a singleton' });
    await makeSingletonOpportunity(clustered, 'Has a singleton');
    const [a, b] = [unclustered, clustered].sort() as [string, string];

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
    const unclusteredSize =
      entry?.a.sourceListingId === unclustered ? entry.aClusterSize : entry?.bClusterSize;
    const clusteredSize =
      entry?.a.sourceListingId === clustered ? entry.aClusterSize : entry?.bClusterSize;
    expect(unclusteredSize).toBe(0);
    expect(clusteredSize).toBe(1);
  });

  /**
   * `aClusterSize`/`bClusterSize` — added so a caller deciding which side of
   * a pair should survive an accept can prefer an already-established
   * cluster over a naive tie-breaker. A pair where one side already anchors
   * a two-member cluster (real fan-out, not contrived: a listing accepted
   * into one pending pair while a SIBLING candidate for the same listing is
   * still awaiting review) must report that size accurately, or a caller has
   * no way to tell the safe merge direction from the unsafe one.
   */
  it("reports each side's CURRENT cluster size, not just whether it has one", async () => {
    const sourceA = await createTestSource();
    const sourceB = await createTestSource();
    const sourceC = await createTestSource();
    sourceIds.push(sourceA, sourceB, sourceC);
    const clustered = await addListing(sourceA, { title: 'Already merged' });
    const alsoInCluster = await addListing(sourceB, { title: 'Merged with it' });
    const singleton = await addListing(sourceC, { title: 'Still on its own' });
    // A REAL singleton, not merely "no membership at all" — the ordinary,
    // common case this contrast is meant to represent, distinct from the
    // "detached entirely" case the dedicated zero-size test above covers.
    await makeSingletonOpportunity(singleton, 'Still on its own');

    const opportunityId = randomUUID();
    opportunityIds.push(opportunityId);
    await db.insert(opportunities).values({
      id: opportunityId,
      type: 'job',
      canonicalTitle: 'Already merged',
      organizationId: null,
      canonicalStatus: 'active',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-06T12:00:00Z',
      updatedAt: '2026-09-06T12:00:00Z',
    });
    for (const listingId of [clustered, alsoInCluster]) {
      await db.insert(opportunitySourceMemberships).values({
        id: randomUUID(),
        opportunityId,
        sourceListingId: listingId,
        decision: 'confirmed_same',
        confidence: 0.97,
        evidence: {},
        decidedBy: 'human',
        decidedAt: '2026-09-06T12:00:00Z',
        dedupeModelOrRulesetVersion: 'v1',
        supersededAt: null,
      });
    }

    // A sibling candidate: the already-clustered listing, still pending
    // against a third, unclustered listing.
    const [a, b] = [clustered, singleton].sort() as [string, string];
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
    const clusteredSize =
      entry?.a.sourceListingId === clustered ? entry.aClusterSize : entry?.bClusterSize;
    const singletonSize =
      entry?.a.sourceListingId === singleton ? entry.aClusterSize : entry?.bClusterSize;
    expect(clusteredSize).toBe(2);
    expect(singletonSize).toBe(1);
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

  /**
   * The detail query. Its own tests rather than an extension of the list's,
   * because it answers a different question: not "which opportunities match"
   * but "everything about this one", including the fields the list has never
   * read — descriptions above all.
   */
  async function cluster(spec: {
    title: string;
    members: { sourceId: string; description?: string; status?: 'active' | 'missing_suspected' }[];
  }): Promise<string> {
    const opportunityId = randomUUID();
    opportunityIds.push(opportunityId);
    await db.insert(opportunities).values({
      id: opportunityId,
      type: 'job',
      canonicalTitle: spec.title,
      organizationId: null,
      canonicalStatus: 'active',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-06T12:00:00Z',
      updatedAt: '2026-09-06T12:00:00Z',
    });
    for (const member of spec.members) {
      const listingId = await addListing(member.sourceId, {
        title: spec.title,
        status: member.status ?? 'active',
        ...(member.description === undefined ? {} : { description: member.description }),
      });
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
    return opportunityId;
  }

  /**
   * The case that would otherwise be a 500 rather than a 404. This id reaches
   * the query straight from a URL path, and Postgres answers a malformed uuid
   * with `invalid input syntax for type uuid` — an error, not an empty result.
   */
  it('returns null for an id that is not a uuid, without erroring', async () => {
    await expect(getOpportunity(db, 'not-a-uuid')).resolves.toBeNull();
    await expect(getOpportunity(db, '')).resolves.toBeNull();
    await expect(getOpportunity(db, "'; select 1--")).resolves.toBeNull();
  });

  it('returns null for a well-formed id that matches nothing', async () => {
    await expect(getOpportunity(db, randomUUID())).resolves.toBeNull();
  });

  it('returns each member’s own description, unmerged', async () => {
    const sourceA = await createTestSource();
    const sourceB = await createTestSource();
    sourceIds.push(sourceA, sourceB);
    const title = `Detail cluster ${randomUUID().slice(0, 8)}`;
    const opportunityId = await cluster({
      title,
      members: [
        { sourceId: sourceA, description: 'რასაც პირველი დაფა ამბობს' },
        { sourceId: sourceB, description: 'რასაც მეორე დაფა ამბობს' },
      ],
    });

    const view = await getOpportunity(db, opportunityId);
    expect(view?.canonicalTitle).toBe(title);
    expect(view?.members).toHaveLength(2);
    // Both texts survive as separate values. A single concatenated string here
    // is the provenance loss the screen exists to prevent.
    expect(view?.members.map((member) => member.description).sort()).toEqual(
      ['რასაც პირველი დაფა ამბობს', 'რასაც მეორე დაფა ამბობს'].sort(),
    );
    for (const member of view?.members ?? []) {
      expect(member.canonicalUrl).toContain('https://');
      expect(member.decision).toBe('confirmed_same');
      expect(member.confidence).toBeCloseTo(0.97);
    }
  });

  it('follows only LIVE memberships, like every other opportunity query', async () => {
    const sourceA = await createTestSource();
    const sourceB = await createTestSource();
    sourceIds.push(sourceA, sourceB);
    const title = `Detail retired ${randomUUID().slice(0, 8)}`;
    const opportunityId = await cluster({
      title,
      members: [{ sourceId: sourceA }, { sourceId: sourceB }],
    });

    const before = await getOpportunity(db, opportunityId);
    const retired = before?.members[0]?.sourceListingId;
    expect(retired).toBeDefined();
    await db
      .update(opportunitySourceMemberships)
      .set({ supersededAt: '2026-09-07T00:00:00Z' })
      .where(eq(opportunitySourceMemberships.sourceListingId, retired as string));

    const after = await getOpportunity(db, opportunityId);
    expect(after?.members).toHaveLength(1);
    expect(after?.members.map((member) => member.sourceListingId)).not.toContain(retired);
    // Dropped from the cluster, kept as history: this query is the one place
    // a detached listing must still be reachable, since the screen it feeds
    // is what explains why it left.
    expect(after?.formerMembers.map((member) => member.sourceListingId)).toEqual([retired]);
    expect(after?.formerMembers[0]?.supersededAt).not.toBeNull();
  });

  /**
   * §12.4 requires a stale canonical view to be distinguishable from a current
   * one. `resolveCanonicalOpportunity` runs during a dedupe pass, not after
   * every crawl, so a listing can gain a revision while the canonical title
   * still describes the previous one — and the screen would present that as
   * current with nothing to indicate it. `sourceMembershipVersions` was being
   * stored for exactly this comparison and never read.
   */
  it('reports the canonical fields as stale when a member has moved past them', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const title = `Detail staleness ${randomUUID().slice(0, 8)}`;
    const opportunityId = await cluster({ title, members: [{ sourceId }] });

    const [membership] = await db
      .select({ listingId: opportunitySourceMemberships.sourceListingId })
      .from(opportunitySourceMemberships)
      .where(eq(opportunitySourceMemberships.opportunityId, opportunityId));
    const listingId = membership?.listingId as string;
    const [current] = await db
      .select({ revisionId: sourceListings.currentRevisionId })
      .from(sourceListings)
      .where(eq(sourceListings.id, listingId));

    // Resolved from exactly the revision the member is at: not stale.
    const revisionId = randomUUID();
    await db.insert(opportunityRevisions).values({
      id: revisionId,
      opportunityId,
      canonicalTitle: title,
      canonicalStatus: 'active',
      organizationId: null,
      resolvedFields: {},
      sourceMembershipVersions: { [listingId]: current?.revisionId },
      resolutionRulesetVersion: 'v1',
      meaningfulContentHash: 'd'.repeat(64),
      createdAt: '2026-09-06T12:30:00Z',
    });
    await db
      .update(opportunities)
      .set({ currentCanonicalRevisionId: revisionId })
      .where(eq(opportunities.id, opportunityId));

    expect((await getOpportunity(db, opportunityId))?.canonicalIsStale).toBe(false);

    // A crawl gives the listing a newer revision; the canonical fields now
    // describe inputs the member has moved past.
    const resourceId = await createTestResource(sourceId);
    const newerRevisionId = randomUUID();
    await db.insert(sourceListingRevisions).values({
      id: newerRevisionId,
      sourceListingId: listingId,
      parserVersion: 'test-v2',
      extractionMethod: 'http',
      rawResourceHash: 'e'.repeat(64),
      meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      titleRaw: `${title} (updated)`,
      titleNormalized: title.toLowerCase(),
      organizationRaw: 'Browse Test Org',
      description: 'updated',
      locations: [],
      publishedDate: { raw: '', parsed: '2026-09-01T00:00:00Z' },
      deadlineDate: { raw: '', parsed: '2026-12-01T00:00:00Z' },
      applicationMethod: { type: 'email', value: 'apply@example.invalid' },
      sourceCategories: [],
      structuredAttributes: {},
      createdAt: '2026-09-09T00:00:00Z',
      provenanceResourceId: resourceId,
      provenanceFetchedAt: '2026-09-09T00:00:00Z',
      provenanceNotes: null,
    });
    await db
      .update(sourceListings)
      .set({ currentRevisionId: newerRevisionId })
      .where(eq(sourceListings.id, listingId));

    expect((await getOpportunity(db, opportunityId))?.canonicalIsStale).toBe(true);
  });

  it('returns the canonical revision in force, and null when there is none', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const title = `Detail revision ${randomUUID().slice(0, 8)}`;
    const opportunityId = await cluster({ title, members: [{ sourceId }] });

    expect((await getOpportunity(db, opportunityId))?.revision).toBeNull();

    const revisionId = randomUUID();
    await db.insert(opportunityRevisions).values({
      id: revisionId,
      opportunityId,
      canonicalTitle: title,
      canonicalStatus: 'active',
      organizationId: null,
      resolvedFields: { title: [] },
      sourceMembershipVersions: {},
      resolutionRulesetVersion: 'v1',
      meaningfulContentHash: 'b'.repeat(64),
      createdAt: '2026-09-06T12:30:00Z',
    });
    await db
      .update(opportunities)
      .set({ currentCanonicalRevisionId: revisionId })
      .where(eq(opportunities.id, opportunityId));

    const view = await getOpportunity(db, opportunityId);
    expect(view?.revision?.id).toBe(revisionId);
    expect(view?.revision?.resolutionRulesetVersion).toBe('v1');
    expect(view?.revision?.createdAt).toBeTruthy();
  });

  /**
   * History must show what was DETACHED, not what the listing says now.
   *
   * A detached listing goes on being crawled, so following its current
   * revision pointer would let its entry in this opportunity's history
   * silently rewrite itself to a title the cluster never contained — an audit
   * trail describing something that was never there.
   */
  it('resolves a retired member against the revision in force when it was detached', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const originalTitle = `Detail historical ${randomUUID().slice(0, 8)}`;
    const opportunityId = await cluster({ title: originalTitle, members: [{ sourceId }] });

    const [listing] = await db
      .select({ id: opportunitySourceMemberships.sourceListingId })
      .from(opportunitySourceMemberships)
      .where(eq(opportunitySourceMemberships.opportunityId, opportunityId));
    const listingId = listing?.id as string;

    // Detach it, then let a later crawl give the listing a NEW revision with a
    // different title — exactly the sequence that used to rewrite history.
    await db
      .update(opportunitySourceMemberships)
      .set({ supersededAt: '2026-09-07T00:00:00Z' })
      .where(eq(opportunitySourceMemberships.sourceListingId, listingId));

    const resourceId = await createTestResource(sourceId);
    const laterRevisionId = randomUUID();
    await db.insert(sourceListingRevisions).values({
      id: laterRevisionId,
      sourceListingId: listingId,
      parserVersion: 'test-v2',
      extractionMethod: 'http',
      rawResourceHash: 'c'.repeat(64),
      meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      titleRaw: 'Retitled after detachment',
      titleNormalized: 'retitled after detachment',
      organizationRaw: 'Browse Test Org',
      description: 'rewritten description',
      locations: [],
      publishedDate: { raw: '', parsed: '2026-09-01T00:00:00Z' },
      deadlineDate: { raw: '', parsed: '2026-12-01T00:00:00Z' },
      applicationMethod: { type: 'email', value: 'apply@example.invalid' },
      sourceCategories: [],
      structuredAttributes: {},
      createdAt: '2026-09-09T00:00:00Z',
      provenanceResourceId: resourceId,
      provenanceFetchedAt: '2026-09-09T00:00:00Z',
      provenanceNotes: null,
    });
    await db
      .update(sourceListings)
      .set({ currentRevisionId: laterRevisionId })
      .where(eq(sourceListings.id, listingId));

    const view = await getOpportunity(db, opportunityId);
    expect(view?.formerMembers).toHaveLength(1);
    // The title as it was when detached, not the one the listing carries now.
    expect(view?.formerMembers[0]?.title).toBe(originalTitle);
    expect(view?.formerMembers[0]?.title).not.toBe('Retitled after detachment');
    expect(view?.formerMembers[0]?.membershipId).toBeTruthy();
  });

  /** An opportunity left with no live member still has to be inspectable. */
  it('returns an opportunity whose members have all been detached', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const title = `Detail empty ${randomUUID().slice(0, 8)}`;
    const opportunityId = await cluster({ title, members: [{ sourceId }] });
    await db
      .update(opportunitySourceMemberships)
      .set({ supersededAt: '2026-09-07T00:00:00Z' })
      .where(eq(opportunitySourceMemberships.opportunityId, opportunityId));

    const view = await getOpportunity(db, opportunityId);
    expect(view).not.toBeNull();
    expect(view?.members).toEqual([]);
    // And the point of keeping it: with no live members, the retired ones are
    // the only record of what this opportunity ever was.
    expect(view?.formerMembers).toHaveLength(1);
    expect(view?.formerMembers[0]?.canonicalUrl).toContain('https://');
  });
});
