import type { SourceHealthView } from '../../src/browse/queries.js';

/**
 * The oldest of each source's last CONFIRMED-complete crawl — never a
 * fabricated "synced just now", and never the newest source's timestamp
 * either. `lastRunAt` is a run's start time regardless of outcome, so a
 * source that is mid-crawl (or whose last attempt failed) would otherwise
 * print as "synced" just because it started recently. The oldest completed
 * run, not the newest of any run, is the honest bound on "as of when can
 * every listed board's content be trusted" — and only returned when every
 * source actually has one, rather than silently ignoring the ones that
 * don't.
 *
 * Shared between `/opportunities` and `/` (Phase 3E's landing hero) so the
 * two screens mean the same thing by "synced" rather than drifting apart
 * from two copies of this rule.
 */
export function lastCompletedSync(health: readonly SourceHealthView[]): string | undefined {
  const completedRuns = health.map((source) => source.lastFullCoverageRunAt);
  return completedRuns.every((value): value is string => value !== null)
    ? completedRuns.slice().sort()[0]
    : undefined;
}
