import { db } from '../../../src/db/client.js';
import { canUndoCorrection } from '../../../src/taxonomy/correct-classification.js';
import type { TaxonomyAxis } from '../../../src/domain/taxonomy.js';
import {
  type AmbiguousClassification,
  AMBIGUOUS_CLASSIFICATION_CONFIDENCE_THRESHOLD,
  countAmbiguousClassifications,
  countClassifications,
  countUncategorizedListings,
  listAmbiguousClassifications,
  searchClassifications,
} from '../../../src/taxonomy/queries.js';
import {
  classificationMethodLabel,
  sourceLabel,
  sourceLabels,
  taxonomyAxisLabel,
  taxonomyAxisLabels,
} from '../../lib/labels.js';
import { capGraphemes, MAX_TEXT, one, type RawSearchParams } from '../../lib/search-params.js';
import { UUID } from '../../lib/taxonomy-review-input.js';
import { writesEnabled } from '../../lib/writes.js';
import { confirmClassification, rejectClassification, undoCorrection } from './actions.js';

/**
 * The taxonomy half of Phase 3's exit gate — §15.2 step 8's "queue low-
 * confidence or conflicting results for review", plus (Stage 7) a genuine
 * correction verb, since inspection alone doesn't satisfy "inspected AND
 * corrected without direct database access."
 *
 * Two sections, not one: "Needs review" (the low-confidence queue) is what
 * hr.ge's own structured-field backfill actually produces — confidence 1
 * throughout, so this legitimately starts and usually stays empty. "Browse
 * and correct any classification" is what actually lets a human fix a
 * classification they disagree with, since nothing in the real corpus is
 * low-confidence today (independent design review, 2026-09-15, before this
 * stage's code was written — a correction UI attached only to the empty
 * queue would have nothing to act on against the real 16,868 rows).
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Taxonomy review · Xtelo' };

/** Smaller than /listings' 500-row chunk — each row here carries two buttons, not one line. */
const SHOW_CHUNK = 50;

/** The only source with zero automated classification signal today (`structuredAttributes` is always `{}`). */
const UNCATEGORIZED_SOURCE_SLUG = 'jobs-ge';

/**
 * Reads in chunks up to `wanted`, the same pattern `/listings`' `fetchRows`
 * uses — `searchClassifications` clamps any single call's `limit` at its own
 * `MAX_LIMIT` (500), so a single `limit: show` call silently stalled at 500
 * rows: `searchRows.length` stayed 500 forever, "Show 50 more" kept
 * rendering, and every click re-fetched the identical first 500 rows —
 * unreachable for the real corpus's default, unfiltered 16,868-row search
 * (commit gate finding, 2026-09-15). Chunking over `offset` reaches every
 * row regardless of how large `show` grows.
 */
const FETCH_CHUNK = 500;

async function fetchClassificationRows(
  filters: Parameters<typeof searchClassifications>[1],
  wanted: number,
): Promise<AmbiguousClassification[]> {
  const rows: AmbiguousClassification[] = [];
  for (let offset = 0; offset < wanted; offset += FETCH_CHUNK) {
    const batch = await searchClassifications(db, {
      ...filters,
      limit: Math.min(FETCH_CHUNK, wanted - offset),
      offset,
    });
    rows.push(...batch);
    if (batch.length === 0) break;
  }
  return rows;
}

