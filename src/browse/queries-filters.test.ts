import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  opportunities,
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
  countListings,
  countOpportunities,
  countReviewQueue,
  listLiveMembersByOpportunity,
  searchListings,
  searchOpportunities,
} from './queries.js';

/**
 * The filtering, counting and ordering added so the opportunities screen could
 * be built (Stage 4).
 *
 * Every test scopes itself to disposable sources and a unique title marker.
 * That is not politeness: these queries run against the whole corpus by design,
 * and an assertion on a global count would both be flaky and tempt someone to
 * write fixtures into the real review queue.
 */
describe('opportunity filters, counts and ordering', () => {
  const sourceIds: string[] = [];
  const listingIds: string[] = [];
  const opportunityIds: string[] = [];

  async function addListing(
    sourceId: string,
    spec: {
      title: string;
      status?: 'active' | 'missing_suspected' | 'closed';
      firstSeenAt?: string;
    },
  ): Promise<string> {
    const listing = await createTestSourceListing(sourceId, {
      status: spec.status ?? 'active',
      sourceDeadlineAt: '2026-12-01T00:00:00Z',
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
      organizationRaw: 'Filter Test Org',
      description: 'description',
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
    return listing.id;
  }

  /** One cluster spread across N disposable sources. */
  async function makeCluster(spec: {
    title: string;
    sourceCount: number;
    status?: 'active' | 'missing_suspected' | 'closed';
    firstSeenAt?: string;
    /** Per-member first-seen, for the case where the members disagree. */
    firstSeenAts?: readonly string[];
  }): Promise<{ opportunityId: string; listingIds: string[]; slugs: string[] }> {
    const created: string[] = [];
    const slugs: string[] = [];
    for (let i = 0; i < spec.sourceCount; i++) {
      const sourceId = await createTestSource();
      sourceIds.push(sourceId);
      const [row] = await db.select().from(sources).where(eq(sources.id, sourceId));
      if (row !== undefined) slugs.push(row.slug);
      const firstSeenAt = spec.firstSeenAts?.[i] ?? spec.firstSeenAt;
      created.push(
        await addListing(sourceId, {
          title: spec.title,
          ...(spec.status === undefined ? {} : { status: spec.status }),
          ...(firstSeenAt === undefined ? {} : { firstSeenAt }),
        }),
      );
    }

    const opportunityId = randomUUID();
    opportunityIds.push(opportunityId);
    await db.insert(opportunities).values({
      id: opportunityId,
      type: 'job',
      canonicalTitle: spec.title,
      organizationId: null,
      canonicalStatus: spec.status ?? 'active',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-06T12:00:00Z',
      updatedAt: '2026-09-06T12:00:00Z',
    });
    for (const listingId of created) {
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
    return { opportunityId, listingIds: created, slugs };
  }

  afterEach(async () => {
    if (listingIds.length > 0) {
      await db
        .delete(opportunitySourceMemberships)
        .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
      listingIds.length = 0;
    }
    if (opportunityIds.length > 0) {
      await db.delete(opportunities).where(inArray(opportunities.id, opportunityIds));
      opportunityIds.length = 0;
    }
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  it('counts exactly what the same filters return', async () => {
    // The bug this prevents: a count built from a hand-copied filter set drifts
    // from the search it paginates, and page 3 of a 2-page result appears.
    const marker = `Count parity ${randomUUID().slice(0, 8)}`;
    await makeCluster({ title: marker, sourceCount: 1 });
    await makeCluster({ title: marker, sourceCount: 1 });

    const rows = await searchOpportunities(db, { text: marker, limit: 500 });
    expect(await countOpportunities(db, { text: marker })).toBe(rows.length);
    expect(rows).toHaveLength(2);

    const listingRows = await searchListings(db, { text: marker, limit: 500 });
    expect(await countListings(db, { text: marker })).toBe(listingRows.length);
  });

  it('gives a cross-posted opportunity ONE row, not one per member', async () => {
    // The EXISTS filter keeps the opportunity row singular. A join would
    // multiply it by member count, so LIMIT would paginate over duplicates and
    // a three-source cross-post would eat three slots on the page.
    const marker = `Cross post ${randomUUID().slice(0, 8)}`;
    const { opportunityId } = await makeCluster({ title: marker, sourceCount: 3 });

    const rows = await searchOpportunities(db, { text: marker, crossPostedOnly: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.opportunityId).toBe(opportunityId);
    expect(rows[0]?.members).toHaveLength(3);
    expect(await countOpportunities(db, { text: marker, crossPostedOnly: true })).toBe(1);
  });

  it('does not call two listings from the SAME board cross-posted', async () => {
    // "On both boards" must mean more than one BOARD, not more than one
    // membership. The schema only enforces one live membership per listing, so
    // a cluster can legitimately hold two live listings from one source —
    // transitive linking and manual reassignment both produce it. Counting
    // memberships returned such a cluster under the filter while the row, which
    // collapses members to distinct sources, showed a single board.
    const marker = `Same board ${randomUUID().slice(0, 8)}`;
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);

    const first = await addListing(sourceId, { title: marker });
    const second = await addListing(sourceId, { title: marker });

    const opportunityId = randomUUID();
    opportunityIds.push(opportunityId);
    await db.insert(opportunities).values({
      id: opportunityId,
      type: 'job',
      canonicalTitle: marker,
      organizationId: null,
      canonicalStatus: 'active',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-06T12:00:00Z',
      updatedAt: '2026-09-06T12:00:00Z',
    });
    for (const sourceListingId of [first, second]) {
      await db.insert(opportunitySourceMemberships).values({
        id: randomUUID(),
        opportunityId,
        sourceListingId,
        decision: 'confirmed_same',
        confidence: 0.97,
        evidence: {},
        decidedBy: 'ruleset',
        decidedAt: '2026-09-06T12:00:00Z',
        dedupeModelOrRulesetVersion: 'v1',
        supersededAt: null,
      });
    }

    // Two live memberships, one board: present in the list, absent from the
    // cross-posted view.
    expect(await countOpportunities(db, { text: marker })).toBe(1);
    expect(await countOpportunities(db, { text: marker, crossPostedOnly: true })).toBe(0);

    const [row] = await searchOpportunities(db, { text: marker });
    expect(row?.members).toHaveLength(2);
  });

  it('excludes a single-source opportunity from the cross-posted view', async () => {
    const marker = `Single source ${randomUUID().slice(0, 8)}`;
    await makeCluster({ title: marker, sourceCount: 1 });
    expect(await countOpportunities(db, { text: marker, crossPostedOnly: true })).toBe(0);
    expect(await countOpportunities(db, { text: marker })).toBe(1);
  });

  it('filters opportunities by the source of a live member', async () => {
    const marker = `By source ${randomUUID().slice(0, 8)}`;
    const { slugs } = await makeCluster({ title: marker, sourceCount: 1 });
    expect(await countOpportunities(db, { text: marker, sourceSlug: slugs[0] })).toBe(1);
    expect(await countOpportunities(db, { text: marker, sourceSlug: 'no-such-source' })).toBe(0);
  });

  it('stops matching a source once that membership is retired', async () => {
    const marker = `Retired member ${randomUUID().slice(0, 8)}`;
    const { listingIds: members, slugs } = await makeCluster({ title: marker, sourceCount: 2 });
    expect(await countOpportunities(db, { text: marker, sourceSlug: slugs[0] })).toBe(1);

    await db
      .update(opportunitySourceMemberships)
      .set({ supersededAt: '2026-09-07T00:00:00Z' })
      .where(eq(opportunitySourceMemberships.sourceListingId, members[0] as string));

    expect(await countOpportunities(db, { text: marker, sourceSlug: slugs[0] })).toBe(0);
    // And it is no longer cross-posted, since only one live member remains.
    expect(await countOpportunities(db, { text: marker, crossPostedOnly: true })).toBe(0);
  });

  it('filters by canonical status', async () => {
    const marker = `Status filter ${randomUUID().slice(0, 8)}`;
    await makeCluster({ title: `${marker} open`, sourceCount: 1, status: 'active' });
    await makeCluster({ title: `${marker} gone`, sourceCount: 1, status: 'missing_suspected' });

    expect(await countOpportunities(db, { text: marker })).toBe(2);
    expect(await countOpportunities(db, { text: marker, statuses: ['active'] })).toBe(1);
    expect(await countOpportunities(db, { text: marker, statuses: ['missing_suspected'] })).toBe(1);
    expect(
      await countOpportunities(db, { text: marker, statuses: ['active', 'missing_suspected'] }),
    ).toBe(2);
  });

  it('orders by when a vacancy first appeared, not by updatedAt', async () => {
    // updatedAt is stamped on every cluster a dedupe pass touches, so ordering
    // by it reshuffled the whole list after each crawl and never meant "newest
    // job". This makes the two orderings disagree and asserts which one wins.
    const marker = `Ordering ${randomUUID().slice(0, 8)}`;
    const older = await makeCluster({
      title: `${marker} older`,
      sourceCount: 1,
      firstSeenAt: '2026-01-01T00:00:00Z',
    });
    const newer = await makeCluster({
      title: `${marker} newer`,
      sourceCount: 1,
      firstSeenAt: '2026-08-01T00:00:00Z',
    });

    await db
      .update(opportunities)
      .set({ updatedAt: '2026-09-07T00:00:00Z' })
      .where(eq(opportunities.id, older.opportunityId));

    const rows = await searchOpportunities(db, { text: marker, limit: 10 });
    expect(rows.map((row) => row.opportunityId)).toEqual([
      newer.opportunityId,
      older.opportunityId,
    ]);
  });

  it('excludes an opportunity whose last live membership was retired', async () => {
    // `detachListing` and reassignment keep the opportunity row after emptying
    // it, so the audit trail survives. Browsing must not: a cluster with no
    // live member has no route to any source, and counting it would make a
    // total that claims to be one row per vacancy wrong.
    const marker = `Shell ${randomUUID().slice(0, 8)}`;
    const shell = await makeCluster({ title: `${marker} emptied`, sourceCount: 1 });
    await makeCluster({ title: `${marker} intact`, sourceCount: 1 });

    expect(await countOpportunities(db, { text: marker })).toBe(2);

    await db
      .update(opportunitySourceMemberships)
      .set({ supersededAt: '2026-09-07T00:00:00Z' })
      .where(eq(opportunitySourceMemberships.opportunityId, shell.opportunityId));

    const rows = await searchOpportunities(db, { text: marker, limit: 10 });
    expect(rows.map((row) => row.canonicalTitle)).toEqual([`${marker} intact`]);
    expect(await countOpportunities(db, { text: marker })).toBe(1);
  });

  it('judges firstSeenFrom by the earliest member, not by any member', async () => {
    // A months-old vacancy that a second board picked up yesterday is not new.
    // An any-member EXISTS said it was — while the row itself displayed, and
    // the 'recent' sort ordered by, the earliest member. The filter has to
    // agree with the value the screen shows or "last 24 hours" lies.
    const marker = `FirstSeen ${randomUUID().slice(0, 8)}`;
    const old = await makeCluster({
      title: `${marker} long-standing`,
      sourceCount: 2,
      firstSeenAts: ['2026-01-01T00:00:00Z', '2026-09-06T00:00:00Z'],
    });
    const fresh = await makeCluster({
      title: `${marker} genuinely new`,
      sourceCount: 1,
      firstSeenAt: '2026-09-06T00:00:00Z',
    });

    const rows = await searchOpportunities(db, {
      text: marker,
      firstSeenFrom: '2026-09-05T00:00:00Z',
      limit: 10,
    });
    expect(rows.map((row) => row.opportunityId)).toEqual([fresh.opportunityId]);
    expect(
      await countOpportunities(db, { text: marker, firstSeenFrom: '2026-09-05T00:00:00Z' }),
    ).toBe(1);

    // Both are in range when the cutoff genuinely precedes both.
    expect(
      await countOpportunities(db, { text: marker, firstSeenFrom: '2025-12-01T00:00:00Z' }),
    ).toBe(2);
    expect(old.opportunityId).not.toBe(fresh.opportunityId);
  });

  it('paginates tied rows without duplicating or dropping any', async () => {
    // None of the three sort keys is unique — the corpus has 174 opportunities
    // sharing one deadline. Without a tie-breaker Postgres may order tied rows
    // differently per query, so a tie straddling a page boundary shows some
    // rows twice and hides others completely.
    // Every listing `addListing` makes carries the same deadline, so these six
    // are a genuine tie under the 'deadline' ordering.
    const marker = `Tie ${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 6; i++) {
      await makeCluster({ title: `${marker} same`, sourceCount: 1 });
    }

    const seen: string[] = [];
    for (let offset = 0; offset < 6; offset += 2) {
      const page = await searchOpportunities(db, {
        text: marker,
        sort: 'deadline',
        limit: 2,
        offset,
      });
      seen.push(...page.map((row) => row.opportunityId));
    }

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it('sorts by title when asked', async () => {
    const marker = `Sorting ${randomUUID().slice(0, 8)}`;
    await makeCluster({ title: `${marker} zulu`, sourceCount: 1 });
    await makeCluster({ title: `${marker} alpha`, sourceCount: 1 });

    const rows = await searchOpportunities(db, { text: marker, sort: 'title', limit: 10 });
    expect(rows.map((row) => row.canonicalTitle)).toEqual([`${marker} alpha`, `${marker} zulu`]);
  });

  it('matches Georgian search text regardless of Unicode normalization', async () => {
    // Pasted and typed Georgian can carry different normalizations for the same
    // word, and `ilike` compares bytes.
    const suffix = randomUUID().slice(0, 8);
    const title = `ქართული ვაკანსია ${suffix}`;
    await makeCluster({ title, sourceCount: 1 });

    expect(await countListings(db, { text: title.normalize('NFC') })).toBe(1);
    expect(await countListings(db, { text: title.normalize('NFD') })).toBe(1);
  });

  it('returns live members keyed by opportunity, and skips retired ones', async () => {
    const marker = `Members helper ${randomUUID().slice(0, 8)}`;
    const { opportunityId, listingIds: members } = await makeCluster({
      title: marker,
      sourceCount: 2,
    });

    let byOpportunity = await listLiveMembersByOpportunity(db, [opportunityId]);
    expect(byOpportunity.get(opportunityId)).toHaveLength(2);

    await db
      .update(opportunitySourceMemberships)
      .set({ supersededAt: '2026-09-07T00:00:00Z' })
      .where(eq(opportunitySourceMemberships.sourceListingId, members[0] as string));

    byOpportunity = await listLiveMembersByOpportunity(db, [opportunityId]);
    expect(byOpportunity.get(opportunityId)).toHaveLength(1);
    expect(await listLiveMembersByOpportunity(db, [])).toEqual(new Map());
  });

  it('paginates consistently with its own count', async () => {
    const marker = `Paging ${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 5; i++) await makeCluster({ title: `${marker} ${i}`, sourceCount: 1 });

    const total = await countOpportunities(db, { text: marker });
    expect(total).toBe(5);

    const first = await searchOpportunities(db, { text: marker, limit: 2, offset: 0 });
    const last = await searchOpportunities(db, { text: marker, limit: 2, offset: 4 });
    expect(first).toHaveLength(2);
    expect(last).toHaveLength(1);

    // No row appears on two pages.
    const seen = new Set<string>();
    for (let offset = 0; offset < total; offset += 2) {
      const page = await searchOpportunities(db, { text: marker, limit: 2, offset });
      for (const row of page) seen.add(row.opportunityId);
    }
    expect(seen.size).toBe(total);
  });

  it('counts the review queue without inventing candidates', async () => {
    // Deliberately fixture-free: writing candidates here would pollute the
    // shared review queue that a human actually works through.
    const total = await countReviewQueue(db);
    expect(Number.isInteger(total)).toBe(true);
    expect(total).toBeGreaterThanOrEqual(0);
  });
});
