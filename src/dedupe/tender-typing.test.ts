import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/client.js';
import {
  duplicateCandidates,
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
import { reassignListing } from './membership-review.js';
import { runDedupe } from './run-dedupe.js';

// A disposable source stands in for etenders.ge, so the pass types it as the
// tender source without touching the real one (see src/adapters/etenders-ge/
// crawl.test.ts for the same isolation).
const tenderSource = vi.hoisted(() => ({ id: crypto.randomUUID() }));

vi.mock('../policies/etenders-ge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../policies/etenders-ge.js')>();
  return {
    ...actual,
    etendersGeSource: { ...actual.etendersGeSource, id: tenderSource.id },
  };
});

interface ListingSpec {
  title: string;
  organization: string;
  applicationValue?: string;
  publishedAt?: string;
  deadlineAt?: string;
  description?: string;
}

async function addListing(
  sourceId: string,
  spec: ListingSpec,
): Promise<{ listingId: string; revisionId: string }> {
  const publishedAt = spec.publishedAt ?? '2026-10-01T00:00:00Z';
  const deadlineAt = spec.deadlineAt ?? '2026-10-20T00:00:00Z';
  const listing = await createTestSourceListing(sourceId, {
    status: 'active',
    sourcePublishedAt: publishedAt,
    sourceDeadlineAt: deadlineAt,
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
    description: spec.description ?? '',
    locations: [],
    publishedDate: { raw: '', parsed: publishedAt },
    deadlineDate: { raw: '', parsed: deadlineAt },
    applicationMethod: {
      type: 'url',
      value: spec.applicationValue ?? `https://tenders.invalid/${randomUUID()}`,
    },
    sourceCategories: [],
    structuredAttributes: {},
    createdAt: '2026-10-01T00:00:00Z',
    provenanceResourceId: resourceId,
    provenanceFetchedAt: '2026-10-01T00:00:00Z',
    provenanceNotes: null,
  });
  await db
    .update(sourceListings)
    .set({ currentRevisionId: revisionId })
    .where(eq(sourceListings.id, listing.id));
  return { listingId: listing.id, revisionId };
}

async function retitle(revisionId: string, title: string): Promise<void> {
  await db
    .update(sourceListingRevisions)
    .set({ titleRaw: title, titleNormalized: title.toLowerCase() })
    .where(eq(sourceListingRevisions.id, revisionId));
}