export default async function TaxonomyReviewPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const conflict = one(raw.conflict);
  const correctedId = one(raw.corrected);

  const text = capGraphemes(one(raw.text), MAX_TEXT);
  const rawSourceSlug = one(raw.sourceSlug);
  // `in` walks the prototype chain — `?sourceSlug=toString` would pass an
  // `in sourceLabels` check (it exists on Object.prototype) and then reach
  // Postgres as an invalid enum value, crashing the page instead of being
  // ignored as an unrecognised filter (commit gate finding, 2026-09-15).
  // `hasOwnProperty` checks only the map's own keys.
  const sourceSlug = Object.hasOwn(sourceLabels, rawSourceSlug) ? rawSourceSlug : '';
  const rawAxis = one(raw.axis);
  const axis: TaxonomyAxis | undefined = Object.hasOwn(taxonomyAxisLabels, rawAxis)
    ? (rawAxis as TaxonomyAxis)
    : undefined;

  const parsedShow = Number.parseInt(one(raw.show), 10);
  const show =
    Number.isInteger(parsedShow) && parsedShow > SHOW_CHUNK
      ? Math.ceil(parsedShow / SHOW_CHUNK) * SHOW_CHUNK
      : SHOW_CHUNK;

  const searchFilters = {
    text: text === '' ? undefined : text,
    sourceSlug: sourceSlug === '' ? undefined : sourceSlug,
    axis,
  };

  const [needsReview, needsReviewTotal, searchTotal, uncategorizedJobsGe, correctedIsUndoable] =
    await Promise.all([
      listAmbiguousClassifications(db),
      countAmbiguousClassifications(db),
      countClassifications(db, searchFilters),
      countUncategorizedListings(db, { sourceSlug: UNCATEGORIZED_SOURCE_SLUG }),
      // A hand-edited or merely stale ?corrected= (another tab already undid
      // or superseded it) must not render a banner claiming success and
      // offering an undo guaranteed to fail — verified before it's shown,
      // not just before it's clicked (commit gate finding, 2026-09-15).
      correctedId !== '' && UUID.test(correctedId)
        ? canUndoCorrection(db, correctedId)
        : Promise.resolve(false),
    ]);
  const searchRows = await fetchClassificationRows(searchFilters, show);

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">Taxonomy review</h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          Inspect how listings are categorized, and correct one when it's wrong — not just the ones
          flagged below the confidence threshold, but any classification in the corpus.
        </p>
      </header>

      {conflict !== '' && <ConflictNotice message={conflict} />}
      {correctedIsUndoable && writesEnabled() && <CorrectedNotice classificationId={correctedId} />}
      {!writesEnabled() && <ReadOnlyNotice />}

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Needs review</h2>
        <p className="mt-1 max-w-[var(--measure)] text-sm text-muted">
          Category assignments below confidence{' '}
          <span className="numeric">{AMBIGUOUS_CLASSIFICATION_CONFIDENCE_THRESHOLD}</span> — worth a
          second look before relying on them.
          {needsReview.length > 0 && needsReview.length < needsReviewTotal && (
            <>
              {' '}
              Showing <span className="numeric">{needsReview.length}</span> of{' '}
              <span className="numeric">{needsReviewTotal}</span> — the rest reference a listing or
              term this page could not read.
            </>
          )}
        </p>
        {needsReview.length === 0 ? (
          <NeedsReviewEmptyState total={needsReviewTotal} />
        ) : (
          <ClassificationList rows={needsReview} />
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Browse and correct any classification</h2>
        <p className="mt-1 max-w-[var(--measure)] text-sm text-muted">
          {needsReviewTotal === 0 ? (
            <>
              Nothing currently scores below confidence{' '}
              <span className="numeric">{AMBIGUOUS_CLASSIFICATION_CONFIDENCE_THRESHOLD}</span>, so a
              classification that's actually wrong won't show up above it either. Search here to
              find and correct one directly.
            </>
          ) : (
            <>
              Search here to find and correct any classification directly, not only the ones above.
            </>
          )}
        </p>
        <SearchForm text={text} sourceSlug={sourceSlug} axis={axis ?? ''} />
        <p className="mt-3 text-sm text-faint">
          <span className="numeric">{searchTotal}</span>{' '}
          {searchTotal === 1 ? 'classification matches' : 'classifications match'}
        </p>
        {searchRows.length === 0 ? (
          <SearchEmptyState hasFilters={text !== '' || sourceSlug !== '' || axis !== undefined} />
        ) : (
          <ClassificationList rows={searchRows} idPrefix="browse" />
        )}
        <ShowMore
          text={text}
          sourceSlug={sourceSlug}
          axis={axis ?? ''}
          shown={searchRows.length}
          more={searchTotal - searchRows.length}
          show={show}
        />
      </section>

      {uncategorizedJobsGe > 0 && (
        <p className="mt-10 max-w-[var(--measure)] text-sm text-faint">
          <span className="numeric">{uncategorizedJobsGe}</span>{' '}
          {sourceLabel(UNCATEGORIZED_SOURCE_SLUG)} listings have never been categorized at all —
          hr.ge's structured category field is the only automated signal this backfill reads, and{' '}
          {sourceLabel(UNCATEGORIZED_SOURCE_SLUG)} does not have an equivalent one. There is no way
          yet to assign one by hand; this count exists so the gap is visible rather than silent.
        </p>
      )}
    </main>
  );
}

