import type { SourceHealthView } from './queries.js';

/**
 * Turns per-source health figures into explicit alerts (Phase 7A, stage 7-2).
 *
 * The figures on `/health` were already correct on 2026-09-15, when the corpus
 * had silently gone nine days without a dedupe pass — nobody was looking, and
 * nothing said "this is wrong". Alerts exist so that state is stated outright,
 * and so `npm run health:check` can fail a scheduler or a shell on it.
 *
 * Pure: every threshold and the clock are explicit inputs, so each rule is
 * tested directly rather than through a database.
 */

export type HealthAlertLevel = 'critical' | 'warning';

export type HealthAlertCode =
  | 'never_crawled'
  | 'run_overdue'
  | 'last_run_failed'
  | 'last_run_degraded'
  | 'run_possibly_stuck'
  | 'full_coverage_stale'
  | 'open_incidents'
  | 'unlinked_active_listings';

export interface HealthAlert {
  level: HealthAlertLevel;
  code: HealthAlertCode;
  sourceSlug: string;
  message: string;
}

export interface HealthThresholds {
  /** A source not crawled at all within this window is critical. 2x the default 24h schedule. */
  runOverdueHours: number;
  /** A run still `running` after this long is probably a crashed run holding the lock. */
  runPossiblyStuckHours: number;
  /** Without a completed full-coverage run in this window, absence reconciliation is not happening. */
  fullCoverageStaleDays: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  runOverdueHours: 48,
  // The longest measured run (jobs.ge, full coverage) is ~8-9h.
  runPossiblyStuckHours: 24,
  fullCoverageStaleDays: 7,
};

/**
 * How long a freshly crawled listing may legitimately wait for its dedupe pass.
 * The scheduled wrapper runs dedupe only once the crawl ends, and a full
 * jobs.ge crawl takes ~8-9h, so a listing first seen at its start legitimately
 * waits that long. Anything older than this means dedupe is not running — the 2026-09-15 incident's signature.
 */
export const UNLINKED_GRACE_HOURS = 12;

const HOUR_MS = 60 * 60 * 1000;

function hoursBetween(earlierIso: string, laterMs: number): number {
  return (laterMs - Date.parse(earlierIso)) / HOUR_MS;
}

function formatAge(hours: number): string {
  return hours < 48 ? `${Math.floor(hours)}h` : `${Math.floor(hours / 24)} days`;
}

export function assessSourceHealth(
  source: SourceHealthView,
  now: string,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): HealthAlert[] {
  const nowMs = Date.parse(now);
  const alerts: HealthAlert[] = [];
  const add = (level: HealthAlertLevel, code: HealthAlertCode, message: string) =>
    alerts.push({ level, code, sourceSlug: source.sourceSlug, message });

  if (source.lastRunAt === null) {
    add('critical', 'never_crawled', 'Never crawled.');
  } else {
    const sinceLastRun = hoursBetween(source.lastRunAt, nowMs);
    if (sinceLastRun > thresholds.runOverdueHours) {
      add(
        'critical',
        'run_overdue',
        `No crawl in ${formatAge(sinceLastRun)} (expected at least every ${thresholds.runOverdueHours}h). Is its scheduled task registered and running?`,
      );
    }

    if (source.lastRunStatus === 'failed') {
      add('critical', 'last_run_failed', 'The most recent crawl failed.');
    } else if (source.lastRunStatus === 'partial' || source.lastRunStatus === 'quarantined') {
      add(
        'warning',
        'last_run_degraded',
        `The most recent crawl ended ${source.lastRunStatus}: a health guard tripped, so it did not advance closure.`,
      );
    } else if (
      source.lastRunStatus === 'running' &&
      sinceLastRun > thresholds.runPossiblyStuckHours
    ) {
      add(
        'warning',
        'run_possibly_stuck',
        `A crawl has been "running" for ${formatAge(sinceLastRun)}. If no crawl process is alive, it crashed and is holding the lock.`,
      );
    }
  }

  if (source.lastRunAt !== null) {
    if (source.lastFullCoverageRunAt === null) {
      add(
        'warning',
        'full_coverage_stale',
        'No completed full-coverage crawl yet, so listings that disappear are never closed.',
      );
    } else {
      const sinceFullCoverage = hoursBetween(source.lastFullCoverageRunAt, nowMs);
      if (sinceFullCoverage > thresholds.fullCoverageStaleDays * 24) {
        add(
          'warning',
          'full_coverage_stale',
          `No completed full-coverage crawl in ${formatAge(sinceFullCoverage)}, so closure of vanished listings has stalled.`,
        );
      }
    }
  }

  if (source.unresolvedIncidents > 0) {
    add(
      'warning',
      'open_incidents',
      `${source.unresolvedIncidents} unresolved parser incident${source.unresolvedIncidents === 1 ? '' : 's'}.`,
    );
  }

  if (source.staleUnlinkedActiveListings > 0) {
    add(
      'critical',
      'unlinked_active_listings',
      `${source.staleUnlinkedActiveListings} active listing${source.staleUnlinkedActiveListings === 1 ? ' has' : 's have'} had no opportunity for over ${UNLINKED_GRACE_HOURS}h, so ${source.staleUnlinkedActiveListings === 1 ? 'it is' : 'they are'} invisible outside the raw listings view. Run \`npm run dedupe -- --auto-link\`.`,
    );
  }

  return alerts;
}

export function hasCriticalAlert(alerts: readonly HealthAlert[]): boolean {
  return alerts.some((alert) => alert.level === 'critical');
}
