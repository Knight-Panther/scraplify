import {
  countOpportunities,
  getSourceHealth,
  searchOpportunities,
} from '../../../../src/browse/queries.js';
import { db } from '../../../../src/db/client.js';
import { StatusChip } from '../../../components/status-chip.js';
import {
  absoluteTime,
  count,
  relativeTime,
  sourceDate,
  sourceDateTime,
} from '../../../lib/format.js';
import { listingStatusLabel, opportunityTypeLabel, sourceLabel } from '../../../lib/labels.js';
import { type OpportunityRow, toRow } from '../../../lib/opportunity-row.js';
import {
  buildHref,
  buildQueryString,
  type OpportunityQuery,
  type RawSearchParams,
  ROW_CHUNK,
  SINCE_OPTIONS,
  SORTS,
  parseOpportunityQuery,
} from '../../../lib/search-params.js';

/**
 * The deduplicated list — the screen someone opens daily and scans.
 *
 * It lives in a `(list)` route group, which changes no URL and exists for one
 * reason: `loading.tsx` applies to a segment AND everything nested under it,
 * so while this file sat directly in `opportunities/`, its loading fallback
 * wrapped `opportunities/[id]` too. That fallback starts streaming the
 * response, and once streaming starts the status code is already sent — so the
 * detail screen's `notFound()` rendered its page under a 200, telling every
 * client that a stale link had resolved fine. The group scopes this screen's
 * loading UI to this screen. (next/docs: "Status Codes", loading.mdx.)
 *
 * Two decisions shape everything here.
 *
 * **A table, not cards.** 406 rows are scanned repeatedly; cards cost vertical
 * space and destroy the column alignment that makes scanning work. Titles are
 * short (median 22 characters), so the title column is narrow rather than a
 * display heading.
 *
 * **State lives in the URL, not in React.** No client component, no hydration:
 * a filtered view is a link, the back button works, and every render is one
 * straight server query. See `search-params.ts`.
 *
 * Absent fields are simply absent. jobs.ge states no employer on many listings
 * and no salary on any, so a row must never show an empty slot or a column of
 * dashes — "this source does not have that field" is the normal case here.
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
  const filtered = Object.values(query.form).some((value) => value !== '' && value !== false);
  // More matches exist than are rendered. Never silent: the bottom of the list
  // says so and offers the next chunk.
  const more = total - rows.length;
  // Built once and handed to every row: the filters and sort a reader is
  // looking at, so the detail screen can bring them back here unchanged.
  const back = buildQueryString(query);

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">Opportunities</h1>
        <p className="mt-1 max-w-[var(--measure)] text-sm text-faint">
          One row per vacancy, with the boards that carry it. A vacancy posted to both appears once.
        </p>
      </header>

      <Filters query={query} slugs={slugs} />

      <div className="mt-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="text-sm text-muted">
          {total === 0 ? (
            'Nothing matches.'
          ) : (
            <>
              <span className="numeric text-foreground">{count(total)}</span>{' '}
              {total === 1 ? 'opportunity' : 'opportunities'}
            </>
          )}
        </p>
        <SortControl query={query} />
      </div>

      {rows.length === 0 ? (
        <EmptyState filtered={filtered} />
      ) : (
        <>
          <ResultsTable rows={rows} sort={query.sort} back={back} />
          <ShowMore query={query} shown={rows.length} more={more} />
        </>
      )}
    </main>
  );
}

/**
 * Reads `count` rows in ROW_CHUNK-sized queries.
 *
 * Batched rather than one big query so the shared query layer keeps its
 * original 500-row bound: raising that guard to suit one screen was the wrong
 * direction, and it only moved the ceiling rather than removing it. Sequential
 * because the batches are cheap and only a user who has clicked "show more"
 * repeatedly pays for more than one.
 *
 * Safe under OFFSET only because every ordering ends in `opportunities.id`.
 * Without that tie-breaker Postgres may order tied rows differently per query,
 * and adjacent batches would overlap and skip — the corpus has 174
 * opportunities sharing a single deadline.
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
 * A plain GET form. Submitting rewrites the URL, which is the whole state of
 * the screen — so there is nothing to keep in sync and no JavaScript involved.
 * `sort` rides along as a hidden field because it belongs to the view rather
 * than to the filter set, and losing it on every search would be surprising.
 */
