import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ListingView, OpportunityView } from '../../src/browse/queries.js';
import { toRow } from './opportunity-row.js';

function member(overrides: Partial<ListingView> = {}): ListingView {
  return {
    sourceListingId: randomUUID(),
    sourceSlug: 'jobs-ge',
    status: 'active',
    title: 'ფინანსური ანალიტიკოსი',
    organization: 'თიბისი ბანკი',
    canonicalUrl: 'https://jobs.ge/ge/?view=jobs&id=1',
    publishedAt: null,
    deadlineAt: null,
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-07T00:00:00.000Z',
    applicationMethod: null,
    ...overrides,
  };
}

function opportunity(members: ListingView[]): OpportunityView {
  return {
    opportunityId: 'opp-1',
    canonicalTitle: 'ფინანსური ანალიტიკოსი',
    canonicalStatus: 'active',
    type: 'job',
    members,
  };
}

describe('toRow', () => {
  /**
   * The two orderings the SQL uses. If these drift, the column the user just
   * sorted on renders in an order that contradicts its own header.
   */
  it('takes the LATEST deadline, matching LATEST_OPEN_MEMBER_DEADLINE', () => {
    const row = toRow(
      opportunity([
        member({ deadlineAt: '2026-09-20T00:00:00.000Z' }),
        member({ sourceSlug: 'hr-ge', deadlineAt: '2026-10-05T00:00:00.000Z' }),
      ]),
    );
    expect(row.deadline).toBe('2026-10-05T00:00:00.000Z');
  });

  it('takes the EARLIEST first-seen, matching EARLIEST_MEMBER_FIRST_SEEN', () => {
    const row = toRow(
      opportunity([
        member({ firstSeenAt: '2026-09-04T00:00:00.000Z' }),
        member({ sourceSlug: 'hr-ge', firstSeenAt: '2026-08-28T00:00:00.000Z' }),
      ]),
    );
    expect(row.firstSeen).toBe('2026-08-28T00:00:00.000Z');
  });

  /**
   * Both boards' text is preserved because each may carry facts the other
   * lacks. A disagreement about the closing date is exactly that, and showing
   * one number silently would assert something neither source said.
   */
  it('flags a deadline the two sources disagree about', () => {
    const row = toRow(
      opportunity([
        member({ deadlineAt: '2026-09-20T00:00:00.000Z' }),
        member({ sourceSlug: 'hr-ge', deadlineAt: '2026-10-05T00:00:00.000Z' }),
      ]),
    );
    expect(row.deadlinesDisagree).toBe(true);
  });

  it('does not flag agreement, nor a single stated deadline', () => {
    const same = '2026-09-20T00:00:00.000Z';
    expect(
      toRow(
        opportunity([
          member({ deadlineAt: same }),
          member({ sourceSlug: 'hr-ge', deadlineAt: same }),
        ]),
      ).deadlinesDisagree,
    ).toBe(false);
    expect(
      toRow(opportunity([member({ deadlineAt: same }), member({ sourceSlug: 'hr-ge' })]))
        .deadlinesDisagree,
    ).toBe(false);
  });

  it('reports no deadline rather than inventing one', () => {
    const row = toRow(opportunity([member(), member({ sourceSlug: 'hr-ge' })]));
    expect(row.deadline).toBeNull();
    expect(row.deadlinesDisagree).toBe(false);
  });

  it('collapses a repeated employer name but keeps two genuinely different ones', () => {
    expect(
      toRow(
        opportunity([member({ organization: 'თიბისი ბანკი' }), member({ sourceSlug: 'hr-ge' })]),
      ).employers,
    ).toEqual(['თიბისი ბანკი']);
    expect(
      toRow(
        opportunity([
          member({ organization: 'თიბისი ბანკი' }),
          member({ sourceSlug: 'hr-ge', organization: 'TBC Bank' }),
        ]),
      ).employers,
    ).toEqual(['თიბისი ბანკი', 'TBC Bank']);
  });

  /** jobs.ge has no employer on some listings. An absent field is normal here. */
  it('omits an absent or blank employer instead of leaving a slot for it', () => {
    expect(toRow(opportunity([member({ organization: null })])).employers).toEqual([]);
    expect(toRow(opportunity([member({ organization: '   ' })])).employers).toEqual([]);
  });

  it('lists one link per source, not one per member', () => {
    const row = toRow(
      opportunity([
        member({ canonicalUrl: 'https://jobs.ge/a' }),
        member({ canonicalUrl: 'https://jobs.ge/b' }),
      ]),
    );
    expect(row.sources).toHaveLength(1);
    expect(row.crossPosted).toBe(false);
  });

  it('marks an opportunity backed by two boards as cross-posted', () => {
    const row = toRow(
      opportunity([member(), member({ sourceSlug: 'hr-ge', canonicalUrl: 'https://hr.ge/1' })]),
    );
    expect(row.sources.map((source) => source.sourceSlug)).toEqual(['jobs-ge', 'hr-ge']);
    expect(row.crossPosted).toBe(true);
  });

  it('survives a cluster whose members have all been detached', () => {
    const row = toRow(opportunity([]));
    expect(row.sources).toEqual([]);
    expect(row.firstSeen).toBeNull();
    expect(row.crossPosted).toBe(false);
  });
});
