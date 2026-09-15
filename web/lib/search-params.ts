import type { SearchOpportunitiesFilters } from '../../src/browse/queries.js';
import { opportunityTypeEnum } from '../../src/db/schema/opportunities.js';
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

/** The "closing soon" window — deadline within the next N days from now. */
export const DEADLINE_OPTIONS = [
  { value: '', label: 'any time', days: null },
  { value: '7', label: 'closing in 7 days', days: 7 },
  { value: '30', label: 'closing in 30 days', days: 30 },
] as const;

/** §13 canonical states offered as facet checkboxes, in display order. */
export const STATUS_OPTIONS = [
  'active',
  'missing_suspected',
  'closed',
  'expired',
  'quarantined',
  'discovered',
] as const;

/** §12.3 opportunity types offered as facet checkboxes, in display order. */
export const TYPE_OPTIONS = opportunityTypeEnum.enumValues;

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
    statuses: string[];
    types: string[];
    since: string;
    closing: string;
    crossPosted: boolean;
  };
}

/**
 * Shared with the listings screen, which holds its state in the URL the same
 * way. Exported rather than copied so the two screens cannot drift apart on
 * what counts as a valid parameter — the grapheme cap in particular is a rule
 * about this corpus, not about one screen.
 */
export function one(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return (Array.isArray(value) ? (value[0] ?? '') : value).trim();
}

/**
 * Every value of a repeatable param (`?status=a&status=b`), trimmed and
 * de-duplicated. A single non-array value is treated as one entry, so
 * `?status=a` and `?status=a&status=a` behave the same.
 */
function many(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((v) => v.trim()).filter((v) => v !== ''))];
}

const STATUSES: readonly string[] = sourceListingStatusEnum.enumValues;
const TYPES: readonly string[] = opportunityTypeEnum.enumValues;

/**
 * Text is capped rather than passed through at any length.
 *
 * `searchPattern` wraps it in `%…%` for an `ilike` with no index behind it, so
 * an unbounded string from a URL is a free way to make the database work hard.
 * 120 characters is well past the longest title in the corpus (105).
 */
export const MAX_TEXT = 120;

/**
 * Caps the query at MAX_TEXT *graphemes*.
 *
 * Not `slice`, which counts UTF-16 code units and can cut a character in half —
 * `georgian-typography.md` rule 7 forbids index-based truncation of this corpus
 * outright, and a half-character left in the search box would also stop a
 * legitimate query from matching anything.
 */
const SEGMENTER = new Intl.Segmenter('ka', { granularity: 'grapheme' });

export function capGraphemes(text: string, max: number): string {
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

  // An unrecognised status is dropped rather than forwarded — it would
  // otherwise reach `inArray` against a Postgres enum column, where an
  // unrecognised value is a query ERROR rather than an empty result.
  const statuses = many(raw.status).filter((status) => STATUSES.includes(status));
  const types = many(raw.type).filter((type) => TYPES.includes(type));

  const rawSince = one(raw.since);
  const since = SINCE_OPTIONS.find((option) => option.value === rawSince) ?? SINCE_OPTIONS[0];

  const rawClosing = one(raw.closing);
  const closing =
    DEADLINE_OPTIONS.find((option) => option.value === rawClosing) ?? DEADLINE_OPTIONS[0];

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
      statuses: statuses.length === 0 ? undefined : statuses,
      types: types.length === 0 ? undefined : types,
      crossPostedOnly: crossPosted ? true : undefined,
      firstSeenFrom:
        since.days === null
          ? undefined
          : new Date(now - since.days * 24 * 60 * 60 * 1000).toISOString(),
      ...(closing.days === null
        ? {}
        : {
            deadlineFrom: new Date(now).toISOString(),
            deadlineTo: new Date(now + closing.days * 24 * 60 * 60 * 1000).toISOString(),
          }),
    },
    sort,
    show,
    form: { q, source, statuses, types, since: since.value, closing: closing.value, crossPosted },
  };
}

