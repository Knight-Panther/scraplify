import {
  publicCountListings,
  publicSearchListings,
  publicSourceOverview,
} from '../../../../src/browse/public-queries.js';
import { countListings, getSourceHealth, searchListings } from '../../../../src/browse/queries.js';
import { db } from '../../../../src/db/client.js';
import { StatusChip } from '../../../components/status-chip.js';
import {
  absoluteTime,
  count,
  relativeTime,
  sourceDate,
  sourceDateTime,
} from '../../../lib/format.js';
import { listingStatusLabels, sourceLabel } from '../../../lib/labels.js';
import {
  buildListingHref,
  type ListingQuery,
  parseListingQuery,
  VIEWS,
  viewHref,
} from '../../../lib/listing-params.js';
import { type RawSearchParams, ROW_CHUNK } from '../../../lib/search-params.js';
import { currentSurface, type Surface } from '../../../lib/surface.js';
import type { ListingView } from '../../../../src/browse/queries.js';

/**
 * The raw per-source view — what each board actually said.
 *
 * The opportunities screen answers "which vacancies exist"; this one answers
 * "what did jobs.ge publish", which the canonical view deliberately hides. So
 * a row here is a **listing**, not a cluster: a vacancy carried by both boards
 * appears twice, once per board, and that duplication is the information
 * rather than a defect to collapse.
 *
 * It exists because the canonical view is a *claim*. When a grouping looks
 * wrong, or a board's own state looks wrong, this is where the unmerged record
 * can be read — which is also why it carries the same lifecycle vocabulary and
 * never softens it.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Listings · Xtelo' };

export default async function ListingsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const surface = currentSurface();

  // From the database rather than a hardcoded pair, so adding a third board
  // does not leave a filter silently missing it. Surface-aware for the same
  // reason as /opportunities: getSourceHealth reads crawl-run diagnostics the
  // public database role has no grant on (Phase 8B Stage 4).
  const slugs =
    surface === 'public'
      ? (await publicSourceOverview(db)).map((s) => s.sourceSlug)
      : (await getSourceHealth(db)).map((s) => s.sourceSlug);

  const query = parseListingQuery(raw, slugs);

  // `held` and `changed` are local-only views (Codex, 2026-09-24): on the
  // public surface neither can ever return a row (the public views exclude
  // quarantined listings by construction, and `changedOnly` is forced to
  // zero by `publicListingConditions`), so their real empty-state copy would
  // assert a fact about the corpus rather than about what this role can see.
  // Reached only via a hand-typed `?view=held`/`?view=changed` URL, since
  // `Views` below no longer links to either for `surface === 'public'`.
  const viewUnavailable = surface === 'public' && query.view.localOnly;

  const total = viewUnavailable
    ? 0
    : surface === 'public'
      ? await publicCountListings(db, query.filters)
      : await countListings(db, query.filters);
  const rows = viewUnavailable ? [] : await fetchRows(surface, query, Math.min(query.show, total));
  const more = total - rows.length;
  const filtered = query.form.q !== '' || query.form.source !== '' || query.form.status !== '';

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">Listings</h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          One row per listing, exactly as its board published it — so a vacancy on both boards
          appears twice. The{' '}
          <a className="text-accent underline underline-offset-2" href="/opportunities">
            opportunities
          </a>{' '}
          screen is the merged view; this is the record behind it.
        </p>
      </header>

      <Views query={query} surface={surface} />
      <Filters query={query} slugs={slugs} />

      {viewUnavailable ? (
        <UnavailableView view={query.view.label} />
      ) : (
        <>
          <p className="mt-4 text-sm text-faint">
            <span className="numeric">{count(total)}</span>
            {total === 1 ? ' listing' : ' listings'}
            {query.view.value !== '' && ` · ${query.view.blurb}`}
          </p>

          {rows.length === 0 ? (
            <EmptyState query={query} filtered={filtered} />
          ) : (
            <ResultsTable rows={rows} />
          )}
        </>
      )}

      <ShowMore query={query} shown={rows.length} more={more} />
    </main>
  );
}

/**
 * Read in chunks, so the query layer keeps its own MAX_LIMIT of 500 rather
 * than being raised to suit one screen. Safe under OFFSET only because the
 * ordering ends in `sourceListings.id`.
 */
async function fetchRows(
  surface: Surface,
  query: ListingQuery,
  wanted: number,
): Promise<ListingView[]> {
  const rows: ListingView[] = [];
  for (let offset = 0; offset < wanted; offset += ROW_CHUNK) {
    const filters = { ...query.filters, limit: Math.min(ROW_CHUNK, wanted - offset), offset };
    const batch =
      surface === 'public'
        ? await publicSearchListings(db, filters)
        : await searchListings(db, filters);
    rows.push(...batch);
    if (batch.length === 0) break;
  }
  return rows;
}

