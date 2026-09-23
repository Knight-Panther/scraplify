import type { SearchListingsFilters } from '../../src/browse/queries.js';
import { sourceListingStatusEnum } from '../../src/db/schema/source-listings.js';
import { capGraphemes, MAX_TEXT, one, type RawSearchParams, ROW_CHUNK } from './search-params.js';

/**
 * The listings screen's state, held entirely in the URL — same contract as the
 * opportunities screen, and for the same reasons: a filtered view is a plain
 * link, the back button works, and every render is one straight server query.
 *
 * What differs is what a row IS. This screen shows **source listings**, not
 * canonical opportunities, so a vacancy carried by both boards appears twice
 * and each row is what one board actually said. That is the whole point of the
 * screen: the canonical list deliberately hides it.
 *
 * Everything here is untrusted input, validated against the schema's own enums
 * rather than forwarded hopefully — an unrecognised status reaching `inArray`
 * against a Postgres enum column is a query *error*, not an empty result.
 */

/**
 * The concept's named views.
 *
 * Each is a saved question rather than a filter combination someone has to
 * reconstruct: "what is new", "what closes soon", "what has gone missing",
 * "what was held back", "what changed". They are links, so a view is
 * bookmarkable and shareable like everything else here.
 *
 * **Two of them are honestly empty against the current corpus, and that is
 * information rather than a fault.** Nothing is quarantined and no listing has
 * a second revision — every one of the 412 has exactly one — so `held` and
 * `changed` match nothing until a crawl produces something. The screen says
 * which of the two it is rather than showing a blank table, because "no
 * listing has changed since it was first seen" and "this filter is broken"
 * look identical otherwise.
 */
export const VIEWS = [
  {
    value: '',
    label: 'everything',
    blurb: 'Every listing either board has shown us, newest first.',
    empty: 'No listing matches these filters.',
    localOnly: false,
  },
  {
    value: 'new',
    label: 'new',
    blurb: 'First seen in the last 7 days.',
    empty: 'Nothing new in the last 7 days.',
    localOnly: false,
  },
  {
    value: 'closing',
    label: 'closing soon',
    blurb: 'Still open, with a deadline inside the next 7 days.',
    empty: 'Nothing states a deadline inside the next 7 days.',
    localOnly: false,
  },
  {
    value: 'missing',
    label: 'may be gone',
    blurb:
      'Not seen on the last crawl. A suspicion, not a fact — the board may simply have changed how it lists jobs.',
    empty: 'Every listing was seen on its board’s most recent crawl.',
    localOnly: false,
  },
  // `held` and `changed` are both LOCAL-ONLY (Codex, 2026-09-24): `held`'s
  // `statuses: ['quarantined']` can never match anything through the public
  // views (they exclude quarantined rows by construction), and `changed`'s
  // `changedOnly` is forced to zero rows by `publicListingConditions` — so on
  // the public surface either one's real empty-state copy ("Nothing has been
  // held back", "No listing has been edited") would assert a fact about the
  // corpus that isn't true, only that this role cannot see it.
  {
    value: 'held',
    label: 'held back',
    blurb:
      'Something failed to parse cleanly, so the listing is withheld rather than shown as understood.',
    empty: 'Nothing has been held back. No listing has failed to parse.',
    localOnly: true,
  },
  {
    value: 'changed',
    label: 'changed',
    blurb:
      'The board edited the listing after we first captured it. Content changes only — a listing moving between states is not recorded anywhere.',
    empty: 'No listing has been edited since it was first captured.',
    localOnly: true,
  },
] as const;

export type ViewValue = (typeof VIEWS)[number]['value'];
export type View = (typeof VIEWS)[number];

const DAY = 24 * 60 * 60 * 1000;

/** How far ahead "closing soon" and back "new" look. */
const WINDOW_DAYS = 7;

const STATUSES: readonly string[] = sourceListingStatusEnum.enumValues;

export interface ListingQuery {
  /** Ready to hand to `searchListings` / `countListings`. */
  filters: Omit<SearchListingsFilters, 'limit' | 'offset'>;
  view: View;
  /** How many rows this view renders. Grows by ROW_CHUNK via the bottom link. */
  show: number;
  /** The values the form should show — always the accepted ones, never the raw input. */
  form: {
    q: string;
    source: string;
    status: string;
    view: string;
  };
}

