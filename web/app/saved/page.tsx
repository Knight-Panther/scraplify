import { db } from '../../../src/db/client.js';
import {
  countDecisions,
  type DecidedOpportunity,
  type Decision,
  listDecisions,
} from '../../../src/shortlist/decisions.js';
import { DecisionControl } from '../../components/decision-control.js';
import { StatusChip } from '../../components/status-chip.js';
import { absoluteTime, count, relativeTime } from '../../lib/format.js';
import { opportunityTypeLabel } from '../../lib/labels.js';
import type { RawSearchParams } from '../../lib/search-params.js';
import { writesEnabled } from '../../lib/writes.js';

/**
 * The shortlist — the second half of "browse and shortlist", and the first
 * screen in this app that can change anything.
 *
 * Saved and dismissed are two views of one decision rather than two lists,
 * because they are the same statement with opposite signs and an opportunity
 * cannot be both. Dismissals are shown at all — rather than simply hidden —
 * for two reasons: a dismissal is reversible and an undo nobody can find is
 * not an undo, and "why does this keep coming back" is only answerable if the
 * dismissal and its date are visible.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Shortlist · Xtelo' };

const VIEWS = [
  { value: 'saved' as const, label: 'saved', empty: 'Nothing is saved yet.' },
  { value: 'dismissed' as const, label: 'dismissed', empty: 'Nothing has been dismissed.' },
];

export default async function SavedPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const requested = Array.isArray(raw.view) ? raw.view[0] : raw.view;
  const view: Decision = requested === 'dismissed' ? 'dismissed' : 'saved';

  const counts = await countDecisions(db);
  const rows = await listDecisions(db, view);

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">Shortlist</h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          What you decided about an opportunity, and when. Dismissals are listed rather than hidden:
          they are reversible, and an undo nobody can find is not an undo.
        </p>
      </header>

      {!writesEnabled() && <ReadOnlyNotice />}

      <nav aria-label="Views" className="mt-6">
        <ul className="flex flex-wrap gap-x-1 gap-y-2 text-sm">
          {VIEWS.map((entry) => {
            const active = entry.value === view;
            return (
              <li key={entry.value}>
                <a
                  href={entry.value === 'saved' ? '/saved' : '/saved?view=dismissed'}
                  aria-current={active ? 'page' : undefined}
                  className={
                    active
                      ? 'block rounded-[var(--radius)] border border-border-strong bg-surface-active px-3 py-1'
                      : 'block rounded-[var(--radius)] border border-transparent px-3 py-1 text-muted hover:bg-surface hover:text-foreground'
                  }
                >
                  {entry.label}{' '}
                  <span className="numeric text-faint">
                    {count(entry.value === 'saved' ? counts.saved : counts.dismissed)}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      {rows.length === 0 ? (
        <EmptyState view={view} />
      ) : (
        <ul className="mt-4 flex flex-col">
          {rows.map((row) => (
            <Row key={row.opportunityId} row={row} />
          ))}
        </ul>
      )}
    </main>
  );
}

function Row({ row }: { row: DecidedOpportunity }) {
  const type = row.type === 'job' ? null : opportunityTypeLabel(row.type);
  // Worth showing only when the decision has actually moved: on a first
  // decision the two dates are the same and printing both is noise.
  const changed = row.firstDecidedAt !== row.decidedAt;

  return (
    <li className="border-b border-border py-3 first:border-t">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <a
          href={`/opportunities/${row.opportunityId}`}
          className="max-w-[var(--measure)] text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-accent"
        >
          {row.canonicalTitle}
        </a>
        <DecisionControl
          opportunityId={row.opportunityId}
          decision={row.decision}
          note={row.note}
          withNote
        />
      </div>

      <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-faint">
        <StatusChip status={row.canonicalStatus} />
        {type !== null && (
          <span className="text-accent" title={type.explanation}>
            {type.short}
          </span>
        )}
        <span>
          {row.decision === 'saved' ? 'saved' : 'dismissed'}{' '}
          <time dateTime={row.decidedAt} title={absoluteTime(row.decidedAt)}>
            {relativeTime(row.decidedAt)}
          </time>
        </span>
        {changed && (
          <span>
            first decided{' '}
            <time dateTime={row.firstDecidedAt} title={absoluteTime(row.firstDecidedAt)}>
              {relativeTime(row.firstDecidedAt)}
            </time>
          </span>
        )}
      </p>

      {row.note !== null && row.note !== '' && (
        <p className="mt-1 max-w-[var(--measure)] text-sm text-muted">{row.note}</p>
      )}
    </li>
  );
}

/**
 * Says which instance this is, in the words that matter.
 *
 * The chrome already carries a "read-only" chip, but this is the first screen
 * whose entire purpose is unavailable without writes, so it says so where the
 * missing buttons are rather than only in the corner.
 */
function ReadOnlyNotice() {
  return (
    <p className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-3 text-sm text-muted">
      This instance is pointed at the live corpus and cannot write, so decisions can be read here
      but not made. <span className="numeric">npm run dev:web:qa</span> runs against a disposable
      copy where they can.
    </p>
  );
}

function EmptyState({ view }: { view: Decision }) {
  const entry = VIEWS.find((candidate) => candidate.value === view);
  return (
    <div className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-6 text-sm text-muted">
      <p>{entry?.empty}</p>
      <p className="mt-2">
        Decisions are made from an{' '}
        <a className="text-accent underline underline-offset-2" href="/opportunities">
          opportunity
        </a>
        , where there is enough context to make one.
      </p>
    </div>
  );
}