describe('dedupe typing for tenders', () => {
  const sourceIds: string[] = [];
  let listingIds: string[] = [];

  afterEach(async () => {
    if (listingIds.length > 0) {
      await db
        .delete(duplicateCandidates)
        .where(
          or(
            inArray(duplicateCandidates.sourceListingIdA, listingIds),
            inArray(duplicateCandidates.sourceListingIdB, listingIds),
          ),
        );
      const memberships = await db
        .select({ opportunityId: opportunitySourceMemberships.opportunityId })
        .from(opportunitySourceMemberships)
        .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
      await db
        .delete(opportunitySourceMemberships)
        .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
      const opportunityIds = [...new Set(memberships.map((row) => row.opportunityId))];
      if (opportunityIds.length > 0) {
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

  async function liveOpportunity(
    listingId: string,
  ): Promise<{ id: string; type: string } | undefined> {
    const [row] = await db
      .select({ id: opportunities.id, type: opportunities.type })
      .from(opportunitySourceMemberships)
      .innerJoin(opportunities, eq(opportunities.id, opportunitySourceMemberships.opportunityId))
      .where(
        and(
          eq(opportunitySourceMemberships.sourceListingId, listingId),
          isNull(opportunitySourceMemberships.supersededAt),
        ),
      );
    return row;
  }

  async function candidate(a: string, b: string) {
    const [low, high] = a < b ? [a, b] : [b, a];
    const [row] = await db
      .select()
      .from(duplicateCandidates)
      .where(
        and(
          eq(duplicateCandidates.sourceListingIdA, low),
          eq(duplicateCandidates.sourceListingIdB, high),
        ),
      );
    return row;
  }

  async function seedTenderSource(): Promise<void> {
    await db.insert(sources).values({
      id: tenderSource.id,
      slug: `test-source-${tenderSource.id}`,
      displayName: 'Tender test source',
      baseUrl: 'https://example.invalid/',
    });
    sourceIds.push(tenderSource.id);
  }

  async function jobBoard(): Promise<string> {
    const id = await createTestSource();
    sourceIds.push(id);
    return id;
  }

  const dedupe = (now = '2026-10-07T12:00:00Z') =>
    runDedupe(db, { autoLink: true, sourceIds, now: () => now });

  it('canonicalizes etenders.ge listings as tenders and never pairs a tender with a vacancy', async () => {
    await seedTenderSource();
    const jobSource = await jobBoard();

    // Same buyer, same title, same application link: a certain merge if the
    // two were the same kind of opportunity.
    const shared = {
      title: 'მობილური კომპიუტერული ურიკების შესყიდვა',
      organization: 'ავერსის კლინიკა',
      applicationValue: `https://tenders.invalid/${randomUUID()}`,
    };
    const tender = await addListing(tenderSource.id, shared);
    const vacancy = await addListing(jobSource, {
      ...shared,
      title: 'მობილური კომპიუტერული ურიკების შესყიდვების სპეციალისტი',
    });
    listingIds = [tender.listingId, vacancy.listingId];

    await dedupe();

    expect((await liveOpportunity(tender.listingId))?.type).toBe('tender');
    expect((await liveOpportunity(vacancy.listingId))?.type).toBe('job');
    expect(await candidate(tender.listingId, vacancy.listingId)).toBeUndefined();
  });

  it("merges a board's tender posts with their etenders.ge tender into one tender", async () => {
    await seedTenderSource();
    const hrBoard = await jobBoard();
    const jobsBoard = await jobBoard();

    // Aversi Clinic's carts, as the three sites stored them (golden pair).
    const tender = await addListing(tenderSource.id, {
      title: 'საოპერაციო ბლოკის მობილური კომპიუტერული ურიკები',
      organization: 'შპს "ავერსის კლინიკა"',
      publishedAt: '2026-09-28T12:51:00Z',
      deadlineAt: '2026-10-15T11:00:00Z',
    });
    const hrPost = await addListing(hrBoard, {
      title: 'ტენდერი - საოპერაციო ბლოკისთვის მობილური კომპიუტერული ურიკების შესყიდვის თაობაზე',
      organization: 'ავერსის კლინიკა',
      publishedAt: '2026-10-01T09:48:53Z',
      deadlineAt: '2026-10-15T15:59:00Z',
    });
    const jobsPost = await addListing(jobsBoard, {
      title: 'ტენდერი - მობილური კომპიუტერული ურიკების შესყიდვა',
      organization: 'ავერსის კლინიკა',
      publishedAt: '2026-09-30T20:00:00Z',
      deadlineAt: '2026-10-14T20:00:00Z',
    });
    listingIds = [tender.listingId, hrPost.listingId, jobsPost.listingId];

    await dedupe();

    const cluster = await liveOpportunity(tender.listingId);
    expect(cluster?.type).toBe('tender');
    expect((await liveOpportunity(hrPost.listingId))?.id).toBe(cluster?.id);
    expect((await liveOpportunity(jobsPost.listingId))?.id).toBe(cluster?.id);
    expect((await candidate(tender.listingId, hrPost.listingId))?.resultingDecision).toBe(
      'confirmed_same',
    );
  });

  it('holds a board post that matches two of one buyer’s tenders for a human', async () => {
    await seedTenderSource();
    const board = await jobBoard();

    const lot = (title: string) =>
      addListing(tenderSource.id, {
        title,
        organization: 'შპს "ავერსის კლინიკა"',
        publishedAt: '2026-09-28T10:00:00Z',
        deadlineAt: '2026-10-15T11:00:00Z',
      });
    const lotOne = await lot('მობილური კომპიუტერული ურიკები - ლოტი 1');
    const lotTwo = await lot('მობილური კომპიუტერული ურიკები - ლოტი 2');
    const post = await addListing(board, {
      title: 'ტენდერი - მობილური კომპიუტერული ურიკების შესყიდვა',
      organization: 'ავერსის კლინიკა',
      publishedAt: '2026-09-29T09:00:00Z',
      deadlineAt: '2026-10-15T15:59:00Z',
    });
    listingIds = [lotOne.listingId, lotTwo.listingId, post.listingId];

    await dedupe();

    expect((await candidate(post.listingId, lotOne.listingId))?.resultingDecision).toBe(
      'needs_review',
    );
    expect((await candidate(post.listingId, lotTwo.listingId))?.resultingDecision).toBe(
      'needs_review',
    );
    const ids = new Set(
      await Promise.all(listingIds.map(async (id) => (await liveOpportunity(id))?.id)),
    );
    expect(ids.size).toBe(3);
  });

  it('never lets a second tender from one site join a cluster that holds the first', async () => {
    await seedTenderSource();
    const board = await jobBoard();
    const buyer = { organization: 'შპს "ავერსის კლინიკა"', publishedAt: '2026-09-28T10:00:00Z' };
    const first = await addListing(tenderSource.id, {
      ...buyer,
      title: 'მობილური კომპიუტერული ურიკები',
      deadlineAt: '2026-10-15T11:00:00Z',
    });
    const post = await addListing(board, {
      title: 'ტენდერი - მობილური კომპიუტერული ურიკების შესყიდვა',
      organization: 'ავერსის კლინიკა',
      publishedAt: '2026-09-29T09:00:00Z',
      deadlineAt: '2026-10-15T15:59:00Z',
    });
    listingIds = [first.listingId, post.listingId];
    await dedupe();
    const cluster = await liveOpportunity(post.listingId);
    expect((await liveOpportunity(first.listingId))?.id).toBe(cluster?.id);

    // The first tender's deadline moves a week, so it no longer matches the
    // post on its own; a second tender now does.
    await db
      .update(sourceListings)
      .set({ sourceDeadlineAt: '2026-10-22T11:00:00Z' })
      .where(eq(sourceListings.id, first.listingId));
    const second = await addListing(tenderSource.id, {
      ...buyer,
      title: 'მობილური კომპიუტერული ურიკები',
      deadlineAt: '2026-10-15T11:00:00Z',
    });
    listingIds.push(second.listingId);
    await dedupe('2026-10-08T12:00:00Z');

    expect((await candidate(post.listingId, second.listingId))?.resultingDecision).toBe(
      'confirmed_same',
    );
    expect((await liveOpportunity(second.listingId))?.id).not.toBe(cluster?.id);
    expect((await liveOpportunity(first.listingId))?.id).toBe(cluster?.id);
  });

  it('folds the two board copies of a tender that predate the tender rules into one', async () => {
    const hrBoard = await jobBoard();
    const jobsBoard = await jobBoard();
    // Aversi Clinic's HVAC works as hr.ge and jobs.ge carried them, first
    // under titles no rule calls a tender, as every post looked before 9B.
    const dates = { organization: 'ავერსის კლინიკა', deadlineAt: '2026-10-05T15:59:00Z' };
    const hrPost = await addListing(hrBoard, {
      ...dates,
      title: 'გათბობა-გაგრილებისა და ვენტილაციის სისტემების მოწყობა',
      publishedAt: '2026-09-30T12:16:54Z',
    });
    const jobsPost = await addListing(jobsBoard, {
      ...dates,
      title: 'გათბობა-გაგრილების სისტემები',
      publishedAt: '2026-09-29T20:00:00Z',
    });
    listingIds = [hrPost.listingId, jobsPost.listingId];
    await dedupe();
    const hrBefore = await liveOpportunity(hrPost.listingId);
    const jobsBefore = await liveOpportunity(jobsPost.listingId);
    expect(hrBefore?.id).not.toBe(jobsBefore?.id);
    expect(hrBefore?.type).toBe('job');

    await retitle(
      hrPost.revisionId,
      'ტენდერი - გათბობა-გაგრილებისა და ვენტილაციის სისტემების მოწყობის სამუშაოების შესყიდვის თაობაზე',
    );
    await retitle(
      jobsPost.revisionId,
      'ტენდერი -გათბობა-გაგრილების სისტემების სამუშაოების  შესყიდვა',
    );
    await dedupe('2026-10-08T12:00:00Z');

    const hrAfter = await liveOpportunity(hrPost.listingId);
    expect((await liveOpportunity(jobsPost.listingId))?.id).toBe(hrAfter?.id);
    expect(hrAfter?.type).toBe('tender');
    expect([hrBefore?.id, jobsBefore?.id]).toContain(hrAfter?.id);
  });

  it('retypes an existing opportunity when its listing is reclassified', async () => {
    const board = await jobBoard();
    const listing = await addListing(board, {
      title: 'საოფისე ავეჯის მიმწოდებელი',
      organization: 'Test Buyer',
    });
    listingIds = [listing.listingId];

    await dedupe();
    const before = await liveOpportunity(listing.listingId);
    expect(before?.type).toBe('job');

    await retitle(listing.revisionId, 'ტენდერი - საოფისე ავეჯის შესყიდვა');
    await dedupe('2026-10-08T12:00:00Z');
    const after = await liveOpportunity(listing.listingId);
    expect(after?.id).toBe(before?.id);
    expect(after?.type).toBe('tender');

    await retitle(listing.revisionId, 'საოფისე ავეჯის მიმწოდებელი');
    await dedupe('2026-10-09T12:00:00Z');
    expect((await liveOpportunity(listing.listingId))?.type).toBe('job');
  });

  it('queues an automatic vacancy merge once one side turns out to be a tender post', async () => {
    const hrBoard = await jobBoard();
    const jobsBoard = await jobBoard();
    const shared = {
      title: 'საოფისე ავეჯის მიწოდება და მონტაჟი',
      organization: 'Test Buyer',
      applicationValue: `https://ats.invalid/${randomUUID()}`,
    };
    const first = await addListing(hrBoard, shared);
    const second = await addListing(jobsBoard, shared);
    listingIds = [first.listingId, second.listingId];

    await dedupe();
    const merged = await liveOpportunity(first.listingId);
    expect((await liveOpportunity(second.listingId))?.id).toBe(merged?.id);

    await retitle(first.revisionId, 'ტენდერი - საოფისე ავეჯის მიწოდება და მონტაჟი');
    const result = await dedupe('2026-10-08T12:00:00Z');

    const row = await candidate(first.listingId, second.listingId);
    expect(row?.resultingDecision).toBe('needs_review');
    expect(JSON.stringify(row?.evidence)).toContain(
      'one listing is a tender and the other a vacancy',
    );
    expect(result.staleLinksFlagged).toBeGreaterThanOrEqual(1);
    // The merge itself stands until a human splits it; the cluster reads as
    // the tender one of its members is.
    expect((await liveOpportunity(second.listingId))?.id).toBe(merged?.id);
    expect((await liveOpportunity(first.listingId))?.type).toBe('tender');
  });

  it('refuses a reviewer move that would put a vacancy inside a tender', async () => {
    await seedTenderSource();
    const board = await jobBoard();
    const tender = await addListing(tenderSource.id, {
      title: 'გენერატორების შესყიდვა',
      organization: 'შპს ავერსი–ფარმა',
    });
    const vacancy = await addListing(board, {
      title: 'ელექტრიკოსი გენერატორების მომსახურებაზე',
      organization: 'ავერსი ფარმა',
    });
    listingIds = [tender.listingId, vacancy.listingId];
    await dedupe();
    const tenderOpportunity = await liveOpportunity(tender.listingId);
    const vacancyOpportunity = await liveOpportunity(vacancy.listingId);
    expect(tenderOpportunity?.type).toBe('tender');
    expect(vacancyOpportunity?.type).toBe('job');

    await expect(
      reassignListing(db, {
        sourceListingId: vacancy.listingId,
        toOpportunityId: tenderOpportunity?.id ?? '',
        decision: 'confirmed_same',
        confidence: 1,
        evidence: { reasons: ['operator test'] },
        actor: { decidedBy: 'human', version: 'test' },
        at: '2026-10-07T13:00:00Z',
      }),
    ).rejects.toThrow(/is a job and opportunity .* is a tender/);
    expect((await liveOpportunity(vacancy.listingId))?.id).toBe(vacancyOpportunity?.id);
  });
});
