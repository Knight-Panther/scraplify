import { getSourceHealth, type SourceHealthView } from '../../../../../src/browse/queries.js';
import {
  assessSourceHealth,
  type HealthAlert,
  UNLINKED_GRACE_HOURS,
} from '../../../../../src/browse/source-health.js';
import { db } from '../../../../../src/db/client.js';
import { StatusChip } from '../../../../components/status-chip.js';
import { requireAdmin } from '../../../../lib/admin-auth.js';
import { absoluteTime, count, relativeTime } from '../../../../lib/format.js';
import { crawlRunStatusLabel, sourceLabel } from '../../../../lib/labels.js';

/**
 * The admin surface's source-health screen (Stage 8, change.md §5's route
 * table) — reads via the same `getSourceHealth`/`assessSourceHealth` the
 * local `/health` screen uses (per the plan: admin reuses the same
 * underlying data-fetching functions for reads), gated by `requireAdmin()`
 * instead of being reachable unauthenticated. Presentation deliberately
 * mirrors `(local)/health/page.tsx` closely rather than diverging for its
 * own sake — this is the same data, read the same way, just behind the real
 * admin boundary.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sources · Admin · Xtelo' };

export default async function AdminSourcesPage() {
  await requireAdmin();

  const now = new Date().toISOString();
  const sources = (await getSourceHealth(db))
    .sort((a, b) => a.sourceSlug.localeCompare(b.sourceSlug))
    .map((source) => ({ source, alerts: assessSourceHealth(source, now) }));
  const needingAttention = sources.filter(({ alerts }) => alerts.length > 0).length;

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">Sources</h1>
        <p className="mt-1 max-w-[var(--measure)] text-sm text-faint">
          Whether each board is being crawled, and whether those crawls covered the whole corpus.
        </p>
        {sources.length > 0 && (
          <p className="mt-3 text-sm">
            {needingAttention === 0 ? (
              <span className="text-status-open">Every source is healthy.</span>
            ) : (
              <>
                <span className="numeric">{count(needingAttention)}</span> of{' '}
                <span className="numeric">{count(sources.length)}</span>{' '}
                {sources.length === 1 ? 'source needs' : 'sources need'} attention.
              </>
            )}
          </p>
        )}
      </header>

      {sources.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="mt-8 space-y-6">
          {sources.map(({ source, alerts }) => (
            <SourceCard key={source.sourceSlug} source={source} alerts={alerts} />
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

function SourceCard({ source, alerts }: { source: SourceHealthView; alerts: HealthAlert[] }) {
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

      {alerts.length > 0 && <AlertList alerts={alerts} />}

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

          <Field label="Active listings not yet browsable">
            {source.unlinkedActiveListings === 0 ? (
              <p className="text-sm text-muted">None.</p>
            ) : (
              <p className="max-w-[var(--measure)] text-sm">
                <span className="numeric">{count(source.unlinkedActiveListings)}</span> waiting for
                the duplicate check
                {source.staleUnlinkedActiveListings > 0 && (
                  <>
                    , <span className="numeric">{count(source.staleUnlinkedActiveListings)}</span>{' '}
                    of them for over {UNLINKED_GRACE_HOURS}h
                  </>
                )}
                .
              </p>
            )}
          </Field>
        </div>
      </dl>
    </section>
  );
}

function AlertList({ alerts }: { alerts: HealthAlert[] }) {
  return (
    <ul aria-label="Problems" className="space-y-2 border-b border-border px-4 py-3">
      {alerts.map((alert) => {
        const critical = alert.level === 'critical';
        return (
          <li key={alert.code} className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
            <span
              className={`inline-flex w-28 shrink-0 items-center gap-1.5 ${
                critical ? 'text-status-held' : 'text-status-unconfirmed'
              }`}
            >
              <svg width={8} height={8} viewBox="0 0 8 8" aria-hidden="true">
                {critical ? (
                  <rect x="0.5" y="0.5" width="7" height="7" fill="currentColor" />
                ) : (
                  <circle cx="4" cy="4" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
                )}
              </svg>
              {critical ? 'Needs action' : 'Check'}
            </span>
            <span className="max-w-[var(--measure)]">{alert.message}</span>
          </li>
        );
      })}
    </ul>
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
