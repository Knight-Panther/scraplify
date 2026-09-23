import {
  countOpportunities,
  getSourceHealth,
  searchOpportunities,
} from '../../../../../src/browse/queries.js';
import { db } from '../../../../../src/db/client.js';
import { decisionsByOpportunity } from '../../../../../src/shortlist/decisions.js';
import { DecisionControl } from '../../../../components/decision-control.js';
import { StatusChip } from '../../../../components/status-chip.js';
import {
  absoluteTime,
  count,
  relativeTime,
  sourceDate,
  sourceDateTime,
} from '../../../../lib/format.js';
import { listingStatusLabel, opportunityTypeLabel, sourceLabel } from '../../../../lib/labels.js';
import { type OpportunityRow, toRow } from '../../../../lib/opportunity-row.js';
import { lastCompletedSync } from '../../../../lib/sync.js';
import {
  appliedFilters,
  buildHref,
  buildQueryString,
  type OpportunityQuery,
  parseOpportunityQuery,
  type RawSearchParams,
  ROW_CHUNK,
  SORTS,
} from '../../../../lib/search-params.js';
import { FacetRail } from './facet-rail.js';
import { StickyFilterBar } from './sticky-filter-bar.js';

/**
 * The deduplicated list — the screen someone opens daily and scans.
 *
 * It lives in a `(list)` route group, which changes no URL and exists for one
 * reason: `loading.tsx` applies to a segment AND everything nested under it,
 * so while this file sat directly in `opportunities/`, its loading fallback
 * wrapped `opportunities/[id]` too. See the detail screen's `notFound()` note
 * in git history for why that matters. The group scopes this screen's loading
 * UI to this screen. (next/docs: "Status Codes", loading.mdx.)
 *
 * **State lives in the URL, not in React.** Every filter — search text,
 * board, state, first-seen window, deadline window, cross-posted — is one
 * `<form method="get">` covering the sticky search row and the facet rail
 * together, so a filtered view is still a plain link, the back button still
 * works, and every render is one straight server query. The only client
 * JavaScript on this screen is presentational: the sticky bar's scroll
 * collapse (`sticky-filter-bar.tsx`) and the mobile filter sheet, which uses
 * the native Popover API and needs none at all.
 *
 * Absent fields are simply absent. jobs.ge states no employer on many
 * listings and no salary on any, so a row must never show an empty slot or a
 * column of dashes — "this source does not have that field" is the normal
 * case here.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Opportunities · Xtelo' };

const SORT_LABELS: Record<(typeof SORTS)[number], { label: string; hint: string }> = {
  recent: {
    label: 'newest first',
    hint: 'By when the vacancy first appeared on any source — not by when this record was last touched.',
  },
  deadline: { label: 'closing soonest', hint: 'By the latest deadline any source states.' },
  title: { label: 'by title', hint: 'Alphabetical.' },
};

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;

  // The source list comes from the database rather than a hardcoded pair, so
  // adding a third board does not leave a filter silently missing it.
  const health = await getSourceHealth(db);
  const slugs = health.map((source) => source.sourceSlug);

  const query = parseOpportunityQuery(raw, slugs);

  const total = await countOpportunities(db, query.filters);
  // Clamped to what actually matches, so "how deep can this list go" has no
  // arbitrary answer — it goes as deep as there are rows.
  const opportunities = await fetchRows(query, Math.min(query.show, total));

  const rows = opportunities.map(toRow);
  const decisions = await decisionsByOpportunity(
    db,
    rows.map((row) => row.opportunityId),
  );

  // More matches exist than are rendered. Never silent: the bottom of the
  // list says so and offers the next chunk.
  const more = total - rows.length;
  // Built once and handed to every row: the filters and sort a reader is
  // looking at, so the detail screen can bring them back here unchanged.
  const back = buildQueryString(query);

  const chips = appliedFilters(
    query,
    sourceLabel,
    (status) => listingStatusLabel(status).short,
    (type) => opportunityTypeLabel(type).short,
  );
  const activeFacetCount =
    (query.form.source === '' ? 0 : 1) +
    query.form.statuses.length +
    query.form.types.length +
    (query.form.since === '' ? 0 : 1) +
    (query.form.closing === '' ? 0 : 1) +
    (query.form.crossPosted ? 1 : 0);

  const lastSync = lastCompletedSync(health);

  // A real id rather than a nested <form>: the results table below contains
  // its own per-row write forms (DecisionControl's Save/Dismiss/Undo), and
  // nesting a form inside a form is invalid HTML — a browser may reparent or
  // discard the inner one, which would make Save/Dismiss submit this GET
  // form instead of invoking their server action. FacetRail's own inputs
  // live inside the grid below, outside this form's DOM subtree, and
  // associate with it via `form={FILTER_FORM_ID}` on each one instead.
  const FILTER_FORM_ID = 'opportunities-filters';

  return (
    <main className="w-full">
      <form id={FILTER_FORM_ID} method="get" action="/opportunities">
        <input type="hidden" name="sort" value={query.sort} />

        <StickyFilterBar
          title={
            <div className="px-4 sm:px-0">
              <p className="numeric text-xs text-[var(--color-browse-accent)] uppercase">
                {/* `tracking-*` on a <p> is dead: globals.css's unlayered
                    `p { letter-spacing: normal }` (added for Georgian
                    headings) beats Tailwind's layered utility regardless of
                    specificity — confirmed in the compiled stylesheet, not
                    assumed. Carried on this inner span instead, same fix
                    applied throughout the Phase 3E landing hero. */}
                <span className="tracking-[0.1em]">
                  {slugs.map(sourceLabel).join(' + ')}
                  {lastSync !== undefined && <> · synced {relativeTime(lastSync)}</>}
                </span>
              </p>
              <h1 className="mt-1 font-[family-name:var(--font-display)] text-6xl leading-[0.9] text-white uppercase">
                Browse
              </h1>
              <p className="mt-2 max-w-[var(--measure)] text-sm text-faint">
                One row per vacancy with the boards that carry it. A vacancy posted to both appears
                once.
              </p>
            </div>
          }
          search={
            <div className="flex flex-wrap items-center gap-3 px-4 sm:px-0">
              <label className="relative min-w-[12rem] flex-1">
                <span className="sr-only">Search</span>
                <input
                  name="q"
                  type="search"
                  defaultValue={query.form.q}
                  // Deliberately no maxLength: the attribute counts UTF-16
                  // code units, so it would cut a multi-unit character in
                  // half. The cap is applied server-side by grapheme instead.
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="title or employer…"
                  className="h-[46px] w-full rounded-[var(--radius)] border border-border bg-surface px-3 text-sm text-foreground placeholder:text-faint"
                />
              </label>

              <button
                type="submit"
                className="h-[46px] rounded-[var(--radius)] bg-[var(--color-browse-accent)] px-5 text-sm font-bold text-[var(--color-browse-ink)] hover:bg-[var(--color-browse-accent-hover)]"
              >
                Apply
              </button>

              <button
                type="button"
                popoverTarget="mobile-filters"
                className="h-[46px] min-w-[92px] rounded-[var(--radius)] border border-border bg-surface px-4 text-sm hover:bg-surface-raised lg:hidden"
              >
                Filters{activeFacetCount > 0 && ` ${activeFacetCount}`}
              </button>

              <SortControl query={query} />
            </div>
          }
          chips={
            <div className="flex flex-wrap items-center gap-3 px-4 sm:px-0">
              {chips.length > 0 && (
                <>
                  <span className="text-xs text-faint">Applied</span>
                  {chips.map((chip) => (
                    <a
                      key={chip.key}
                      href={chip.href}
                      className="flex items-center gap-1.5 rounded-full border border-border-control px-3 py-1 text-xs text-muted hover:border-[var(--color-browse-accent)] hover:text-[var(--color-browse-accent)]"
                    >
                      {chip.label}
                      <XIcon />
                    </a>
                  ))}
                  <a
                    href="/opportunities"
                    className="text-xs text-[var(--color-browse-accent)] hover:underline"
                  >
                    Clear all
                  </a>
                </>
              )}
              <p className="numeric ml-auto text-xs text-faint">
                <span className="text-[var(--color-browse-accent)]">{count(total)}</span>{' '}
                {total === 1 ? 'match' : 'matches'}
              </p>
            </div>
          }
        />
      </form>

      <div className="grid lg:grid-cols-[276px_minmax(0,1fr)]">
        <FacetRail query={query} slugs={slugs} formId={FILTER_FORM_ID} />

        <div className="min-w-0 px-4 py-6 sm:px-6">
          {rows.length === 0 ? (
            <EmptyState filtered={chips.length > 0 || query.form.q !== ''} />
          ) : (
            <>
              <ResultsTable rows={rows} decisions={decisions} back={back} />
              <ShowMore query={query} shown={rows.length} more={more} />
            </>
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * Reads `count` rows in ROW_CHUNK-sized queries.
 *
 * Batched rather than one big query so the shared query layer keeps its
 * original 500-row bound. Safe under OFFSET only because every ordering ends
 * in `opportunities.id` — without that tie-breaker Postgres may order tied
 * rows differently per query, and adjacent batches would overlap and skip.
 */
async function fetchRows(query: OpportunityQuery, count: number) {
  const collected = [];
  for (let offset = 0; offset < count; offset += ROW_CHUNK) {
    const batch = await searchOpportunities(db, {
      ...query.filters,
      sort: query.sort,
      limit: Math.min(ROW_CHUNK, count - offset),
      offset,
    });
    collected.push(...batch);
    if (batch.length === 0) break;
  }
  return collected;
}

/**
 * Sort as links rather than a submitted control, so choosing one applies
 * immediately without a round trip through the Apply button — and keeps the
 * whole screen navigable without JavaScript.
 */
function SortControl({ query }: { query: OpportunityQuery }) {
  return (
    <nav aria-label="Sort" className="flex items-baseline gap-x-1 text-sm">
      <span className="text-faint">Sort</span>
      {SORTS.map((sort) => {
        const active = sort === query.sort;
        return (
          <a
            key={sort}
            href={buildHref(query, { sort })}
            aria-current={active ? 'true' : undefined}
            title={SORT_LABELS[sort].hint}
            className={
              active
                ? 'rounded-[var(--radius)] bg-[var(--color-browse-accent)] px-2 py-1 font-semibold text-[var(--color-browse-ink)]'
                : 'rounded-[var(--radius)] px-2 py-1 text-muted hover:bg-surface hover:text-foreground'
            }
          >
            {SORT_LABELS[sort].label}
          </a>
        );
      })}
    </nav>
  );
}

/**
 * Desktop rows, mobile cards, in one `<table>`.
 *
 * A real table, not styled `<div>`s: `data-density.md` asks for the row
 * primitive here, and it is what gives the row/column semantics a screen
 * reader needs. The card look below `lg` comes from hiding the header and
 * letting each cell stack full-width — same DOM, no second markup to keep in
 * sync.
 */
function ResultsTable({
  rows,
  decisions,
  back,
}: {
  rows: OpportunityRow[];
  decisions: Map<string, { decision: 'saved' | 'dismissed'; note: string | null }>;
  back: string;
}) {
  return (
    <table className="block w-full border-collapse text-sm lg:table lg:table-fixed">
      <thead className="hidden lg:table-header-group">
        <tr className="border-b border-border text-left text-xs text-faint">
          <Th className="w-[46%]">Opportunity</Th>
          <Th className="w-[18%]">Boards</Th>
          <Th className="w-[14%]">Closes</Th>
          <Th className="w-[22%]" />
        </tr>
      </thead>
      <tbody className="block lg:table-row-group">
        {rows.map((row, index) => (
          <Row
            key={row.opportunityId}
            row={row}
            position={index + 1}
            decision={decisions.get(row.opportunityId) ?? null}
            back={back}
          />
        ))}
      </tbody>
    </table>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={`py-2 pr-4 font-normal ${className ?? ''}`}>
      {children}
    </th>
  );
}

function Row({
  row,
  position,
  decision,
  back,
}: {
  row: OpportunityRow;
  /** 1-based position in the current result set, for `ShowMore`'s scroll anchor. */
  position: number;
  decision: { decision: 'saved' | 'dismissed'; note: string | null } | null;
  /** This view's query string, so the detail screen can link back to it. */
  back: string;
}) {
  const type = row.type === 'job' ? null : opportunityTypeLabel(row.type);
  const href = `/opportunities/${row.opportunityId}?${new URLSearchParams({ back })}`;

  return (
    <tr
      id={`opp-${row.opportunityId}`}
      className="group block border-b border-border py-4 align-top hover:bg-surface-raised/60 lg:table-row lg:py-0"
    >
      {/* A second, positional id on the first cell rather than the row's own
          `opp-<id>` id: the detail screen's back-link depends on that one
          (`opportunities/[id]/page.tsx`'s `#opp-<id>` anchor) and cannot be
          repurposed, but `ShowMore` below needs to jump to "row N" before it
          knows which opportunity will land there. */}
      <td id={`row-${position}`} className="block py-1 pr-4 lg:table-cell lg:py-4">
        <p className="numeric flex items-center gap-2 text-xs text-faint">
          <StatusChip status={row.status} />
          {row.firstSeen !== null && (
            <time dateTime={row.firstSeen} title={absoluteTime(row.firstSeen)}>
              first seen {relativeTime(row.firstSeen)}
            </time>
          )}
        </p>
        <a
          href={href}
          className="mt-1 block font-medium text-foreground hover:text-[var(--color-browse-accent)]"
        >
          {row.title}
        </a>
        {row.employers.length > 0 && (
          <p className="mt-0.5 truncate text-muted" title={row.employers.join(' · ')}>
            {row.employers.join(' · ')}
          </p>
        )}
        {type !== null && (
          <span
            className="mt-1 inline-block text-xs text-[var(--color-browse-accent)]"
            title={type.explanation}
          >
            {type.short}
          </span>
        )}
      </td>

      <td className="block py-1 pr-4 lg:table-cell lg:py-4 lg:align-top">
        <SourceLinks row={row} />
      </td>

      <td className="block py-1 pr-4 lg:table-cell lg:py-4 lg:align-top">
        <Deadline row={row} />
      </td>

      <td className="block py-2 lg:table-cell lg:py-4 lg:align-top lg:opacity-35 lg:transition-[opacity,transform] lg:duration-150 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100 lg:[transform:translateX(6px)] lg:group-hover:[transform:translateX(0)] lg:group-focus-within:[transform:translateX(0)]">
        <DecisionControl
          opportunityId={row.opportunityId}
          decision={decision?.decision ?? null}
          note={decision?.note ?? null}
        />
      </td>
    </tr>
  );
}

/**
 * A link per board, which is also how cross-posting is shown: two links means
 * two boards carry this vacancy. When a board's own listing state differs
 * from the cluster's, that state is printed next to the link as visible text
 * rather than left in a tooltip, which is unavailable on touch.
 */
function SourceLinks({ row }: { row: OpportunityRow }) {
  if (row.sources.length === 0) {
    return <span className="text-xs text-faint">no live listing</span>;
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {row.sources.map((source) => {
        const differs = source.status !== row.status;
        return (
          <a
            key={source.sourceSlug}
            href={source.url}
            target="_blank"
            rel="noreferrer"
            // A board name is an identifier, not prose; machine translation
            // mangles "jobs.ge" into something that no longer names anything.
            translate="no"
            aria-label={`${row.title} on ${sourceLabel(source.sourceSlug)}${
              differs ? `, ${listingStatusLabel(source.status).short} on this board` : ''
            } (opens in a new tab)`}
            title={differs ? listingStatusLabel(source.status).explanation : undefined}
            className="numeric rounded-full border border-border-control px-2.5 py-1 text-xs text-muted hover:border-[var(--color-browse-accent)] hover:text-[var(--color-browse-accent)]"
          >
            {sourceLabel(source.sourceSlug)}
            {differs && ` · ${listingStatusLabel(source.status).short}`}
          </a>
        );
      })}
    </span>
  );
}

function Deadline({ row }: { row: OpportunityRow }) {
  if (row.deadline === null) return <span className="text-faint">—</span>;
  return (
    <>
      {/* The board's calendar date, not "in 3 hours" — jobs.ge states a date
          with no time, so a relative rendering would assert a precision the
          source never gave. */}
      <time className="numeric" dateTime={row.deadline} title={sourceDateTime(row.deadline)}>
        {sourceDate(row.deadline)}
      </time>
      {row.deadlinesDisagree && (
        <span
          className="mt-0.5 block text-xs text-status-unconfirmed"
          title="The boards state different closing dates. The later one is shown."
        >
          boards differ
        </span>
      )}
    </>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <p className="rounded-[var(--radius)] border border-border bg-surface px-4 py-6 text-sm text-muted">
      {filtered ? (
        <>
          No opportunity matches these filters.{' '}
          <a
            className="text-[var(--color-browse-accent)] underline underline-offset-2"
            href="/opportunities"
          >
            Clear them
          </a>{' '}
          to see everything.
        </>
      ) : (
        'There are no opportunities yet. They appear once a crawl has run and listings have been grouped.'
      )}
    </p>
  );
}

/**
 * The bottom of the list: what is on screen, what is not, and a link to more.
 *
 * A link rather than a button, so it works without JavaScript, opens in a new
 * tab on middle-click, and leaves the depth in the URL where the rest of this
 * screen's state already lives.
 */
function ShowMore({
  query,
  shown,
  more,
}: {
  query: OpportunityQuery;
  shown: number;
  more: number;
}) {
  if (more <= 0) return null;
  const next = Math.min(query.show + ROW_CHUNK, shown + more);

  return (
    <div className="mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-sm">
      <a
        className="block rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-2.5 text-center hover:bg-surface-active sm:inline-block"
        href={`${buildHref(query, { show: next })}#row-${shown + 1}`}
      >
        Show <span className="numeric">{count(Math.min(ROW_CHUNK, more))}</span> more
      </a>
      <p className="text-faint">
        <span className="numeric">{count(shown)}</span> of{' '}
        <span className="numeric">{count(shown + more)}</span> shown
      </p>
    </div>
  );
}

function XIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
      <path
        d="M1 1l9 9M10 1l-9 9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
