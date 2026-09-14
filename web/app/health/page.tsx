import { getSourceHealth, type SourceHealthView } from '../../../src/browse/queries.js';
import { db } from '../../../src/db/client.js';
import { StatusChip } from '../../components/status-chip.js';
import { absoluteTime, count, relativeTime } from '../../lib/format.js';
import { crawlRunStatusLabel, sourceLabel } from '../../lib/labels.js';

/**
 * Per-source crawl health (§21.2), the browsable form of `npm run browse health`.
 *
 * The screen's real job is to make ONE distinction visible: a source can be
 * crawled constantly and still not have had a full-coverage run in weeks, and
 * that is precisely the state in which absence reconciliation silently stops
 * happening. Showing "last run" alone would make that look healthy — so full
 * coverage gets its own column and its own warning treatment, and right now it
 * honestly reads "never" for both sources.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Source health · Xtelo' };

export default async function HealthPage() {
  const sources = await getSourceHealth(db);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header>
        <h1 className="text-xl font-semibold">Source health</h1>
        <p className="mt-1 max-w-[var(--measure)] text-sm text-faint">
          Whether each board is being crawled, and whether those crawls covered the whole corpus.
        </p>
      </header>

      {sources.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="mt-8 space-y-6">
          {sources.map((source) => (
            <SourceCard key={source.sourceSlug} source={source} />
          ))}
        </div>
      )}
    </main>
  );
}

function EmptyState() {
  return (
    <p className="mt-8 rounded-[var(--radius)] border border-border bg-surface px-4 py-6 text-sm text-muted">
      No sources are configured yet. A source appears here once its first crawl has run.
    </p>
  );
}

function SourceCard({ source }: { source: SourceHealthView }) {
  const statuses = Object.entries(source.listingsByStatus).sort(([, a], [, b]) => b - a);
  const total = statuses.reduce((sum, [, n]) => sum + n, 0);

  return (
    <section className="rounded-[var(--radius)] border border-border bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-3">
        <h2 className="font-medium">{sourceLabel(source.sourceSlug)}</h2>
        <p className="text-sm text-faint">
          <span className="numeric text-muted">{count(total)}</span> listings
        </p>
      </div>

      <dl className="grid gap-x-8 gap-y-4 px-4 py-4 sm:grid-cols-2">
        <Field label="Listings by state">
          <ul className="mt-1 space-y-1 text-sm">
            {statuses.map(([status, n]) => (
              <li key={status}>
                <StatusChip status={status} count={n} />
              </li>
            ))}
          </ul>
        </Field>

        <div className="space-y-4">
          <Field label="Last crawl">
            <Timestamp
              iso={source.lastRunAt}
              suffix={
                source.lastRunStatus === null ? null : (
                  <span
                    className="text-muted"
                    title={crawlRunStatusLabel(source.lastRunStatus).explanation}
                  >
                    {crawlRunStatusLabel(source.lastRunStatus).short}
                  </span>
                )
              }
              absentMessage="No crawl has run yet."
            />
          </Field>

          <Field label="Last full-coverage crawl">
            <Timestamp
              iso={source.lastFullCoverageRunAt}
              absentMessage="Never. Until one runs, listings that disappear from this source cannot be closed."
              warnWhenAbsent
            />
          </Field>

          <Field label="Unresolved parser incidents">
            {source.unresolvedIncidents === 0 ? (
              <p className="text-sm text-muted">None.</p>
            ) : (
              <p className="text-sm">
                <span className="numeric">{count(source.unresolvedIncidents)}</span> awaiting review
              </p>
            )}
          </Field>
        </div>
      </dl>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="ml-0">{children}</dd>
    </div>
  );
}

/**
 * A timestamp, or an honest account of its absence.
 *
 * `warnWhenAbsent` exists for full coverage specifically: "never" there is not a
 * neutral empty value, it is the condition that makes closure impossible, so it
 * is styled as something to notice rather than as missing data.
 */
function Timestamp({
  iso,
  suffix,
  absentMessage,
  warnWhenAbsent,
}: {
  iso: string | null;
  suffix?: React.ReactNode;
  absentMessage: string;
  warnWhenAbsent?: boolean;
}) {
  if (iso === null) {
    return (
      <p
        className={`max-w-[var(--measure)] text-sm ${
          warnWhenAbsent === true ? 'text-status-unconfirmed' : 'text-muted'
        }`}
      >
        {absentMessage}
      </p>
    );
  }
  return (
    <p className="text-sm">
      <time dateTime={iso} title={absoluteTime(iso)}>
        {relativeTime(iso)}
      </time>
      {suffix !== undefined && suffix !== null && <> · {suffix}</>}
    </p>
  );
}
