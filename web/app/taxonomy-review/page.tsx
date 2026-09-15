import { db } from '../../../src/db/client.js';
import {
  type AmbiguousClassification,
  AMBIGUOUS_CLASSIFICATION_CONFIDENCE_THRESHOLD,
  countAmbiguousClassifications,
  listAmbiguousClassifications,
} from '../../../src/taxonomy/queries.js';
import { classificationMethodLabel, sourceLabels, taxonomyAxisLabel } from '../../lib/labels.js';

/**
 * The taxonomy half of Phase 3's exit gate — §15.2 step 8's "queue low-
 * confidence or conflicting results for review", structurally the same
 * review-queue pattern as `/review`'s duplicate-candidate queue but over
 * `listing_classifications` instead of `duplicate_candidates`.
 *
 * Read-only, deliberately: unlike the duplicate-review screen, there is no
 * accept/reject verb defined for a classification yet, and inventing one
 * (what does "reject" even mean for a category assignment — remove it?
 * reclassify it as what?) is real design work §15.2 does not settle. This
 * screen's job today is exposure — Phase 3's exit gate requires the corpus
 * be INSPECTABLE without direct database access, and that is true the
 * moment this page lists what needs a look, before any write path exists
 * for acting on it.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Taxonomy review · Xtelo' };

export default async function TaxonomyReviewPage() {
  const [rows, total] = await Promise.all([
    listAmbiguousClassifications(db),
    countAmbiguousClassifications(db),
  ]);

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">Taxonomy review</h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          Category assignments below confidence{' '}
          <span className="numeric">{AMBIGUOUS_CLASSIFICATION_CONFIDENCE_THRESHOLD}</span> — worth a
          second look before relying on them.
          {rows.length > 0 && rows.length < total && (
            <>
              {' '}
              Showing <span className="numeric">{rows.length}</span> of{' '}
              <span className="numeric">{total}</span> — the rest reference a listing or term this
              page could not read.
            </>
          )}
        </p>
      </header>

      {rows.length === 0 ? <EmptyState total={total} /> : <Rows rows={rows} />}
    </main>
  );
}

/** The stored `{ reasons: string[] }` shape every writer of `evidence` uses — read defensively, since it is jsonb. */
function evidenceReasons(evidence: unknown): string[] {
  if (typeof evidence !== 'object' || evidence === null) return [];
  const reasons = (evidence as Record<string, unknown>).reasons;
  if (!Array.isArray(reasons)) return [];
  return reasons.filter((reason): reason is string => typeof reason === 'string');
}

function Rows({ rows }: { rows: AmbiguousClassification[] }) {
  return (
    <ul className="mt-4 flex flex-col">
      {rows.map((row) => {
        const axis = taxonomyAxisLabel(row.axis);
        const method = classificationMethodLabel(row.method);
        const reasons = evidenceReasons(row.evidence);
        return (
          <li key={row.classificationId} className="border-b border-border py-3 first:border-t">
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
              <span className="numeric text-xs text-faint">
                confidence {row.confidence.toFixed(2)}
              </span>
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
          </li>
        );
      })}
    </ul>
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
function EmptyState({ total }: { total: number }) {
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
            has, not because none could.
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
