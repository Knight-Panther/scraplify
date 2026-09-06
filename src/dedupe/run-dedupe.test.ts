import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
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
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../db/test-support.js';
import { detachListing, resolveDuplicateCandidate } from './membership-review.js';
import { runDedupe } from './run-dedupe.js';

/**
 * End-to-end dedupe against a real database, over two disposable sources.
 *
 * Every call passes `sourceIds`, scoping the pass to the disposable sources the
 * test created. This is not a stylistic choice: an unscoped runDedupe reads and
 * writes against every listing in the database, and the first version of these
 * tests silently created canonical opportunities and memberships for real
 * crawled jobs.ge and hr.ge listings (2026-09-06). The real-data guard did not
 * catch it either, because it only fingerprinted acquisition tables at the
 * time — both the scoping option and the widened guard came from that miss.
 */

async function addListing(
  sourceId: string,
  spec: {
    title: string;
    organization: string | null;
    applicationType?: string;
    applicationValue?: string;
    publishedAt?: string;
    deadlineAt?: string;
  },
): Promise<string> {
  const listing = await createTestSourceListing(sourceId, {
    status: 'active',
    sourcePublishedAt: spec.publishedAt ?? '2026-09-01T00:00:00Z',
    sourceDeadlineAt: spec.deadlineAt ?? '2026-10-01T00:00:00Z',
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
    organizationRaw: spec.organization,
    description: 'description',
    locations: [],
    publishedDate: { raw: '', parsed: spec.publishedAt ?? '2026-09-01T00:00:00Z' },
    deadlineDate: { raw: '', parsed: spec.deadlineAt ?? '2026-10-01T00:00:00Z' },
    applicationMethod:
      spec.applicationType === undefined
        ? null
        : { type: spec.applicationType, value: spec.applicationValue },
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

describe('runDedupe', () => {
  const sourceIds: string[] = [];
  let listingIds: string[] = [];

  afterEach(async () => {
    if (listingIds.length > 0) {
      const candidates = await db
        .select({ id: duplicateCandidates.id })
        .from(duplicateCandidates)
        .where(inArray(duplicateCandidates.sourceListingIdA, listingIds));
      if (candidates.length > 0) {
        await db.delete(duplicateCandidates).where(
          inArray(
            duplicateCandidates.id,
            candidates.map((row) => row.id),
          ),
        );
      }
      const memberships = await db
        .select({
          id: opportunitySourceMemberships.id,
          opportunityId: opportunitySourceMemberships.opportunityId,
        })
        .from(opportunitySourceMemberships)
        .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
      if (memberships.length > 0) {
        await db.delete(opportunitySourceMemberships).where(
          inArray(
            opportunitySourceMemberships.id,
            memberships.map((row) => row.id),
          ),
        );
        const opportunityIds = [...new Set(memberships.map((row) => row.opportunityId))];
        await db
          .update(opportunities)
          .set({ currentCanonicalRevisionId: null })
          .where(inArray(opportunities.id, opportunityIds));
        await db
          .delete(opportunityRevisions)
          .where(inArray(opportunityRevisions.opportunityId, opportunityIds));
        await db.delete(opportunities).where(inArray(opportunities.id, opportunityIds));
      }
      listingIds = [];
    }
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  it('auto-links a cross-source pair sharing a per-vacancy application link', async () => {
    const a = await createTestSource();
    const b = await createTestSource();
    sourceIds.push(a, b);
    const url = `https://ats.invalid/vacancy-${randomUUID()}`;
    const listingA = await addListing(a, {
      title: 'დიჯითალ კონსულტანტი',
      organization: 'თიბისი',
      applicationType: 'url',
      applicationValue: url,
    });
    const listingB = await addListing(b, {
      title: 'დიჯითალ კონსულტანტი',
      organization: 'თიბისი',
      applicationType: 'url',
      applicationValue: url,
    });
    listingIds = [listingA, listingB].sort();

    const result = await runDedupe(db, {
      autoLink: true,
      sourceIds,
      now: () => '2026-09-06T12:00:00Z',
    });

    expect(result.byDecision.confirmed_same).toBeGreaterThanOrEqual(1);

    const memberships = await db
      .select()
      .from(opportunitySourceMemberships)
      .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
    expect(memberships).toHaveLength(2);
    // Both listings joined ONE opportunity, not one each.
    expect(new Set(memberships.map((m) => m.opportunityId)).size).toBe(1);
    for (const membership of memberships) {
      expect(membership.decision).toBe('confirmed_same');
      expect(membership.supersededAt).toBeNull();
      expect(membership.decidedBy).toBe('ruleset');
      // §14.2: the decision must be explainable after the fact.
      expect(JSON.stringify(membership.evidence)).toContain('reasons');
    }
  });

  it('does not link anything when autoLink is off, but still records candidates', async () => {
    const a = await createTestSource();
    const b = await createTestSource();
    sourceIds.push(a, b);
    const url = `https://ats.invalid/vacancy-${randomUUID()}`;
    const listingA = await addListing(a, {
      title: 'სივრცის კონსულტანტი',
      organization: 'თიბისი',
      applicationType: 'url',
      applicationValue: url,
    });
    const listingB = await addListing(b, {
      title: 'სივრცის კონსულტანტი',
      organization: 'თიბისი',
      applicationType: 'url',
      applicationValue: url,
    });
    listingIds = [listingA, listingB].sort();

    const result = await runDedupe(db, { sourceIds, now: () => '2026-09-06T12:00:00Z' });

    expect(result.membershipsCreated).toBe(0);
    expect(result.opportunitiesCreated).toBe(0);
    const memberships = await db
      .select()
      .from(opportunitySourceMemberships)
      .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
    expect(memberships).toHaveLength(0);

    const [candidate] = await db
      .select()
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.sourceListingIdA, listingIds[0] as string));
    expect(candidate?.resultingDecision).toBe('confirmed_same');
  });

  it('never auto-links employer and title agreement without a per-vacancy signal', async () => {
    // §14.2's central prohibition, end to end.
    const a = await createTestSource();
    const b = await createTestSource();
    sourceIds.push(a, b);
    const inbox = `hr-${randomUUID()}@example.invalid`;
    // Three listings share the inbox, making it employer-level, not per-vacancy.
    const listingA = await addListing(a, {
      title: 'ბუღალტერი',
      organization: 'Shared Org',
      applicationType: 'email',
      applicationValue: inbox,
    });
    const listingB = await addListing(b, {
      title: 'ბუღალტერი',
      organization: 'Shared Org',
      applicationType: 'email',
      applicationValue: inbox,
    });
    const listingC = await addListing(b, {
      title: 'მძღოლი',
      organization: 'Shared Org',
      applicationType: 'email',
      applicationValue: inbox,
    });
    listingIds = [listingA, listingB, listingC].sort();

    const result = await runDedupe(db, {
      autoLink: true,
      sourceIds,
      now: () => '2026-09-06T12:00:00Z',
    });

    expect(result.byDecision.confirmed_same ?? 0).toBe(0);
    expect(result.byDecision.needs_review).toBeGreaterThanOrEqual(1);
    // Each listing is canonicalized as its OWN single-member opportunity, so
    // memberships exist — the claim under test is that none of them were
    // MERGED, which is what distinct opportunity ids per listing shows.
    // Asserting membershipsCreated === 0 would only have tested that
    // singletons are not canonicalized, which is a different (and wrong) thing.
    const memberships = await db
      .select()
      .from(opportunitySourceMemberships)
      .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
    expect(memberships).toHaveLength(3);
    expect(new Set(memberships.map((m) => m.opportunityId)).size).toBe(3);
  });

  it('is idempotent — a second pass creates no duplicate candidates or memberships', async () => {
    const a = await createTestSource();
    const b = await createTestSource();
    sourceIds.push(a, b);
    const url = `https://ats.invalid/vacancy-${randomUUID()}`;
    const listingA = await addListing(a, {
      title: 'ოპერატორი',
      organization: 'Idem Org',
      applicationType: 'url',
      applicationValue: url,
    });
    const listingB = await addListing(b, {
      title: 'ოპერატორი',
      organization: 'Idem Org',
      applicationType: 'url',
      applicationValue: url,
    });
    listingIds = [listingA, listingB].sort();

    await runDedupe(db, { autoLink: true, sourceIds, now: () => '2026-09-06T12:00:00Z' });
    const second = await runDedupe(db, {
      autoLink: true,
      sourceIds,
      now: () => '2026-09-06T13:00:00Z',
    });

    // The second pass re-evaluates the same pair but must not duplicate rows.
    expect(second.membershipsCreated).toBe(0);
    expect(second.opportunitiesCreated).toBe(0);

    const memberships = await db
      .select()
      .from(opportunitySourceMemberships)
      .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
    expect(memberships).toHaveLength(2);

    const candidates = await db
      .select()
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.sourceListingIdA, listingIds[0] as string));
    expect(candidates).toHaveLength(1);
  });

  it('clusters transitively: a third listing joins the existing opportunity', async () => {
    const a = await createTestSource();
    const b = await createTestSource();
    const c = await createTestSource();
    sourceIds.push(a, b, c);
    // A shared per-vacancy link across three sources. The value is carried by
    // 3 listings, so it is above the vacancy-level threshold of 2 — which is
    // itself the point: the pass must NOT auto-link here.
    const url = `https://ats.invalid/vacancy-${randomUUID()}`;
    const listingA = await addListing(a, {
      title: 'ანალიტიკოსი',
      organization: 'Tri Org',
      applicationType: 'url',
      applicationValue: url,
    });
    const listingB = await addListing(b, {
      title: 'ანალიტიკოსი',
      organization: 'Tri Org',
      applicationType: 'url',
      applicationValue: url,
    });
    const listingC = await addListing(c, {
      title: 'ანალიტიკოსი',
      organization: 'Tri Org',
      applicationType: 'url',
      applicationValue: url,
    });
    listingIds = [listingA, listingB, listingC].sort();

    const result = await runDedupe(db, {
      autoLink: true,
      sourceIds,
      now: () => '2026-09-06T12:00:00Z',
    });

    // Selectivity is what governs, not agreement count: a link on three
    // listings is an employer/ATS page, so this stays in review.
    expect(result.byDecision.confirmed_same ?? 0).toBe(0);
    // Same distinction as above: all three are canonicalized, but each into
    // its own opportunity. Nothing was merged.
    const memberships = await db
      .select()
      .from(opportunitySourceMemberships)
      .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
    expect(new Set(memberships.map((m) => m.opportunityId)).size).toBe(3);
  });

  it('canonicalizes a listing with no duplicate as its own opportunity', async () => {
    // Without this, only DUPLICATED listings would ever reach the canonical
    // layer, and browsing or ranking would show a handful of cross-posted jobs
    // instead of the corpus. Found 2026-09-06 by ranking real data and getting
    // 4 results from 410 listings; independently flagged P1 by review.
    const a = await createTestSource();
    sourceIds.push(a);
    const solitary = await addListing(a, {
      title: 'Entirely unique role',
      organization: 'Solo Org',
    });
    listingIds = [solitary];

    const result = await runDedupe(db, {
      autoLink: true,
      sourceIds,
      now: () => '2026-09-06T12:00:00Z',
    });

    expect(result.singletonsCanonicalized).toBe(1);
    const memberships = await db
      .select()
      .from(opportunitySourceMemberships)
      .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.supersededAt).toBeNull();
  });

  it('does not re-canonicalize an already-clustered listing on a rerun', async () => {
    const a = await createTestSource();
    sourceIds.push(a);
    const solitary = await addListing(a, { title: 'Rerun role', organization: 'Rerun Org' });
    listingIds = [solitary];

    await runDedupe(db, { autoLink: true, sourceIds, now: () => '2026-09-06T12:00:00Z' });
    const second = await runDedupe(db, {
      autoLink: true,
      sourceIds,
      now: () => '2026-09-06T13:00:00Z',
    });

    expect(second.singletonsCanonicalized).toBe(0);
    const memberships = await db
      .select()
      .from(opportunitySourceMemberships)
      .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
    expect(memberships).toHaveLength(1);
  });

  it('gives every listing at most one live membership', async () => {
    const a = await createTestSource();
    const b = await createTestSource();
    sourceIds.push(a, b);
    const url = `https://ats.invalid/vacancy-${randomUUID()}`;
    const listingA = await addListing(a, {
      title: 'მენეჯერი',
      organization: 'One Live Org',
      applicationType: 'url',
      applicationValue: url,
    });
    const listingB = await addListing(b, {
      title: 'მენეჯერი',
      organization: 'One Live Org',
      applicationType: 'url',
      applicationValue: url,
    });
    listingIds = [listingA, listingB].sort();

    await runDedupe(db, { autoLink: true, sourceIds, now: () => '2026-09-06T12:00:00Z' });

    for (const listingId of listingIds) {
      const live = await db
        .select()
        .from(opportunitySourceMemberships)
        .where(
          and(
            eq(opportunitySourceMemberships.sourceListingId, listingId),
            isNull(opportunitySourceMemberships.supersededAt),
          ),
        );
      expect(live.length).toBeLessThanOrEqual(1);
    }
  });

  it('does not recreate a merge a human reversed, even when the ruleset still says same', async () => {
    // §14.2 puts review authority with the human. Guarding only the candidate
    // upsert was not enough: linkPair still ran off the fresh ruleset score,
    // so an --auto-link run could rebuild exactly the merge a reviewer had
    // undone (adversarial review, 2026-09-06).
    const a = await createTestSource();
    const b = await createTestSource();
    sourceIds.push(a, b);
    const url = `https://ats.invalid/vacancy-${randomUUID()}`;
    const listingA = await addListing(a, {
      title: 'Reviewed apart',
      organization: 'Review Org',
      applicationType: 'url',
      applicationValue: url,
    });
    const listingB = await addListing(b, {
      title: 'Reviewed apart',
      organization: 'Review Org',
      applicationType: 'url',
      applicationValue: url,
    });
    listingIds = [listingA, listingB].sort();

    // The ruleset links them...
    const first = await runDedupe(db, {
      autoLink: true,
      sourceIds,
      now: () => '2026-09-06T12:00:00Z',
    });
    expect(first.byDecision.confirmed_same).toBeGreaterThanOrEqual(1);

    // ...a human then separates them and records the verdict.
    await detachListing(db, {
      sourceListingId: listingIds[1] as string,
      at: '2026-09-06T13:00:00Z',
    });
    const [candidate] = await db
      .select()
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.sourceListingIdA, listingIds[0] as string));
    await resolveDuplicateCandidate(db, {
      candidateId: candidate?.id as string,
      decision: 'distinct',
    });

    // A later automated pass must respect that, not undo it.
    await runDedupe(db, { autoLink: true, sourceIds, now: () => '2026-09-06T14:00:00Z' });

    const live = await db
      .select()
      .from(opportunitySourceMemberships)
      .where(
        and(
          inArray(opportunitySourceMemberships.sourceListingId, listingIds),
          isNull(opportunitySourceMemberships.supersededAt),
        ),
      );
    // Each listing is canonicalized separately; they must not share a cluster.
    expect(new Set(live.map((row) => row.opportunityId)).size).toBe(2);

    // And the human's verdict on the candidate itself survives the rerun.
    const [after] = await db
      .select()
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.id, candidate?.id as string));
    expect(after?.resultingDecision).toBe('distinct');
    expect(after?.decidedBy).toBe('human');
  });
});
