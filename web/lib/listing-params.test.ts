import { describe, expect, it } from 'vitest';
import { buildListingQueryString, parseListingQuery, VIEWS, viewHref } from './listing-params.js';

/**
 * Every value here arrives from a URL somebody can edit, and one of them is
 * dangerous rather than merely wrong: an unrecognised status reaches `inArray`
 * against a Postgres enum column, where it is a query *error* and not an empty
 * result. So the tests are mostly about what is rejected.
 */

const SLUGS = ['jobs-ge', 'hr-ge'];
// A fixed instant, so the window views assert exact bounds rather than
// "roughly a week ago".
const NOW = Date.parse('2026-09-08T12:00:00.000Z');

describe('parseListingQuery — untrusted input', () => {
  it('drops a status the schema does not define', () => {
    const query = parseListingQuery({ status: 'nonsense' }, SLUGS, NOW);

    expect(query.filters.statuses).toBeUndefined();
    expect(query.form.status).toBe('');
  });

  it('drops a board that does not exist, so the select and the results agree', () => {
    const query = parseListingQuery({ source: 'linkedin' }, SLUGS, NOW);

    expect(query.filters.sourceSlug).toBeUndefined();
    expect(query.form.source).toBe('');
  });

  it('falls back to the default view for an unknown one', () => {
    expect(parseListingQuery({ view: 'invented' }, SLUGS, NOW).view.value).toBe('');
  });

  it('takes the first value when a parameter is repeated', () => {
    expect(parseListingQuery({ source: ['hr-ge', 'jobs-ge'] }, SLUGS, NOW).form.source).toBe(
      'hr-ge',
    );
  });

  /**
   * Georgian characters are multi-byte, and `georgian-typography.md` rule 7
   * forbids index-based truncation of this corpus outright — a half-character
   * would also stop a legitimate query from matching anything.
   */
  it('caps the search text by grapheme, not by code unit', () => {
    const long = 'ანალიტიკოსი'.repeat(40);
    const query = parseListingQuery({ q: long }, SLUGS, NOW);

    expect([
      ...new Intl.Segmenter('ka', { granularity: 'grapheme' }).segment(query.form.q),
    ]).toHaveLength(120);
  });
});

describe('parseListingQuery — the named views', () => {
  it('"new" looks back a week from now', () => {
    const query = parseListingQuery({ view: 'new' }, SLUGS, NOW);

    expect(query.filters.firstSeenFrom).toBe('2026-09-01T12:00:00.000Z');
    expect(query.filters.deadlineTo).toBeUndefined();
  });

  /**
   * Both bounds, and the lower one is the point: without it "closing soon"
   * would also return everything whose deadline has already passed, which is
   * the opposite of what the view is for.
   */
  it('"closing soon" is bounded at both ends, so it means STILL open', () => {
    const query = parseListingQuery({ view: 'closing' }, SLUGS, NOW);

    expect(query.filters.deadlineFrom).toBe('2026-09-08T12:00:00.000Z');
    expect(query.filters.deadlineTo).toBe('2026-09-15T12:00:00.000Z');
  });

  it('maps the state views onto real §13 states', () => {
    expect(parseListingQuery({ view: 'missing' }, SLUGS, NOW).filters.statuses).toEqual([
      'missing_suspected',
    ]);
    expect(parseListingQuery({ view: 'held' }, SLUGS, NOW).filters.statuses).toEqual([
      'quarantined',
    ]);
  });

  it('"changed" asks the query layer for revised listings only', () => {
    expect(parseListingQuery({ view: 'changed' }, SLUGS, NOW).filters.changedOnly).toBe(true);
  });

  /**
   * A view sets a window or a state; the reader's own text and board filters
   * compose with it. "New, on hr.ge, matching ანალიტიკოსი" has to be one URL
   * rather than a choice between a view and a search.
   */
  it('composes a view with the free-form filters', () => {
    const query = parseListingQuery({ view: 'new', source: 'hr-ge', q: 'ანალიტიკოსი' }, SLUGS, NOW);

    expect(query.filters.firstSeenFrom).toBe('2026-09-01T12:00:00.000Z');
    expect(query.filters.sourceSlug).toBe('hr-ge');
    expect(query.filters.text).toBe('ანალიტიკოსი');
  });

  /**
   * "May be gone" and "held back" cannot both be true, so the view wins and
   * the select is disabled — and the URL must not keep a status the results do
   * not reflect, or a shared link would describe a filter that is not applied.
   */
  it('lets a state view override the state select, and drops it from the URL', () => {
    const query = parseListingQuery({ view: 'missing', status: 'active' }, SLUGS, NOW);

    expect(query.filters.statuses).toEqual(['missing_suspected']);
    expect(buildListingQueryString(query)).not.toContain('status=');
  });

  it('keeps the state in the URL when no view overrides it', () => {
    const query = parseListingQuery({ status: 'active' }, SLUGS, NOW);

    expect(query.filters.statuses).toEqual(['active']);
    expect(buildListingQueryString(query)).toContain('status=active');
  });
});

describe('listing links', () => {
  /** Rounded UP, so a hand-edited depth cannot produce fewer rows than are shown. */
  it('rounds a hand-edited depth up to a whole chunk', () => {
    expect(parseListingQuery({ show: '723' }, SLUGS, NOW).show).toBe(1000);
    expect(parseListingQuery({ show: '-5' }, SLUGS, NOW).show).toBe(500);
    expect(parseListingQuery({ show: 'lots' }, SLUGS, NOW).show).toBe(500);
  });

  /**
   * Switching views changes what is being looked at, so the reader starts at
   * the top of the new one — carrying a depth of several thousand rows into a
   * different question is not what "show me what changed" means.
   */
  it('keeps text and board across a view change but not the depth', () => {
    const query = parseListingQuery(
      { view: 'new', q: 'ანალიტიკოსი', source: 'hr-ge', show: '1500' },
      SLUGS,
      NOW,
    );
    const href = viewHref(
      query,
      VIEWS.find((view) => view.value === 'changed') as (typeof VIEWS)[number],
    );

    expect(href).toContain('view=changed');
    expect(href).toContain('source=hr-ge');
    expect(href).not.toContain('show=');
  });

  it('produces a bare path when nothing is set', () => {
    expect(viewHref(parseListingQuery({}, SLUGS, NOW), VIEWS[0])).toBe('/listings');
  });
});