function Filters({ query, slugs }: { query: OpportunityQuery; slugs: readonly string[] }) {
  return (
    <form
      method="get"
      action="/opportunities"
      className="mt-6 rounded-[var(--radius)] border border-border bg-surface px-4 py-4"
    >
      <input type="hidden" name="sort" value={query.sort} />
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <Field label="Search" htmlFor="q" className="min-w-[14rem] flex-1">
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={query.form.q}
            // Deliberately no maxLength: the attribute counts UTF-16 code
            // units, so it would cut a multi-unit character in half. The cap
            // is applied server-side by grapheme instead.
            // Spellcheck off because the corpus is Georgian: an English
            // dictionary underlines every real query as a mistake.
            spellCheck={false}
            autoComplete="off"
            placeholder="Search titles…"
            className="w-full rounded-[var(--radius)] border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-faint"
          />
        </Field>

        <Field label="Board" htmlFor="source">
          <Select id="source" name="source" defaultValue={query.form.source}>
            <option value="">any</option>
            {slugs.map((slug) => (
              <option key={slug} value={slug}>
                {sourceLabel(slug)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="State" htmlFor="status">
          <Select id="status" name="status" defaultValue={query.form.status}>
            <option value="">any</option>
            {['active', 'missing_suspected', 'closed', 'expired', 'quarantined', 'discovered'].map(
              (status) => (
                <option key={status} value={status}>
                  {listingStatusLabel(status).short}
                </option>
              ),
            )}
          </Select>
        </Field>

        <Field label="First seen" htmlFor="since">
          <Select id="since" name="since" defaultValue={query.form.since}>
            {SINCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <label className="flex items-center gap-2 pb-1.5 text-sm">
          <input
            type="checkbox"
            name="cross"
            value="1"
            defaultChecked={query.form.crossPosted}
            className="size-4 accent-[var(--color-accent-strong)]"
          />
          <span title="Only vacancies that more than one board carries.">On both boards</span>
        </label>

        <div className="flex items-center gap-3 pb-0.5">
          <button
            type="submit"
            className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 text-sm hover:bg-surface-active"
          >
            Apply
          </button>
          <a className="text-sm text-faint hover:text-foreground" href="/opportunities">
            Clear
          </a>
        </div>
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label className="block text-xs text-faint" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/**
 * A native select, with both colours stated explicitly — Windows dark mode
 * otherwise paints the popup list with its own foreground colour and leaves the
 * options unreadable against ours.
 *
 * `w-full max-w-52` is load-bearing, not cosmetic: a native select sizes itself
 * to its widest OPTION and ignores the flex container it sits in, so the board
 * filter grew to 392px on the widest slug and pushed the whole page 69px past a
 * 375px viewport. The listings screen was capped for this in Stage 7; this one
 * was not, which is the same defect one screen over. The cap is deliberately on
 * the control rather than on unknown slugs — hiding those would paper over the
 * stranded test sources with a UI change, and any genuinely long board name
 * would reintroduce this.
 */
function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className="w-full max-w-52 rounded-[var(--radius)] border border-border bg-background px-2 py-1.5 text-sm text-foreground"
    />
  );
}

/**
 * Sort as links rather than as clickable column headers.
 *
 * Two of the three orderings are columns hidden on a narrow screen, so header
 * links would make sorting unreachable there. Links also keep the whole screen
 * navigable without JavaScript.
 */
function SortControl({ query }: { query: OpportunityQuery }) {
  return (
    <nav aria-label="Sort" className="flex flex-wrap items-baseline gap-x-1 text-sm">
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
                ? 'rounded-[var(--radius)] bg-surface-active px-2 py-0.5 text-foreground'
                : 'rounded-[var(--radius)] px-2 py-0.5 text-muted hover:bg-surface hover:text-foreground'
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
 * `table-fixed` with a declared width per column, and both are load-bearing.
 *
 * Auto layout sized the columns from each page's own content, so a column moved
 * as you paged through — the opposite of what a table is for. It also left the
 * title cell wider than the text inside it while truncating titles early, and
 * at 390px it simply overflowed: the board and state columns went off-screen
 * and the title ran off the edge instead of ellipsizing, because `truncate`
 * needs a definite width to act on.
 *
 * The widths change at each breakpoint because the visible columns do, and they
 * are declared on the header cells so the whole table follows one source.
 */
function ResultsTable({
  rows,
  sort,
  back,
}: {
  rows: OpportunityRow[];
  sort: OpportunityQuery['sort'];
  back: string;
}) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-sm leading-[var(--leading-body)]">
        <thead>
          <tr className="border-b border-border text-left text-xs text-faint">
            {/* The visible columns must total exactly 100% at EVERY
                breakpoint. They came to 102% at lg, which over-constrains a
                fixed-layout full-width table and can force a scrollbar inside
                the results wrapper. Per breakpoint, visible columns are:
                  base  66 + 34                        = 100
                  sm    52 + 24 + 24                   = 100
                  md    40 + 20 + 13 + 13 + 14         = 100
                  lg    34 + 20 + 12 + 12 + 11 + 11    = 100
                  xl    40 + 24 + 14 +  8 +  7 +  7    = 100
                xl exists because the table now fills the window: at 1920px the
                short columns would otherwise be given 200px each to hold the
                word "open", while titles truncated. */}
            <Th
              className="w-[66%] sm:w-[52%] md:w-[40%] lg:w-[34%] xl:w-[40%]"
              aria-sort={sort === 'title' ? 'ascending' : 'none'}
            >
              Opportunity
            </Th>
            <Th className="hidden md:table-cell md:w-[20%] xl:w-[24%]">Employer</Th>
            <Th className="w-[34%] sm:w-[24%] md:w-[13%] lg:w-[12%] xl:w-[14%]">Board</Th>
            <Th className="hidden sm:table-cell sm:w-[24%] md:w-[13%] lg:w-[12%] xl:w-[8%]">
              State
            </Th>
            <Th
              // Wide enough that "in 26 days" never wraps. It did at md, and a
              // wrapping date column added a second line to EVERY row.
              className="hidden md:table-cell md:w-[14%] lg:w-[11%] xl:w-[7%]"
              aria-sort={sort === 'deadline' ? 'ascending' : 'none'}
            >
              Closes
            </Th>
            <Th
              className="hidden lg:table-cell lg:w-[11%] xl:w-[7%]"
              aria-sort={sort === 'recent' ? 'descending' : 'none'}
            >
              First seen
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <Row key={row.opportunityId} row={row} position={index + 1} back={back} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className, ...rest }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th scope="col" className={`py-1.5 pr-4 font-normal ${className ?? ''}`} {...rest}>
      {children}
    </th>
  );
}

function Row({
  row,
  position,
  back,
}: {
  row: OpportunityRow;
  position: number;
  /** This view's query string, so the detail screen can link back to it. */
  back: string;
}) {
  const type = row.type === 'job' ? null : opportunityTypeLabel(row.type);
  // Only the view's state travels. Where to land on the way back is the
  // opportunity's own id, which the detail screen already knows — see its
  // BackLink for why a position could not be trusted.
  const href = `/opportunities/${row.opportunityId}?${new URLSearchParams({ back })}`;

  return (
    // Two anchors, because they answer different questions. The opportunity
    // id is stable across crawls and is where the detail screen returns a
    // reader to. The positional one is what "show more" targets: it is
    // computed against the very page it lands on, where position is exactly
    // what is meant.
    <tr
      id={`opp-${row.opportunityId}`}
      className="border-b border-border align-baseline hover:bg-surface"
    >
      <td className="py-1.5 pr-4">
        <span id={`row-${position}`} />
        {/* The title is the link, not a separate "view" affordance: it is the
            largest target in the row and the thing a reader is already aiming
            at. A plain <a> for the reason site-nav.tsx gives — <Link> would
            prefetch on hover, turning idle pointer movement across a list of
            several thousand rows into that many database queries. */}
        <a
          href={href}
          className="block truncate text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-accent"
          title={row.title}
        >
          {row.title}
        </a>
        {/* Everything the narrower breakpoints drop reappears here, so nothing
            a triager needs is unreachable on a phone. Each piece hides at the
            width where its own column comes back. */}
        <NarrowMeta row={row} />
        {type !== null && (
          <span className="mt-0.5 inline-block text-xs text-accent" title={type.explanation}>
            {type.short}
          </span>
        )}
      </td>

      <td className="hidden py-1.5 pr-4 text-muted md:table-cell">
        {row.employers.length === 0 ? null : (
          <span className="block truncate" title={row.employers.join(' · ')}>
            {row.employers.join(' · ')}
          </span>
        )}
      </td>

      <td className="py-1.5 pr-4">
        <SourceLinks row={row} />
      </td>

      <td className="hidden py-1.5 pr-4 sm:table-cell">
        <StatusChip status={row.status} />
      </td>

      <td className="hidden py-1.5 pr-4 md:table-cell">
        <Deadline row={row} />
      </td>

      <td className="hidden py-1.5 pr-4 text-muted lg:table-cell">
        {row.firstSeen === null ? null : (
          <time dateTime={row.firstSeen} title={absoluteTime(row.firstSeen)}>
            {relativeTime(row.firstSeen)}
          </time>
        )}
      </td>
    </tr>
  );
}

/**
 * State, employer and closing date, each shown only at the widths where its own
 * column is hidden. State drops out of the table earliest because it is the
 * shortest to restate here and the least tolerant of a 100px column.
 */
function NarrowMeta({ row }: { row: OpportunityRow }) {
  return (
    <span className="mt-0.5 block text-xs text-faint md:hidden">
      <span className="sm:hidden">
        <StatusChip status={row.status} />
        {(row.employers.length > 0 || row.deadline !== null) && ' · '}
      </span>
      <NarrowMetaText row={row} />
    </span>
  );
}

function NarrowMetaText({ row }: { row: OpportunityRow }) {
  const parts: React.ReactNode[] = [];
  if (row.employers.length > 0) parts.push(<span key="employer">{row.employers.join(' · ')}</span>);
  if (row.deadline !== null) {
    parts.push(
      <span key="deadline">
        <time className="numeric" dateTime={row.deadline} title={sourceDateTime(row.deadline)}>
          closes {sourceDate(row.deadline)}
        </time>
        {/* The conflict marker belongs here too. Every cross-posted cluster in
            the corpus disagrees about its closing date, so a narrow screen
            without this shows one board's date as if both had stated it. */}
        {row.deadlinesDisagree && (
          <span
            className="text-status-unconfirmed"
            title="The boards state different closing dates. The later one is shown."
          >
            {' '}
            (boards differ)
          </span>
        )}
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: separators, not data
        <span key={index}>
          {index > 0 && ' · '}
          {part}
        </span>
      ))}
    </>
  );
}

/**
 * A link per board, which is also how cross-posting is shown: two links means
 * two boards carry this vacancy, and that is the product's whole premise.
 *
 * When a board's own listing state differs from the cluster's, that state is
 * printed next to the link as VISIBLE text rather than left in a tooltip. It
 * matters here more than it sounds: every cross-posted cluster in the corpus is
 * currently active on jobs.ge and `missing_suspected` on hr.ge, so a row whose
 * single "State" cell reads "open" is telling only half the truth — and a
 * tooltip is unavailable on touch and unreliable for keyboard users, which is
 * to say unavailable to most of the people who would need it.
 */
function SourceLinks({ row }: { row: OpportunityRow }) {
  if (row.sources.length === 0) {
    return <span className="text-faint">no live listing</span>;
  }
  return (
    <span className="flex flex-col gap-y-1">
      {row.sources.map((source) => {
        const differs = source.status !== row.status;
        return (
          <span key={source.sourceSlug} className="flex flex-wrap items-baseline gap-x-1.5">
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              // A board name is an identifier, not prose; machine translation
              // mangles "jobs.ge" into something that no longer names anything.
              translate="no"
              aria-label={`${row.title} on ${sourceLabel(source.sourceSlug)}${
                differs ? `, ${listingStatusLabel(source.status).short} on this board` : ''
              } (opens in a new tab)`}
              className="text-accent underline underline-offset-2 hover:text-foreground"
            >
              {sourceLabel(source.sourceSlug)}
            </a>
            {differs && (
              <span
                className="text-xs text-status-unconfirmed"
                title={listingStatusLabel(source.status).explanation}
              >
                {listingStatusLabel(source.status).short}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

function Deadline({ row }: { row: OpportunityRow }) {
  if (row.deadline === null) return null;
  return (
    <>
      {/* The board's calendar date, not "in 3 hours". jobs.ge states a date
          with no time and the adapter stores it as Tbilisi local midnight, so
          a relative rendering counts down within the very day the board named
          as the deadline — asserting a precision the source never gave, and
          making a still-actionable listing read as nearly gone. The detail
          screen was fixed for this; the list kept the old rendering. */}
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
    <p className="mt-3 rounded-[var(--radius)] border border-border bg-surface px-4 py-6 text-sm text-muted">
      {filtered ? (
        <>
          No opportunity matches these filters.{' '}
          <a className="text-accent underline underline-offset-2" href="/opportunities">
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
 * screen's state already lives. Nothing here is a page number — the next chunk
 * is appended to the same continuous list.
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
      {/* Anchored at the first newly revealed row. A plain link would return
          the reader to the top of a list they had just scrolled to the bottom
          of, which on a scanning screen makes the control nearly useless. */}
      <a
        className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 hover:bg-surface-active"
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
