import type { SearchOpportunitiesFilters } from '../../src/browse/queries.js';
import { sourceListingStatusEnum } from '../../src/db/schema/source-listings.js';

/**
 * The opportunities screen's state, held entirely in the URL.
 *
 * No client component, no React state: a filtered view is a plain link, the
 * back button works, and a view worth returning to can be bookmarked. That is
 * worth more on a screen someone opens daily than any interactive nicety, and
 * it keeps every page render a straight server query.
 *
 * Everything here is untrusted input. A status arriving from a hand-edited URL
 * reaches `inArray` against a Postgres enum column, where an unrecognised value
 * is a query error rather than an empty result — so values are validated
 * against the schema's own enum instead of being forwarded hopefully.
 */

export const SORTS = ['recent', 'deadline', 'title'] as const;
export type Sort = (typeof SORTS)[number];

/** "What appeared since I last looked", the actual daily-triage question. */
export const SINCE_OPTIONS = [
  { value: '', label: 'any time', days: null },
  { value: '1', label: 'last 24 hours', days: 1 },
  { value: '7', label: 'last 7 days', days: 7 },
  { value: '30', label: 'last 30 days', days: 30 },
] as const;

/**
 * One growing list rather than numbered pages.
 *
 * This is a scanning tool: one continuous scroll and the browser's own
 * find-in-page beat clicking through pages, and with no page boundary there is
 * no boundary for a sort tie to straddle — none of the three sort keys is
 * unique, so LIMIT/OFFSET paging can otherwise duplicate and drop rows.
 *
 * But the list must still reach everything. The database holds 406
 * opportunities only because no full-coverage crawl has run yet; jobs.ge
 * carries ~5,647 listings and hr.ge ~3,265, so a fixed cap would hide most of
 * the corpus the day a real crawl completes. Instead the view starts at one
 * chunk and a link at the bottom grows it by another, carrying the depth in the
 * URL — no page numbers, no client JavaScript, and nothing unreachable.
 */
export const ROW_CHUNK = 500;

/**
 * There is deliberately NO maximum depth.
 *
 * A fixed ceiling — 500, then 10,000 — is the bug this screen has now had
 * twice: past it, "show more" renders a link that parses back to the ceiling
 * and does nothing, which is worse than stopping honestly. The only bound that
 * is not arbitrary is the number of rows that actually match, so the page
 * clamps against the real total and the control disappears exactly when there
 * is nothing left to show.
 */

/** Raw `searchParams`, exactly as Next hands it over. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

export interface OpportunityQuery {
  /** Ready to hand to `searchOpportunities` / `countOpportunities`. */
  filters: Omit<SearchOpportunitiesFilters, 'limit' | 'offset' | 'sort'>;
  sort: Sort;
  /** How many rows this view renders. Grows by ROW_CHUNK via the bottom link. */
  show: number;
  /** The values the form should show — always the accepted ones, never the raw input. */
  form: {
    q: string;
    source: string;
    status: string;
    since: string;
    crossPosted: boolean;
  };
}

function one(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return (Array.isArray(value) ? (value[0] ?? '') : value).trim();
}

const STATUSES: readonly string[] = sourceListingStatusEnum.enumValues;

/**
 * Text is capped rather than passed through at any length.
 *
 * `searchPattern` wraps it in `%…%` for an `ilike` with no index behind it, so
 * an unbounded string from a URL is a free way to make the database work hard.
 * 120 characters is well past the longest title in the corpus (105).
 */
const MAX_TEXT = 120;

/**
 * Caps the query at MAX_TEXT *graphemes*.
 *
 * Not `slice`, which counts UTF-16 code units and can cut a character in half —
 * `georgian-typography.md` rule 7 forbids index-based truncation of this corpus
 * outright, and a half-character left in the search box would also stop a
 * legitimate query from matching anything.
 */
const SEGMENTER = new Intl.Segmenter('ka', { granularity: 'grapheme' });

function capGraphemes(text: string, max: number): string {
  if (text.length <= max) return text; // Code units are an upper bound on graphemes.
  let out = '';
  let taken = 0;
  for (const { segment } of SEGMENTER.segment(text)) {
    if (taken === max) break;
    out += segment;
    taken += 1;
  }
  return out;
}

export function parseOpportunityQuery(
  raw: RawSearchParams,
  knownSourceSlugs: readonly string[],
  now: number = Date.now(),
): OpportunityQuery {
  const q = capGraphemes(one(raw.q), MAX_TEXT);

  // An unrecognised slug is a malformed URL, not a filter that legitimately
  // matches nothing — dropping it keeps the select and the result set agreeing.
  const rawSource = one(raw.source);
  const source = knownSourceSlugs.includes(rawSource) ? rawSource : '';

  const rawStatus = one(raw.status);
  const status = STATUSES.includes(rawStatus) ? rawStatus : '';

  const rawSince = one(raw.since);
  const since = SINCE_OPTIONS.find((option) => option.value === rawSince) ?? SINCE_OPTIONS[0];

  const crossPosted = one(raw.cross) === '1';

  const rawSort = one(raw.sort);
  const sort: Sort = (SORTS as readonly string[]).includes(rawSort) ? (rawSort as Sort) : 'recent';

  // Rounded UP to a whole chunk so a hand-edited ?show=723 cannot produce a
  // 'show more' link that would return fewer rows than are already on screen.
  const parsedShow = Number.parseInt(one(raw.show), 10);
  const show =
    Number.isInteger(parsedShow) && parsedShow > ROW_CHUNK
      ? Math.ceil(parsedShow / ROW_CHUNK) * ROW_CHUNK
      : ROW_CHUNK;

  return {
    filters: {
      text: q === '' ? undefined : q,
      sourceSlug: source === '' ? undefined : source,
      statuses: status === '' ? undefined : [status],
      crossPostedOnly: crossPosted ? true : undefined,
      firstSeenFrom:
        since.days === null
          ? undefined
          : new Date(now - since.days * 24 * 60 * 60 * 1000).toISOString(),
    },
    sort,
    show,
    form: { q, source, status, since: since.value, crossPosted },
  };
}

/**
 * A link to the same view with the sort or the depth changed.
 *
 * The depth rides along on a sort change: someone who has grown the list to
 * 2,000 rows and then re-sorts means to re-sort what they are looking at, not
 * to be dropped back to the first 500.
 */
export function buildHref(
  query: OpportunityQuery,
  changes: Partial<{ sort: Sort; show: number }>,
): string {
  const params = new URLSearchParams();
  if (query.form.q !== '') params.set('q', query.form.q);
  if (query.form.source !== '') params.set('source', query.form.source);
  if (query.form.status !== '') params.set('status', query.form.status);
  if (query.form.since !== '') params.set('since', query.form.since);
  if (query.form.crossPosted) params.set('cross', '1');

  const sort = changes.sort ?? query.sort;
  if (sort !== 'recent') params.set('sort', sort);

  const show = changes.show ?? query.show;
  if (show > ROW_CHUNK) params.set('show', String(show));

  const search = params.toString();
  return search === '' ? '/opportunities' : `/opportunities?${search}`;
}
