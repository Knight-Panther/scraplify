import { describe, expect, it } from 'vitest';
import { appliedFilters, buildHref, parseOpportunityQuery, ROW_CHUNK } from './search-params.js';

const SLUGS = ['jobs-ge', 'hr-ge'];
const NOW = Date.parse('2026-09-07T12:00:00.000Z');

describe('parseOpportunityQuery', () => {
  it('returns an unfiltered query for an empty URL', () => {
    const query = parseOpportunityQuery({}, SLUGS, NOW);
    expect(query.filters).toEqual({
      text: undefined,
      sourceSlug: undefined,
      statuses: undefined,
      crossPostedOnly: undefined,
      firstSeenFrom: undefined,
    });
    expect(query.sort).toBe('recent');
  });

  /**
   * The one that matters: an unrecognised status reaches `inArray` against a
   * Postgres enum column, where it is a query ERROR rather than an empty
   * result. A hand-edited URL must not be able to 500 the screen.
   */
  it('drops a status the schema does not define', () => {
    const query = parseOpportunityQuery({ status: 'definitely_not_a_status' }, SLUGS, NOW);
    expect(query.filters.statuses).toBeUndefined();
    expect(query.form.statuses).toEqual([]);
  });

  it('keeps a status the schema does define', () => {
    const query = parseOpportunityQuery({ status: 'missing_suspected' }, SLUGS, NOW);
    expect(query.filters.statuses).toEqual(['missing_suspected']);
  });

  it('accepts more than one status — a real filter, not "first wins"', () => {
    const query = parseOpportunityQuery({ status: ['active', 'closed'] }, SLUGS, NOW);
    expect(query.filters.statuses).toEqual(['active', 'closed']);
    expect(query.form.statuses).toEqual(['active', 'closed']);
  });

  it('drops only the unrecognised status out of a mixed set', () => {
    const query = parseOpportunityQuery({ status: ['active', 'not_a_status'] }, SLUGS, NOW);
    expect(query.filters.statuses).toEqual(['active']);
  });

  it('de-duplicates a repeated status', () => {
    const query = parseOpportunityQuery({ status: ['active', 'active'] }, SLUGS, NOW);
    expect(query.filters.statuses).toEqual(['active']);
  });

  it('drops a source slug that no source uses', () => {
    expect(
      parseOpportunityQuery({ source: 'linkedin' }, SLUGS, NOW).filters.sourceSlug,
    ).toBeUndefined();
    expect(parseOpportunityQuery({ source: 'hr-ge' }, SLUGS, NOW).filters.sourceSlug).toBe('hr-ge');
  });

  it('caps search text rather than forwarding an unbounded ilike pattern', () => {
    const query = parseOpportunityQuery({ q: 'ა'.repeat(500) }, SLUGS, NOW);
    expect(query.filters.text).toHaveLength(120);
  });

  /**
   * The cap counts graphemes, not UTF-16 code units. Cutting by index can leave
   * a lone surrogate or an orphaned combining mark, which both damages what the
   * search box shows back and stops a legitimate query from matching.
   */
  it('never cuts a character in half when capping', () => {
    // Each of these is one grapheme made of more than one code unit.
    const twoUnits = '😀';
    const combining = 'é';
    for (const grapheme of [twoUnits, combining]) {
      const text = grapheme.repeat(300);
      const capped = parseOpportunityQuery({ q: text }, SLUGS, NOW).filters.text ?? '';
      expect(capped).toBe(grapheme.repeat(120));
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(capped),
      ).toBe(false);
    }
  });

  it('leaves text at or under the cap untouched', () => {
    expect(parseOpportunityQuery({ q: 'მენეჯერი' }, SLUGS, NOW).filters.text).toBe('მენეჯერი');
  });

  it('treats a repeated single-value parameter as its first value', () => {
    // Unlike `status`, `source` is still single-select.
    const query = parseOpportunityQuery({ source: ['hr-ge', 'jobs-ge'] }, SLUGS, NOW);
    expect(query.filters.sourceSlug).toBe('hr-ge');
  });

  it('resolves "closing" against the supplied instant, not the wall clock', () => {
    const query = parseOpportunityQuery({ closing: '7' }, SLUGS, NOW);
    expect(query.filters.deadlineFrom).toBe('2026-09-07T12:00:00.000Z');
    expect(query.filters.deadlineTo).toBe('2026-09-14T12:00:00.000Z');
  });

  it('ignores a "closing" value that is not one of the offered options', () => {
    const query = parseOpportunityQuery({ closing: '9999' }, SLUGS, NOW);
    expect(query.filters.deadlineFrom).toBeUndefined();
    expect(query.filters.deadlineTo).toBeUndefined();
  });

  it('resolves "since" against the supplied instant, not the wall clock', () => {
    const query = parseOpportunityQuery({ since: '7' }, SLUGS, NOW);
    expect(query.filters.firstSeenFrom).toBe('2026-08-31T12:00:00.000Z');
  });

  it('ignores a "since" value that is not one of the offered options', () => {
    expect(
      parseOpportunityQuery({ since: '9999' }, SLUGS, NOW).filters.firstSeenFrom,
    ).toBeUndefined();
  });

  it('ignores a page parameter left over from a bookmarked URL', () => {
    // There is no pagination; a stale ?page=4 must not change what is shown.
    const paged = parseOpportunityQuery({ page: '4' }, SLUGS, NOW);
    expect(paged).toEqual(parseOpportunityQuery({}, SLUGS, NOW));
    expect(buildHref(paged, {})).toBe('/opportunities');
  });

  it('ignores an unknown sort', () => {
    expect(parseOpportunityQuery({ sort: 'salary' }, SLUGS, NOW).sort).toBe('recent');
    expect(parseOpportunityQuery({ sort: 'deadline' }, SLUGS, NOW).sort).toBe('deadline');
  });

  it('only sets crossPostedOnly when it is actually on', () => {
    expect(parseOpportunityQuery({ cross: '1' }, SLUGS, NOW).filters.crossPostedOnly).toBe(true);
    expect(
      parseOpportunityQuery({ cross: '0' }, SLUGS, NOW).filters.crossPostedOnly,
    ).toBeUndefined();
  });
});

