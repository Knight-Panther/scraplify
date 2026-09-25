import { db } from '../../../../../src/db/client.js';
import {
  MAX_BUNDLE_AGE_HOURS,
  PUBLIC_MATCHING_CHANNEL,
} from '../../../../../src/matching/bundle/contract.js';
import {
  activeBundleAgeHours,
  assessMatchingHealth,
  getMatchingBundleStatus,
  type MatchingAlert,
  type MatchingBuildSummary,
} from '../../../../../src/matching/bundle/status.js';
import { requireAdmin } from '../../../../lib/admin-auth.js';
import { absoluteTime, count, relativeTime } from '../../../../lib/format.js';

/**
 * The public matching bundle's pipeline state (Phase 8C, change.md §5's
 * `/admin/matching`). Read-only: building and rollback are worker/CLI
 * operations (`npm run matching:build`, `npm run matching:rollback`), so
 * this page shows what happened and what to run, and never offers a control
 * it cannot back with an audited mutation.
 *
 * Every value is read from `matching_bundle_builds`/`_publications`. There
 * is no score or estimate here: a build either verified or failed with a
 * recorded code.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Matching · Admin · Xtelo' };

const ERROR_EXPLANATIONS: Record<string, string> = {
  interrupted: 'The build process stopped before finishing.',
  upstream_unhealthy: 'A source had a critical health alert, so publication was refused.',
  empty_bundle: 'No publicly available opportunity was found.',
  count_anomaly: 'The corpus shrank below half of the active bundle, so it was not activated.',
  incompatible_schema: 'The build used a bundle schema this server does not serve.',
  artifact_write_failed: 'The files could not be written to the artifact store.',
  artifact_verify_failed: 'The written files did not match their own manifest.',
  provenance_drift: 'A row no longer matched its current canonical revision or a live source.',
  internal_error: 'An unexpected error stopped the build.',
};

export default async function AdminMatchingPage() {
  await requireAdmin();

  const now = new Date().toISOString();
  const status = await getMatchingBundleStatus(db, PUBLIC_MATCHING_CHANNEL);
  const alerts = assessMatchingHealth(status, now);
  const age = activeBundleAgeHours(status, now);

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">Matching</h1>
        <p className="mt-1 max-w-[var(--measure)] text-sm text-faint">
          The public matching bundle: the opportunity data CV matching runs against in the visitor's
          browser. Built from public, currently available opportunities only.
        </p>
      </header>

      <section className="mt-8 rounded-[var(--radius)] border border-border bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-3">
          <h2 className="font-medium">Active bundle</h2>
          {status.active !== null && (
            <p className="text-sm text-faint">
              <span className="numeric text-muted">
                {status.active.opportunityCount === null
                  ? '—'
                  : count(status.active.opportunityCount)}
              </span>{' '}
              opportunities
            </p>
          )}
        </div>

        {alerts.length > 0 && <AlertList alerts={alerts} />}

        {status.active === null ? (
          <p className="px-4 py-4 text-sm text-muted">
            Nothing is published yet. Run <code className="numeric">npm run matching:build</code>{' '}
            after a crawl, dedupe and taxonomy pass.
          </p>
        ) : (
          <dl className="grid gap-x-8 gap-y-4 px-4 py-4 sm:grid-cols-2">
            <Field label="Built">
              <p className="text-sm">
                <time dateTime={status.active.builtAt} title={absoluteTime(status.active.builtAt)}>
                  {relativeTime(status.active.builtAt, Date.parse(now))}
                </time>
                {age !== null && (
                  <span className="text-muted">
                    {' '}
                    · matching stops after {MAX_BUNDLE_AGE_HOURS}h
                  </span>
                )}
              </p>
            </Field>
            <Field label="Activated">
              <p className="text-sm">
                <time
                  dateTime={status.active.activatedAt}
                  title={absoluteTime(status.active.activatedAt)}
                >
                  {relativeTime(status.active.activatedAt, Date.parse(now))}
                </time>{' '}
                <span className="text-muted">
                  {status.active.reason === 'rollback' ? 'by rollback' : 'by build'} ·{' '}
                  {status.active.activatedBy}
                </span>
              </p>
            </Field>
            <Field label="Data last seen on a source">
              {status.active.corpusWatermark === null ? (
                <p className="text-sm text-muted">Unknown.</p>
              ) : (
                <p className="text-sm">
                  <time
                    dateTime={status.active.corpusWatermark}
                    title={absoluteTime(status.active.corpusWatermark)}
                  >
                    {relativeTime(status.active.corpusWatermark, Date.parse(now))}
                  </time>
                </p>
              )}
            </Field>
            <Field label="Contract">
              <p className="text-sm">
                {status.active.featureContract}{' '}
                <span className="text-muted">
                  · schema <span className="numeric">{status.active.schemaVersion}</span>
                </span>
              </p>
            </Field>
            <Field label="Rollback target">
              {status.rollbackTargetBuildId === null ? (
                <p className="text-sm text-muted">None available.</p>
              ) : (
                <p className="text-sm">
                  <BuildId id={status.rollbackTargetBuildId} />{' '}
                  <span className="text-muted">
                    · <code className="numeric">npm run matching:rollback</code>
                  </span>
                </p>
              )}
            </Field>
            <Field label="Bundle id">
              <p className="text-sm">
                <BuildId id={status.active.buildId} />
              </p>
            </Field>
          </dl>
        )}
      </section>

      <section className="mt-8">
        <h2 className="font-medium">Recent builds</h2>
        {status.recentBuilds.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No build has run yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-[var(--radius)] border border-border">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="bg-surface text-xs text-faint">
                <tr>
                  <th className="px-3 py-2 font-normal">Started</th>
                  <th className="px-3 py-2 font-normal">Result</th>
                  <th className="px-3 py-2 text-right font-normal">Opportunities</th>
                  <th className="px-3 py-2 font-normal">Build</th>
                </tr>
              </thead>
              <tbody>
                {status.recentBuilds.map((build) => (
                  <BuildRow
                    key={build.id}
                    build={build}
                    now={now}
                    active={build.id === status.active?.buildId}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function BuildRow({
  build,
  now,
  active,
}: {
  build: MatchingBuildSummary;
  now: string;
  active: boolean;
}) {
  const excluded = Object.entries(build.exclusions ?? {}).filter(([, n]) => n > 0);
  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2 whitespace-nowrap">
        <time dateTime={build.startedAt} title={absoluteTime(build.startedAt)}>
          {relativeTime(build.startedAt, Date.parse(now))}
        </time>
      </td>
      <td className="px-3 py-2">
        {build.state === 'failed' ? (
          <>
            <span className="text-status-held">Failed</span>{' '}
            <span className="text-muted">({build.errorCode ?? 'unknown'})</span>
            {build.errorCode !== null && ERROR_EXPLANATIONS[build.errorCode] !== undefined && (
              <p className="mt-0.5 max-w-[var(--measure)] text-xs text-faint">
                {ERROR_EXPLANATIONS[build.errorCode]} The previous bundle stayed active.
              </p>
            )}
          </>
        ) : build.state === 'building' ? (
          <span className="text-status-unconfirmed">Running</span>
        ) : (
          <>
            <span className="text-status-open">{active ? 'Active' : 'Verified'}</span>
            {build.artifactsRemoved && <span className="text-muted"> · files removed</span>}
          </>
        )}
        {build.healthGateOverridden && (
          <p className="mt-0.5 text-xs text-status-unconfirmed">Built past the health gate.</p>
        )}
        {excluded.length > 0 && (
          <p className="mt-0.5 text-xs text-faint">
            Left out:{' '}
            {excluded.map(([reason, n]) => `${count(n)} ${reason.replaceAll('_', ' ')}`).join(', ')}
          </p>
        )}
      </td>
      <td className="numeric px-3 py-2 text-right">
        {build.opportunityCount === null ? '—' : count(build.opportunityCount)}
      </td>
      <td className="px-3 py-2">
        <BuildId id={build.id} />
      </td>
    </tr>
  );
}

function BuildId({ id }: { id: string }) {
  return (
    <code className="numeric text-muted" title={id}>
      {id.slice(0, 8)}
    </code>
  );
}

function AlertList({ alerts }: { alerts: MatchingAlert[] }) {
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