function ConflictNotice({ message }: { message: string }) {
  return (
    <div className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-4 py-3 text-sm">
      {message}
    </div>
  );
}

function CorrectedNotice({ classificationId }: { classificationId: string }) {
  return (
    <div className="mt-4 flex max-w-[var(--measure)] flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius)] border border-border bg-surface px-4 py-3 text-sm">
      <span>Corrected.</span>
      <form action={undoCorrection}>
        <input type="hidden" name="classificationId" value={classificationId} />
        <button
          type="submit"
          className="text-accent underline underline-offset-2 hover:decoration-accent"
        >
          Undo
        </button>
      </form>
    </div>
  );
}

function ReadOnlyNotice() {
  return (
    <p className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-3 text-sm text-muted">
      This instance is pointed at the live corpus and cannot write, so classifications can be read
      here but not corrected. <span className="numeric">npm run dev:web:qa</span> runs against a
      disposable copy where they can.
    </p>
  );
}

/** The stored `{ reasons: string[] }` shape every writer of `evidence` uses — read defensively, since it is jsonb. */
function evidenceReasons(evidence: unknown): string[] {
  if (typeof evidence !== 'object' || evidence === null) return [];
  const reasons = (evidence as Record<string, unknown>).reasons;
  if (!Array.isArray(reasons)) return [];
  return reasons.filter((reason): reason is string => typeof reason === 'string');
}

function ClassificationList({
  rows,
  idPrefix,
}: {
  rows: AmbiguousClassification[];
  /** Set only on the "browse" section — `ShowMore` links to `#{idPrefix}-{n}`, the first newly revealed row. */
  idPrefix?: string;
}) {
  return (
    <ul className="mt-4 flex flex-col">
      {rows.map((row, index) => (
        <ClassificationRow
          key={row.classificationId}
          row={row}
          id={idPrefix === undefined ? undefined : `${idPrefix}-${index + 1}`}
        />
      ))}
    </ul>
  );
}

function ClassificationRow({ row, id }: { row: AmbiguousClassification; id?: string | undefined }) {
  const axis = taxonomyAxisLabel(row.axis);
  const method = classificationMethodLabel(row.method);
  const reasons = evidenceReasons(row.evidence);

  return (
    <li id={id} className="border-b border-border py-3 first:border-t">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <a
          href={
            row.opportunityId !== null
              ? `/opportunities/${row.opportunityId}`
              : row.canonicalSourceUrl
          }
          className="max-w-[var(--measure)] text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-accent"
        >
          {row.listingTitle}
        </a>
        <span className="numeric text-xs text-faint">confidence {row.confidence.toFixed(2)}</span>
      </div>

      <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-faint">
        <span>{sourceLabels[row.sourceSlug] ?? row.sourceDisplayName}</span>
        <span title={axis.explanation}>{axis.short}</span>
        <span>
          filed under <span className="text-foreground">{row.termLabel}</span>
        </span>
        <span title={method.explanation}>{method.short}</span>
      </p>

      {reasons.length > 0 && (
        <ul className="mt-1 list-inside list-disc text-xs text-faint">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      <PairActions classificationId={row.classificationId} />
    </li>
  );
}

function PairActions({ classificationId }: { classificationId: string }) {
  if (!writesEnabled()) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <form action={confirmClassification}>
        <input type="hidden" name="classificationId" value={classificationId} />
        <button
          type="submit"
          className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-3 py-1 text-xs hover:bg-surface-active"
        >
          Confirm — the term is right
        </button>
      </form>
      <form action={rejectClassification}>
        <input type="hidden" name="classificationId" value={classificationId} />
        <button
          type="submit"
          className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-3 py-1 text-xs hover:bg-surface-active"
        >
          Reject — not this term
        </button>
      </form>
    </div>
  );
}

/**
 * Explains why, rather than assuming empty means broken — but only claims
 * what the query actually proved. A first version asserted every
 * classification in the corpus comes from hr.ge's structured field at full
 * confidence, which this query never checked: it proves only that nothing
 * scores BELOW the threshold, which is equally true when zero
 * classifications exist at all (the real state before the backfill has
 * run) as when every one of them happens to be high-confidence — asserting
 * the second when the first might be true is exactly the fabricated-
 * pipeline-status `AGENTS.md` forbids (commit gate, 2026-09-15).
 */
function NeedsReviewEmptyState({ total }: { total: number }) {
  return (
    <div className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-6 text-sm text-muted">
      {total === 0 ? (
        <>
          <p>Nothing needs review.</p>
          <p className="mt-2">
            No classification currently scores below confidence{' '}
            <span className="numeric">{AMBIGUOUS_CLASSIFICATION_CONFIDENCE_THRESHOLD}</span>. This
            queue exists for when a lower-confidence assignment shows up — from a new source, a
            future inference pass, or a structured field a board changes — and is empty because none
            has, not because none could. Use the search below if you want to correct a
            high-confidence one anyway.
          </p>
        </>
      ) : (
        <p>
          {total} classification{total === 1 ? '' : 's'} exist below the review threshold, but none
          could be rendered — a listing or term one points at may be missing. Run{' '}
          <span className="numeric">npm run taxonomy:backfill</span> to re-check.
        </p>
      )}
    </div>
  );
}

function SearchEmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-6 text-sm text-muted">
      {hasFilters ? (
        <p>Nothing matches this search.</p>
      ) : (
        <p>No classifications exist yet — run the taxonomy backfill first.</p>
      )}
    </div>
  );
}

