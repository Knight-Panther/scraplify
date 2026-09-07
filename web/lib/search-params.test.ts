import { describe, expect, it } from 'vitest';
import { buildHref, parseOpportunityQuery, ROW_CAP } from './search-params.js';

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
    expect(query.form.status).toBe('');
  });

  it('keeps a status the schema does define', () => {
    const query = parseOpportunityQuery({ status: 'missing_suspected' }, SLUGS, NOW);
    expect(query.filters.statuses).toEqual(['missing_suspected']);
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

  it('treats a repeated parameter as its first value', () => {
    const query = parseOpportunityQuery({ status: ['active', 'closed'] }, SLUGS, NOW);
    expect(query.filters.statuses).toEqual(['active']);
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

describe('ROW_CAP', () => {
  it('stays within the query layer’s own MAX_LIMIT', () => {
    expect(ROW_CAP).toBeLessThanOrEqual(500);
  });

  it('covers the whole corpus, so the cap notice stays unreachable for now', () => {
    expect(ROW_CAP).toBeGreaterThan(406);
  });
});
