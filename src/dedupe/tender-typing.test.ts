import { randomUUID } from 'node:crypto';
import { eq, inArray, or } from 'drizzle-orm';
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
import { opportunityTypeForSource, runDedupe } from './run-dedupe.js';

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

async function addListing(
  sourceId: string,
  spec: { title: string; organization: string; applicationValue: string },
): Promise<string> {
  const listing = await createTestSourceListing(sourceId, {
    status: 'active',
    sourcePublishedAt: '2026-10-01T00:00:00Z',
    sourceDeadlineAt: '2026-10-20T00:00:00Z',
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
    description: '',
    locations: [],
    publishedDate: { raw: '', parsed: '2026-10-01T00:00:00Z' },
    deadlineDate: { raw: '', parsed: '2026-10-20T00:00:00Z' },
    applicationMethod: { type: 'url', value: spec.applicationValue },
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
  return listing.id;
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

  async function typeOf(listingId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ type: opportunities.type })
      .from(opportunitySourceMemberships)
      .innerJoin(opportunities, eq(opportunities.id, opportunitySourceMemberships.opportunityId))
      .where(eq(opportunitySourceMemberships.sourceListingId, listingId));
    return row?.type;
  }

  it('types listings by source', () => {
    expect(opportunityTypeForSource(tenderSource.id)).toBe('tender');
    expect(opportunityTypeForSource(randomUUID())).toBe('job');
  });

  async function seedTenderSource(): Promise<void> {
    await db.insert(sources).values({
      id: tenderSource.id,
      slug: `test-source-${tenderSource.id}`,
      displayName: 'Tender test source',
      baseUrl: 'https://example.invalid/',
    });
    sourceIds.push(tenderSource.id);
  }

  it('canonicalizes etenders.ge listings as tenders and never pairs a tender with a vacancy', async () => {
    await seedTenderSource();
    const jobSource = await createTestSource();
    sourceIds.push(jobSource);

    // Same buyer, same title, same application link: a certain merge if the
    // two were the same kind of opportunity.
    const shared = {
      title: 'მობილური კომპიუტერული ურიკების შესყიდვა',
      organization: 'ავერსის კლინიკა',
      applicationValue: `https://tenders.invalid/${randomUUID()}`,
    };
    const tender = await addListing(tenderSource.id, shared);
    const jobBoardPost = await addListing(jobSource, shared);
    listingIds = [tender, jobBoardPost];

    await runDedupe(db, { autoLink: true, sourceIds, now: () => '2026-10-07T12:00:00Z' });

    expect(await typeOf(tender)).toBe('tender');
    expect(await typeOf(jobBoardPost)).toBe('job');
    const pairs = await db
      .select()
      .from(duplicateCandidates)
      .where(inArray(duplicateCandidates.sourceListingIdA, listingIds));
    expect(pairs).toHaveLength(0);
  });
});
