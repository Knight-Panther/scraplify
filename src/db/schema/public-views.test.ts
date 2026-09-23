import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../client.js';
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
  sourceListingRevisions,
  sourceListings,
} from './index.js';

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
  }): Promise<{ opportunityId: string; listingId: string; title: string }> {
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

    return { opportunityId, listingId: listing.id, title };
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
    expect(member?.description).toBe('a public-safe description');
    // The whole point of this view: dedupe internals are not columns it has
    // at all, not merely values it happens to omit.
    expect(member).not.toHaveProperty('evidence');
    expect(member).not.toHaveProperty('decision');
    expect(member).not.toHaveProperty('confidence');
    expect(member).not.toHaveProperty('decidedBy');
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
});
