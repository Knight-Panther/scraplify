import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  PublicOpportunityDetailView,
  PublicOpportunityMemberDetail,
} from '../../src/browse/public-queries.js';
import { toPublicDetail } from './public-opportunity-detail.js';

/**
 * `toPublicDetail`'s own comparison/apply/extras logic is the same shared,
 * already-tested helpers `toDetail` uses (see `opportunity-detail.test.ts`
 * for disagreement-vs-absence, apply-route and extras coverage) — this file
 * only tests what is actually NEW here: the shape assembles correctly from a
 * `PublicOpportunityDetailView` with no dedupe fields at all, and a
 * policy-omitted description (already emptied by the query layer) is
 * excluded exactly like a board that genuinely wrote nothing.
 */

function member(
  overrides: Partial<PublicOpportunityMemberDetail> = {},
): PublicOpportunityMemberDetail {
  return {
    sourceListingId: randomUUID(),
    sourceSlug: 'jobs-ge',
    status: 'active',
    title: 'დიჯითალ კონსულტანტი',
    organization: 'თიბისი',
    canonicalUrl: 'https://jobs.ge/ge/?view=jobs&id=1',
    publishedAt: '2026-09-03T20:00:00.000Z',
    deadlineAt: '2026-09-13T20:00:00.000Z',
    firstSeenAt: '2026-09-04T00:00:00.000Z',
    lastSeenAt: '2026-09-07T00:00:00.000Z',
    applicationMethod: { type: 'url', value: 'https://smrtr.io/BB-Nd' },
    description: 'ვაკანსიის აღწერა.',
    locations: [],
    salaryRaw: null,
    sourceCategories: [],
    structuredAttributes: {},
    ...overrides,
  };
}

function view(members: PublicOpportunityMemberDetail[]): PublicOpportunityDetailView {
  return {
    opportunityId: 'opp-1',
    canonicalTitle: 'დიჯითალ კონსულტანტი',
    canonicalStatus: 'active',
    type: 'job',
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
    members,
  };
}

describe('toPublicDetail', () => {
  it('assembles the basic shape with no dedupe fields to leak', () => {
    const detail = toPublicDetail(view([member()]));
    expect(detail.opportunityId).toBe('opp-1');
    expect(detail.title).toBe('დიჯითალ კონსულტანტი');
    expect(detail.status).toBe('active');
    expect(detail.type).toBe('job');
    expect(detail.columns).toHaveLength(1);
    // No `observations`, `formerBoards` or `canonicalIsStale` field exists on
    // this type at all — a compile-time guarantee, not a runtime check — but
    // this also confirms the object carries nothing beyond the public shape.
    expect(Object.keys(detail).sort()).toEqual(
      [
        'apply',
        'columns',
        'comparison',
        'crossPosted',
        'descriptions',
        'extras',
        'grouped',
        'opportunityId',
        'status',
        'title',
        'type',
      ].sort(),
    );
  });

  it('excludes a member whose description was omitted by the republish policy, same as one that wrote nothing', () => {
    const detail = toPublicDetail(
      view([
        member({ sourceSlug: 'jobs-ge', description: '' }),
        member({ sourceSlug: 'hr-ge', description: 'a real description' }),
      ]),
    );
    expect(detail.descriptions).toHaveLength(1);
    expect(detail.descriptions[0]?.column.sourceSlug).toBe('hr-ge');
  });

  it('crossPosted counts distinct sources, grouped counts members', () => {
    const single = toPublicDetail(view([member()]));
    expect(single.crossPosted).toBe(false);
    expect(single.grouped).toBe(false);

    const twoBoards = toPublicDetail(
      view([member({ sourceSlug: 'jobs-ge' }), member({ sourceSlug: 'hr-ge' })]),
    );
    expect(twoBoards.crossPosted).toBe(true);
    expect(twoBoards.grouped).toBe(true);

    // Two live listings from the SAME board is a supported cluster shape
    // (see opportunity-detail.ts's own note on this) — grouped, not
    // cross-posted.
    const sameBoardTwice = toPublicDetail(
      view([member({ sourceSlug: 'jobs-ge' }), member({ sourceSlug: 'jobs-ge' })]),
    );
    expect(sameBoardTwice.crossPosted).toBe(false);
    expect(sameBoardTwice.grouped).toBe(true);
  });
});