/**
 * The named views, as links rather than a client-side tab control.
 *
 * `aria-current="page"` rather than styling alone, so which view is active is
 * announced and not merely visible.
 */
function Views({ query, surface }: { query: ListingQuery; surface: Surface }) {
  // `held`/`changed` link nowhere useful on the public surface — see
  // `listing-params.ts`'s `localOnly` comment.
  const views = surface === 'public' ? VIEWS.filter((view) => !view.localOnly) : VIEWS;
  return (
    <nav aria-label="Views" className="mt-6">
      <ul className="flex flex-wrap gap-x-1 gap-y-2 text-sm">
        {views.map((view) => {
          const active = view.value === query.view.value;
          return (
            <li key={view.value || 'all'}>
              <a
                href={viewHref(query, view)}
                aria-current={active ? 'page' : undefined}
                title={view.blurb}
                className={
                  active
                    ? 'block rounded-[var(--radius)] border border-border-strong bg-surface-active px-3 py-1'
                    : 'block rounded-[var(--radius)] border border-transparent px-3 py-1 text-muted hover:bg-surface hover:text-foreground'
                }
              >
                {view.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * A plain GET form: no JavaScript, and the URL it produces is the same one a
 * link would produce.
 *
 * The state select is disabled inside a view that already fixes the state.
 * Leaving it enabled would let someone pick "held back" while the "may be
 * gone" view was active, and one of the two would silently win.
 */
function Filters({ query, slugs }: { query: ListingQuery; slugs: readonly string[] }) {
  const stateFixedByView = query.view.value === 'missing' || query.view.value === 'held';

  return (
    <form method="get" action="/listings" className="mt-4 flex flex-wrap items-end gap-3">
      {query.form.view !== '' && <input type="hidden" name="view" value={query.form.view} />}

      <label className="flex min-w-0 flex-col gap-1 text-xs text-faint">
        Search
        <input
          type="search"
          name="q"
          defaultValue={query.form.q}
          // No maxLength: the attribute counts UTF-16 code units and would cut
          // a Georgian character in half. The cap is applied server-side by
          // grapheme instead. Spellcheck off because the corpus is Georgian —
          // an English dictionary underlines every real query as a mistake.
          spellCheck={false}
          autoComplete="off"
          placeholder="title or employer…"
          className="w-full max-w-56 rounded-[var(--radius)] border border-border bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-faint"
        />
      </label>

      <label className="flex min-w-0 flex-col gap-1 text-xs text-faint">
        Board
        <select
          name="source"
          defaultValue={query.form.source}
          className="w-full max-w-52 rounded-[var(--radius)] border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
        >
          <option value="">any board</option>
          {slugs.map((slug) => (
            <option key={slug} value={slug}>
              {sourceLabel(slug)}
            </option>
          ))}
        </select>
      </label>

      <label className="flex min-w-0 flex-col gap-1 text-xs text-faint">
        State
        <select
          name="status"
          defaultValue={stateFixedByView ? '' : query.form.status}
          disabled={stateFixedByView}
          title={
            stateFixedByView ? `The “${query.view.label}” view already fixes the state.` : undefined
          }
          className="w-full max-w-52 rounded-[var(--radius)] border border-border bg-surface px-3 py-1.5 text-sm text-foreground disabled:border-nontext disabled:text-nontext"
        >
          <option value="">any state</option>
          {/* Derived from the label map rather than written out here. A second
              hand-maintained copy of the §13 vocabulary is exactly how a state
              ends up spelled two ways, and `labels.ts` is typed against the
              Drizzle enum so a new state is a typecheck failure there rather
              than a silently missing option here. */}
          {Object.entries(listingStatusLabels).map(([value, label]) => (
            <option key={value} value={value} title={label.explanation}>
              {label.short}
            </option>
          ))}
        </select>
      </label>

      <button
        type="submit"
        className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 text-sm hover:bg-surface-active"
      >
        Apply
      </button>
      <a
        className="py-1.5 text-sm text-accent underline underline-offset-2"
        href={viewHref({ ...query, form: { ...query.form, q: '', source: '' } }, query.view)}
      >
        Clear
      </a>
    </form>
  );
}

function ResultsTable({ rows }: { rows: ListingView[] }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-sm leading-[var(--leading-body)]">
        <thead>
          <tr className="border-b border-border text-left text-xs text-faint">
            <Th className="w-[48%] sm:w-[38%] md:w-[32%] xl:w-[34%]">Listing</Th>
            <Th className="hidden md:table-cell md:w-[20%] xl:w-[22%]">Employer</Th>
            <Th className="w-[26%] sm:w-[18%] md:w-[12%] xl:w-[10%]">Board</Th>
            <Th className="hidden sm:table-cell sm:w-[22%] md:w-[14%] xl:w-[10%]">State</Th>
            <Th className="hidden md:table-cell md:w-[12%] xl:w-[10%]">Closes</Th>
            <Th className="w-[26%] sm:w-[22%] md:w-[10%] xl:w-[14%]">First seen</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <Row key={row.sourceListingId} row={row} position={index + 1} />
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

function Row({ row, position }: { row: ListingView; position: number }) {
  const employer = row.organization?.trim() ?? '';

  return (
    <tr id={`row-${position}`} className="border-b border-border align-baseline hover:bg-surface">
      <td className="py-1.5 pr-4">
        {/* The board's own page is the only link a listing has: a source
            listing has no screen of its own, and inventing one would duplicate
            the detail screen without the canonical context that makes it
            useful. */}
        <a
          href={row.canonicalUrl}
          target="_blank"
          rel="noreferrer"
          title={row.title}
          aria-label={`${row.title} on ${sourceLabel(row.sourceSlug)} (opens in a new tab)`}
          className="block truncate text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-accent"
        >
          {row.title}
        </a>
        {/* What the narrower breakpoints drop, restated where it is hidden. */}
        <NarrowMeta row={row} employer={employer} />
      </td>

      <td className="hidden py-1.5 pr-4 text-muted md:table-cell">
        {employer === '' ? null : (
          <span className="block truncate" title={employer}>
            {employer}
          </span>
        )}
      </td>

      <td className="py-1.5 pr-4">
        <span translate="no" className="text-muted">
          {sourceLabel(row.sourceSlug)}
        </span>
      </td>

      <td className="hidden py-1.5 pr-4 sm:table-cell">
        <StatusChip status={row.status} />
      </td>

      <td className="hidden py-1.5 pr-4 md:table-cell">
        {row.deadlineAt === null ? null : (
          <time
            className="numeric"
            dateTime={row.deadlineAt}
            title={sourceDateTime(row.deadlineAt)}
          >
            {sourceDate(row.deadlineAt)}
          </time>
        )}
      </td>

      <td className="py-1.5 pr-4 text-muted">
        <time dateTime={row.firstSeenAt} title={absoluteTime(row.firstSeenAt)}>
          {relativeTime(row.firstSeenAt)}
        </time>
      </td>
    </tr>
  );
}

function NarrowMeta({ row, employer }: { row: ListingView; employer: string }) {
  return (
    <span className="mt-0.5 block text-xs text-faint md:hidden">
      <span className="sm:hidden">
        <StatusChip status={row.status} />
        {(employer !== '' || row.deadlineAt !== null) && ' · '}
      </span>
      {employer !== '' && <span>{employer}</span>}
      {row.deadlineAt !== null && (
        <>
          {employer !== '' && ' · '}
          <time
            className="numeric"
            dateTime={row.deadlineAt}
            title={sourceDateTime(row.deadlineAt)}
          >
            closes {sourceDate(row.deadlineAt)}
          </time>
        </>
      )}
    </span>
  );
}

/**
 * What a hand-typed `?view=held`/`?view=changed` URL renders on the public
 * surface, instead of running the query at all. Naming the real reason
 * ("this role can't see that", an access boundary) rather than either view's
 * local empty-state copy, which would otherwise assert something false about
 * the corpus itself — see `listing-params.ts`'s `localOnly` comment.
 */
function UnavailableView({ view }: { view: string }) {
  return (
    <p className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-6 text-sm text-muted">
      The “{view}” view isn’t available here — it needs access this site doesn’t have publicly.
    </p>
  );
}

/**
 * Empty is a real answer here, and two of the named views are empty against
 * the whole corpus — nothing is quarantined, and no listing has a second
 * revision. So the message names the reason rather than showing a blank table:
 * "no listing has been edited since it was first captured" and "this filter is
 * broken" look identical otherwise, and only one of them is true.
 */
function EmptyState({ query, filtered }: { query: ListingQuery; filtered: boolean }) {
  return (
    <div className="mt-3 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-6 text-sm text-muted">
      <p>{query.view.empty}</p>
      {filtered && (
        <p className="mt-2">
          Filters are narrowing this further.{' '}
          <a
            className="text-accent underline underline-offset-2"
            href={viewHref({ ...query, form: { ...query.form, q: '', source: '' } }, query.view)}
          >
            Clear them
          </a>{' '}
          to see everything in this view.
        </p>
      )}
    </div>
  );
}

/** Same growing list as the opportunities screen: no page numbers, no ceiling. */
function ShowMore({ query, shown, more }: { query: ListingQuery; shown: number; more: number }) {
  if (more <= 0) return null;
  const next = Math.min(query.show + ROW_CHUNK, shown + more);

  return (
    <div className="mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-sm">
      <a
        className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 hover:bg-surface-active"
        href={`${buildListingHref(query, { show: next })}#row-${shown + 1}`}
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