/**
 * The view's state as a query string, with no leading '?'.
 *
 * Extracted from buildHref because the detail screen needs the same string for
 * a different purpose: a row links to /opportunities/{id}?back={this}, so the
 * back link returns to the filtered, sorted, grown list the reader came from
 * rather than to a bare /opportunities that silently drops all of it.
 */
export interface QueryChanges {
  sort?: Sort;
  show?: number;
  /** Overrides individual fields of `query.form` — used to drop one filter. */
  form?: Partial<OpportunityQuery['form']>;
}

export function buildQueryString(query: OpportunityQuery, changes: QueryChanges = {}): string {
  const form = { ...query.form, ...changes.form };

  const params = new URLSearchParams();
  if (form.q !== '') params.set('q', form.q);
  if (form.source !== '') params.set('source', form.source);
  for (const status of form.statuses) params.append('status', status);
  for (const type of form.types) params.append('type', type);
  if (form.since !== '') params.set('since', form.since);
  if (form.closing !== '') params.set('closing', form.closing);
  if (form.crossPosted) params.set('cross', '1');

  const sort = changes.sort ?? query.sort;
  if (sort !== 'recent') params.set('sort', sort);

  const show = changes.show ?? query.show;
  if (show > ROW_CHUNK) params.set('show', String(show));

  return params.toString();
}

/**
 * A link to the same view with the sort, depth, or one filter field changed.
 *
 * The depth rides along on a sort change: someone who has grown the list to
 * 2,000 rows and then re-sorts means to re-sort what they are looking at, not
 * to be dropped back to the first 500.
 */
export function buildHref(query: OpportunityQuery, changes: QueryChanges): string {
  const search = buildQueryString(query, changes);
  return search === '' ? '/opportunities' : `/opportunities?${search}`;
}

export interface AppliedFilter {
  key: string;
  label: string;
  /** This view with exactly this filter cleared — everything else survives. */
  href: string;
}

/**
 * One removable chip per active filter, for the sticky bar's applied-filter
 * row. `sourceSlugLabel` and `statusLabel` are injected rather than imported
 * from `labels.ts` here, so this file stays free of a dependency on the
 * schema-derived label maps.
 */
export function appliedFilters(
  query: OpportunityQuery,
  sourceSlugLabel: (slug: string) => string,
  statusLabel: (status: string) => string,
  typeLabel: (type: string) => string,
): AppliedFilter[] {
  const { form } = query;
  const chips: AppliedFilter[] = [];

  if (form.q !== '') {
    chips.push({ key: 'q', label: `"${form.q}"`, href: buildHref(query, { form: { q: '' } }) });
  }
  if (form.source !== '') {
    chips.push({
      key: 'source',
      label: sourceSlugLabel(form.source),
      href: buildHref(query, { form: { source: '' } }),
    });
  }
  for (const status of form.statuses) {
    chips.push({
      key: `status:${status}`,
      label: statusLabel(status),
      href: buildHref(query, {
        form: { statuses: form.statuses.filter((s) => s !== status) },
      }),
    });
  }
  for (const type of form.types) {
    chips.push({
      key: `type:${type}`,
      label: typeLabel(type),
      href: buildHref(query, { form: { types: form.types.filter((t) => t !== type) } }),
    });
  }
  if (form.since !== '') {
    const option = SINCE_OPTIONS.find((o) => o.value === form.since);
    chips.push({
      key: 'since',
      label: `first seen: ${option?.label ?? form.since}`,
      href: buildHref(query, { form: { since: '' } }),
    });
  }
  if (form.closing !== '') {
    const option = DEADLINE_OPTIONS.find((o) => o.value === form.closing);
    chips.push({
      key: 'closing',
      label: option?.label ?? form.closing,
      href: buildHref(query, { form: { closing: '' } }),
    });
  }
  if (form.crossPosted) {
    chips.push({
      key: 'cross',
      label: 'on both boards',
      href: buildHref(query, { form: { crossPosted: false } }),
    });
  }

  return chips;
}
