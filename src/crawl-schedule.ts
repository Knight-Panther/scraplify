/**
 * When each source's scheduled crawl runs: the one declaration the site reads
 * to say "next update at". The schedulers themselves live outside this repo's
 * runtime (Windows Task Scheduler locally, `deploy/systemd/xtelo-pipeline@.timer`
 * hosted), so this is a statement of what they are set to, kept honest two
 * ways: a test checks the systemd timer against it, and the site shows a
 * source as late when a slot passes with no run, instead of trusting it.
 *
 * All three run daily at 16:10 UTC, 20:10 in Tbilisi (Georgia has no DST).
 */

export interface DailySchedule {
  readonly hourUtc: number;
  readonly minuteUtc: number;
}

export const CRAWL_SCHEDULES: Readonly<Record<string, DailySchedule>> = {
  'jobs-ge': { hourUtc: 16, minuteUtc: 10 },
  'hr-ge': { hourUtc: 16, minuteUtc: 10 },
  'etenders-ge': { hourUtc: 16, minuteUtc: 10 },
};

const DAY_MS = 24 * 60 * 60 * 1000;

function slotOnDayOf(schedule: DailySchedule, nowMs: number): number {
  const day = new Date(nowMs);
  return Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    schedule.hourUtc,
    schedule.minuteUtc,
  );
}

/** The latest scheduled start at or before `nowMs`. */
export function previousSlot(schedule: DailySchedule, nowMs: number): number {
  const today = slotOnDayOf(schedule, nowMs);
  return today <= nowMs ? today : today - DAY_MS;
}

/** The first scheduled start after `nowMs`. */
export function nextSlot(schedule: DailySchedule, nowMs: number): number {
  const today = slotOnDayOf(schedule, nowMs);
  return today > nowMs ? today : today + DAY_MS;
}
