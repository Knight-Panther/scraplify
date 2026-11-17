import { and, desc, eq } from 'drizzle-orm';
import { realEstateCrawlRuns, realEstateHistorySteps } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';

/**
 * A real-estate source's crawl health, for `npm run health:check`. The job
 * boards' freshness rules (src/browse/source-health.ts) leave real-estate
 * sources out, so without this an ss.ge crawl that had not finished a run
 * for five days (2026-10-22 to 10-26, a 403 every night) showed nowhere but
 * in the Hermes events.
 */

const HOUR_MS = 60 * 60 * 1000;
/** A nightly run finishes within hours; a day and a half without one is worth a look. */
export const WARN_AFTER_HOURS = 36;
/** Four days without one means listings are going stale on the tab. */
export const CRITICAL_AFTER_HOURS = 96;

export interface RealEstateRunHealth {
  /** When the last completed run finished, or null if none ever has. */
  lastCompletedAt: string | null;
  latest: { status: string; startedAt: string; notes: string | null } | null;
}

export interface RunAlert {
  level: 'warning' | 'critical';
  code: 'never_completed' | 'no_recent_completed_run' | 'history_failing';
  message: string;
}

export async function getRealEstateRunHealth(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<RealEstateRunHealth> {
  const [completed] = await db
    .select({ finishedAt: realEstateCrawlRuns.finishedAt })
    .from(realEstateCrawlRuns)
    .where(
      and(eq(realEstateCrawlRuns.sourceId, sourceId), eq(realEstateCrawlRuns.status, 'completed')),
    )
    .orderBy(desc(realEstateCrawlRuns.startedAt))
    .limit(1);
  const [latest] = await db
    .select({
      status: realEstateCrawlRuns.status,
      startedAt: realEstateCrawlRuns.startedAt,
      notes: realEstateCrawlRuns.notes,
    })
    .from(realEstateCrawlRuns)
    .where(eq(realEstateCrawlRuns.sourceId, sourceId))
    .orderBy(desc(realEstateCrawlRuns.startedAt))
    .limit(1);
  return { lastCompletedAt: completed?.finishedAt ?? null, latest: latest ?? null };
}

function latestRunNote(latest: RealEstateRunHealth['latest']): string {
  if (latest === null) return '';
  const notes = latest.notes === null ? '' : `: ${latest.notes.slice(0, 120)}`;
  return ` The latest run is ${latest.status}${notes}.`;
}

export function assessRealEstateRuns(health: RealEstateRunHealth, now: string): RunAlert[] {
  if (health.lastCompletedAt === null) {
    return [
      {
        level: 'critical',
        code: 'never_completed',
        message: `No run has ever completed.${latestRunNote(health.latest)}`,
      },
    ];
  }
  const hours = (Date.parse(now) - Date.parse(health.lastCompletedAt)) / HOUR_MS;
  if (hours <= WARN_AFTER_HOURS) return [];
  return [
    {
      level: hours > CRITICAL_AFTER_HOURS ? 'critical' : 'warning',
      code: 'no_recent_completed_run',
      message: `The last completed run finished ${Math.round(hours)} h ago.${latestRunNote(health.latest)}`,
    },
  ];
}

/** The nightly history step's latest attempts (Phase 17A), newest first. */
export interface HistoryStepHealth {
  takenAt: string;
  ok: boolean;
  error: string | null;
}

/** History steps failed in a row before it is worth a look: a night is healed by the next, two are a pattern. */
export const HISTORY_FAILURES_TO_WARN = 2;

export async function getRecentHistorySteps(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<HistoryStepHealth[]> {
  return db
    .select({
      takenAt: realEstateHistorySteps.takenAt,
      ok: realEstateHistorySteps.ok,
      error: realEstateHistorySteps.error,
    })
    .from(realEstateHistorySteps)
    .where(eq(realEstateHistorySteps.sourceId, sourceId))
    .orderBy(desc(realEstateHistorySteps.takenAt))
    .limit(HISTORY_FAILURES_TO_WARN);
}

/**
 * A warning when the nightly history step (`recordListingHistory`) has failed
 * on its last two attempts. Each night heals the one before, but what changed
 * on a failed night is recorded a night late, and a listing archived
 * (`GONE_RETENTION_DAYS`) before any step succeeds loses its versions.
 */
export function assessHistorySteps(steps: readonly HistoryStepHealth[]): RunAlert[] {
  if (steps.length < HISTORY_FAILURES_TO_WARN || steps.some((step) => step.ok)) return [];
  const error = steps[0]?.error;
  return [
    {
      level: 'warning',
      code: 'history_failing',
      message: `The nightly history step failed ${steps.length} times in a row${error ? `: ${error.slice(0, 120)}` : ''}.`,
    },
  ];
}
