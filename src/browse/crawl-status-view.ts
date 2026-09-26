import { CRAWL_SCHEDULES, type DailySchedule, nextSlot, previousSlot } from '../crawl-schedule.js';

/**
 * What the landing pages show for one source's crawl at a given moment:
 * pure, with no database import, because it runs in the browser too
 * (`web/components/crawl-status.tsx`) so a countdown and a late slot stay
 * right between polls. The snapshot comes from `getCrawlStatus`
 * (`./crawl-status.ts`).
 */

export interface CrawlStatusSnapshot {
  sourceSlug: string;
  /** The newest run's start, whatever its outcome. */
  lastRunStartedAt: string | null;
  lastRunStatus: 'running' | 'completed' | 'failed' | 'partial' | 'quarantined' | null;
  /** When the newest `completed` run finished: the last full update. */
  lastCompletedAt: string | null;
}

/** A scheduled run that has not started this long after its slot is late. */
export const LATE_AFTER_MS = 30 * 60 * 1000;
/**
 * A run still marked running after this long is not treated as updating:
 * crawls take minutes, so it is a process that died without settling (the
 * next run settles it, src/db/crawl-process-lock.ts).
 */
export const MAX_RUNNING_MS = 3 * 60 * 60 * 1000;
/** A run started up to this long before a slot counts for that slot. */
const EARLY_START_MS = 5 * 60 * 1000;

export type CrawlState =
  | { kind: 'updating'; since: string }
  | { kind: 'late'; expectedAt: string }
  | { kind: 'scheduled' };

export interface CrawlStatusView {
  sourceSlug: string;
  /** The last full update, or null if there has never been one. */
  lastUpdatedAt: string | null;
  /** The newest run ended partial, failed or quarantined, after the last full update. */
  lastAttemptIncomplete: boolean;
  state: CrawlState;
  nextUpdateAt: string;
}

export function describeCrawlStatus(
  snapshot: CrawlStatusSnapshot,
  nowMs: number,
  schedule: DailySchedule | undefined = CRAWL_SCHEDULES[snapshot.sourceSlug],
): CrawlStatusView | null {
  if (schedule === undefined) return null;
  const startedMs =
    snapshot.lastRunStartedAt === null ? null : Date.parse(snapshot.lastRunStartedAt);
  const slot = previousSlot(schedule, nowMs);

  let state: CrawlState = { kind: 'scheduled' };
  if (
    snapshot.lastRunStatus === 'running' &&
    startedMs !== null &&
    nowMs - startedMs < MAX_RUNNING_MS
  ) {
    state = { kind: 'updating', since: new Date(startedMs).toISOString() };
  } else if (
    nowMs >= slot + LATE_AFTER_MS &&
    (startedMs === null || startedMs < slot - EARLY_START_MS)
  ) {
    state = { kind: 'late', expectedAt: new Date(slot).toISOString() };
  }

  return {
    sourceSlug: snapshot.sourceSlug,
    lastUpdatedAt: snapshot.lastCompletedAt,
    lastAttemptIncomplete:
      snapshot.lastRunStatus !== null &&
      snapshot.lastRunStatus !== 'running' &&
      snapshot.lastRunStatus !== 'completed',
    state,
    nextUpdateAt: new Date(nextSlot(schedule, nowMs)).toISOString(),
  };
}