describe('buildHref', () => {
  it('omits every default, so an unfiltered view has a clean URL', () => {
    expect(buildHref(parseOpportunityQuery({}, SLUGS, NOW), {})).toBe('/opportunities');
  });

  it('carries the active filters into a sort change', () => {
    const query = parseOpportunityQuery({ q: 'მენეჯერი', source: 'hr-ge', cross: '1' }, SLUGS, NOW);
    const href = buildHref(query, { sort: 'deadline' });
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('q')).toBe('მენეჯერი');
    expect(params.get('source')).toBe('hr-ge');
    expect(params.get('cross')).toBe('1');
    expect(params.get('sort')).toBe('deadline');
  });

  it('never emits a page parameter, because there is no pagination', () => {
    const query = parseOpportunityQuery({ q: 'x', sort: 'title' }, SLUGS, NOW);
    for (const href of [buildHref(query, {}), buildHref(query, { sort: 'deadline' })]) {
      expect(href).not.toContain('page=');
    }
  });
});

describe('show depth', () => {
  it('starts at one chunk', () => {
    expect(parseOpportunityQuery({}, SLUGS, NOW).show).toBe(ROW_CHUNK);
  });

  it('accepts a deeper view', () => {
    expect(parseOpportunityQuery({ show: '1000' }, SLUGS, NOW).show).toBe(1000);
  });

  /**
   * A hand-edited depth is rounded UP to a whole chunk. Rounding down would
   * render fewer rows than the URL asked for, and the "show more" link would
   * then offer a depth already on screen.
   */
  it('rounds a partial depth up to a whole chunk', () => {
    expect(parseOpportunityQuery({ show: '723' }, SLUGS, NOW).show).toBe(1000);
    expect(parseOpportunityQuery({ show: '501' }, SLUGS, NOW).show).toBe(1000);
  });

  it.each([['0'], ['-5'], ['abc'], [''], ['500'], ['1.5']])(
    'falls back to one chunk for %j',
    (show) => {
      expect(parseOpportunityQuery({ show }, SLUGS, NOW).show).toBe(ROW_CHUNK);
    },
  );

  /**
   * No terminal depth. A fixed ceiling is the bug this screen had twice: past
   * it, "show more" renders a link that parses back to the ceiling and does
   * nothing. The page clamps against the real total instead, so the control
   * disappears exactly when there is nothing left to show.
   */
  it('has no ceiling of its own, however deep the URL asks', () => {
    expect(parseOpportunityQuery({ show: '999999' }, SLUGS, NOW).show).toBe(1000000);
    expect(parseOpportunityQuery({ show: '50000' }, SLUGS, NOW).show).toBe(50000);
  });

  it('can express a depth past the whole known corpus of ~8,900', () => {
    expect(parseOpportunityQuery({ show: '9000' }, SLUGS, NOW).show).toBe(9000);
  });

  it('omits the default depth from the URL but carries a deeper one', () => {
    const shallow = parseOpportunityQuery({}, SLUGS, NOW);
    expect(buildHref(shallow, {})).toBe('/opportunities');
    expect(buildHref(shallow, { show: 1000 })).toBe('/opportunities?show=1000');
  });

  /**
   * Someone who has grown the list to 2,000 rows and then re-sorts means to
   * re-sort what they are looking at, not to be dropped back to the first 500.
   */
  it('keeps the depth when the sort changes', () => {
    const deep = parseOpportunityQuery({ show: '2000' }, SLUGS, NOW);
    const href = buildHref(deep, { sort: 'title' });
    expect(new URLSearchParams(href.split('?')[1]).get('show')).toBe('2000');
  });
});

describe('appliedFilters', () => {
  const sourceSlugLabel = (slug: string) => (slug === 'hr-ge' ? 'hr.ge' : slug);
  const statusLabel = (status: string) => status;
  const typeLabel = (type: string) => type;

  it('is empty for an unfiltered view', () => {
    const query = parseOpportunityQuery({}, SLUGS, NOW);
    expect(appliedFilters(query, sourceSlugLabel, statusLabel, typeLabel)).toEqual([]);
  });

  it('emits one chip per active filter, each clearing only itself', () => {
    const query = parseOpportunityQuery(
      { q: 'მენეჯერი', source: 'hr-ge', status: ['active', 'closed'], cross: '1' },
      SLUGS,
      NOW,
    );
    const chips = appliedFilters(query, sourceSlugLabel, statusLabel, typeLabel);
    expect(chips.map((c) => c.key)).toEqual([
      'q',
      'source',
      'status:active',
      'status:closed',
      'cross',
    ]);

    const statusChip = chips.find((c) => c.key === 'status:active');
    const params = new URLSearchParams(statusChip?.href.split('?')[1]);
    // Removing one status leaves the query text, source, other status, and
    // cross-posted flag all in place.
    expect(params.getAll('status')).toEqual(['closed']);
    expect(params.get('q')).toBe('მენეჯერი');
    expect(params.get('source')).toBe('hr-ge');
    expect(params.get('cross')).toBe('1');
  });
});