function SearchForm({
  text,
  sourceSlug,
  axis,
}: {
  text: string;
  sourceSlug: string;
  axis: string;
}) {
  return (
    <form method="get" className="mt-4 flex flex-wrap items-end gap-3">
      <label className="flex min-w-0 flex-col gap-1 text-xs text-faint">
        Search
        <input
          type="search"
          name="text"
          defaultValue={text}
          spellCheck={false}
          autoComplete="off"
          placeholder="listing title or category…"
          className="w-full max-w-56 rounded-[var(--radius)] border border-border bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-faint"
        />
      </label>

      <label className="flex min-w-0 flex-col gap-1 text-xs text-faint">
        Board
        <select
          name="sourceSlug"
          defaultValue={sourceSlug}
          className="w-full max-w-52 rounded-[var(--radius)] border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
        >
          <option value="">any board</option>
          {Object.entries(sourceLabels).map(([slug, label]) => (
            <option key={slug} value={slug}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex min-w-0 flex-col gap-1 text-xs text-faint">
        Axis
        <select
          name="axis"
          defaultValue={axis}
          className="w-full max-w-52 rounded-[var(--radius)] border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
        >
          <option value="">any axis</option>
          {Object.entries(taxonomyAxisLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label.short}
            </option>
          ))}
        </select>
      </label>

      <button
        type="submit"
        className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 text-sm hover:bg-surface-active"
      >
        Search
      </button>
      {(text !== '' || sourceSlug !== '' || axis !== '') && (
        <a
          className="py-1.5 text-sm text-accent underline underline-offset-2"
          href="/taxonomy-review"
        >
          Clear
        </a>
      )}
    </form>
  );
}

/** Same growing-list pattern as /listings and /opportunities: no page numbers, no ceiling. */
function ShowMore({
  text,
  sourceSlug,
  axis,
  shown,
  more,
  show,
}: {
  text: string;
  sourceSlug: string;
  axis: string;
  shown: number;
  more: number;
  show: number;
}) {
  if (more <= 0) return null;
  const next = Math.min(show + SHOW_CHUNK, shown + more);
  const params = new URLSearchParams();
  if (text !== '') params.set('text', text);
  if (sourceSlug !== '') params.set('sourceSlug', sourceSlug);
  if (axis !== '') params.set('axis', axis);
  params.set('show', String(next));

  return (
    <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-sm">
      <a
        className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 hover:bg-surface-active"
        href={`/taxonomy-review?${params.toString()}#browse-${shown + 1}`}
      >
        Show <span className="numeric">{Math.min(SHOW_CHUNK, more)}</span> more
      </a>
      <p className="text-faint">
        <span className="numeric">{shown}</span> of <span className="numeric">{shown + more}</span>{' '}
        shown
      </p>
    </div>
  );
}