/**
 * Filters a named view contributes, on top of the free-form ones.
 *
 * Kept separate from the form values deliberately. A view sets a *window* or a
 * *state*, and the user's own source and text filters compose with it — so
 * "new, on hr.ge, matching ანალიტიკოსი" is one URL rather than a choice
 * between a view and a search.
 */
function viewFilters(view: View, now: number): Omit<SearchListingsFilters, 'limit' | 'offset'> {
  switch (view.value) {
    case 'new':
      return { firstSeenFrom: new Date(now - WINDOW_DAYS * DAY).toISOString() };
    case 'closing':
      // Both bounds, because "closing soon" means still open. Without the
      // lower one it would also return everything whose deadline has already
      // passed, which is the opposite of what the view is for.
      return {
        deadlineFrom: new Date(now).toISOString(),
        deadlineTo: new Date(now + WINDOW_DAYS * DAY).toISOString(),
      };
    case 'missing':
      return { statuses: ['missing_suspected'] };
    case 'held':
      return { statuses: ['quarantined'] };
    case 'changed':
      return { changedOnly: true };
    default:
      return {};
  }
}

export function parseListingQuery(
  raw: RawSearchParams,
  knownSourceSlugs: readonly string[],
  now: number = Date.now(),
): ListingQuery {
  const q = capGraphemes(one(raw.q), MAX_TEXT);

  // An unrecognised slug is a malformed URL, not a filter that legitimately
  // matches nothing — dropping it keeps the select and the result set agreeing.
  const rawSource = one(raw.source);
  const source = knownSourceSlugs.includes(rawSource) ? rawSource : '';

  const rawStatus = one(raw.status);
  const status = STATUSES.includes(rawStatus) ? rawStatus : '';

  const rawView = one(raw.view);
  const view = VIEWS.find((candidate) => candidate.value === rawView) ?? VIEWS[0];

  const rawShow = Number.parseInt(one(raw.show), 10);
  const show =
    Number.isInteger(rawShow) && rawShow > ROW_CHUNK
      ? Math.ceil(rawShow / ROW_CHUNK) * ROW_CHUNK
      : ROW_CHUNK;

  const fromView = viewFilters(view, now);

  return {
    filters: {
      ...fromView,
      text: q === '' ? undefined : q,
      sourceSlug: source === '' ? undefined : source,
      // A view that sets a state wins over the state select, because choosing
      // "may be gone" and then "held back" cannot mean both — and the select
      // is disabled in those views so the two never visibly disagree.
      statuses: fromView.statuses ?? (status === '' ? undefined : [status]),
    },
    view,
    show,
    form: { q, source, status, view: view.value },
  };
}

/** The view's state as a query string, with no leading '?'. */
export function buildListingQueryString(
  query: ListingQuery,
  changes: Partial<{ show: number }> = {},
): string {
  const params = new URLSearchParams();
  if (query.form.q !== '') params.set('q', query.form.q);
  if (query.form.source !== '') params.set('source', query.form.source);
  // Suppressed when the view already fixes the state, so the URL cannot carry
  // a status the results do not reflect.
  if (query.form.status !== '' && query.filters.statuses?.[0] === query.form.status) {
    params.set('status', query.form.status);
  }
  if (query.form.view !== '') params.set('view', query.form.view);

  const show = changes.show ?? query.show;
  if (show > ROW_CHUNK) params.set('show', String(show));

  return params.toString();
}

export function buildListingHref(
  query: ListingQuery,
  changes: Partial<{ show: number }> = {},
): string {
  const search = buildListingQueryString(query, changes);
  return search === '' ? '/listings' : `/listings?${search}`;
}

/** A link to one named view, keeping the text and source filters in place. */
export function viewHref(query: ListingQuery, view: View): string {
  const params = new URLSearchParams();
  if (query.form.q !== '') params.set('q', query.form.q);
  if (query.form.source !== '') params.set('source', query.form.source);
  if (view.value !== '') params.set('view', view.value);
  // Depth deliberately NOT carried: switching views changes what is being
  // looked at, so starting at the top of the new one is what is meant.
  const search = params.toString();
  return search === '' ? '/listings' : `/listings?${search}`;
}
