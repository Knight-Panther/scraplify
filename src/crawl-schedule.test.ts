import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CRAWL_SCHEDULES, nextSlot, previousSlot } from './crawl-schedule.js';

const at = (iso: string): number => Date.parse(iso);
const DAILY = { hourUtc: 16, minuteUtc: 10 };

describe('crawl schedule slots', () => {
  it('before the day’s slot: previous is yesterday’s, next is today’s', () => {
    const now = at('2026-09-27T10:00:00Z');
    expect(new Date(previousSlot(DAILY, now)).toISOString()).toBe('2026-09-26T16:10:00.000Z');
    expect(new Date(nextSlot(DAILY, now)).toISOString()).toBe('2026-09-27T16:10:00.000Z');
  });

  it('exactly at the slot: it is the previous one, the next is tomorrow', () => {
    const now = at('2026-09-27T16:10:00Z');
    expect(new Date(previousSlot(DAILY, now)).toISOString()).toBe('2026-09-27T16:10:00.000Z');
    expect(new Date(nextSlot(DAILY, now)).toISOString()).toBe('2026-09-28T16:10:00.000Z');
  });

  it('crosses a month end', () => {
    const now = at('2026-09-30T20:00:00Z');
    expect(new Date(nextSlot(DAILY, now)).toISOString()).toBe('2026-10-01T16:10:00.000Z');
  });
});

describe('CRAWL_SCHEDULES', () => {
  it('declares both sources', () => {
    expect(Object.keys(CRAWL_SCHEDULES).sort()).toEqual(['hr-ge', 'jobs-ge']);
  });

  it('matches the hosted systemd timer, so "next update" states what actually runs', () => {
    const timer = readFileSync(
      new URL('../deploy/systemd/xtelo-pipeline@.timer', import.meta.url),
      'utf8',
    );
    const match = /^OnCalendar=\*-\*-\* (\d{2}):(\d{2}):00 UTC$/m.exec(timer);
    expect(match).not.toBeNull();
    for (const schedule of Object.values(CRAWL_SCHEDULES)) {
      expect(schedule).toEqual({ hourUtc: Number(match?.[1]), minuteUtc: Number(match?.[2]) });
    }
  });
});
