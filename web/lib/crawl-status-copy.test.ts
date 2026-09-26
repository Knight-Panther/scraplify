import { describe, expect, it } from 'vitest';
import { countdown, updateClock, updateDateTime } from './crawl-status-copy.js';

const now = Date.parse('2026-09-27T10:58:00Z');
const minutes = (count: number): number => now + count * 60_000;

describe('countdown', () => {
  it('reads hours and minutes, in both locales', () => {
    expect(countdown(minutes(312), now, 'en')).toBe('in 5 h 12 min');
    expect(countdown(minutes(312), now, 'ka')).toBe('5 სთ 12 წთ-ში');
  });

  it('drops a zero part', () => {
    expect(countdown(minutes(300), now, 'en')).toBe('in 5 h');
    expect(countdown(minutes(12), now, 'en')).toBe('in 12 min');
    expect(countdown(minutes(12), now, 'ka')).toBe('12 წთ-ში');
  });

  it('rounds up, so it never reads a minute early', () => {
    expect(countdown(now + 61_000, now, 'en')).toBe('in 2 min');
  });

  it('says "under a minute" at the end, and after the slot', () => {
    expect(countdown(now + 59_000, now, 'en')).toBe('in under a minute');
    expect(countdown(now - 5_000, now, 'ka')).toBe('წუთზე ნაკლებში');
  });
});

describe('update times', () => {
  it('are Tbilisi time, with the year', () => {
    const iso = '2026-09-27T16:13:00Z';
    expect(updateDateTime(iso, 'en')).toBe('27 Sep 2026, 20:13');
    expect(updateDateTime(iso, 'ka')).toBe('27 სექ. 2026, 20:13');
    // Crossing midnight in Tbilisi moves the date, not only the clock.
    expect(updateDateTime('2026-12-31T20:30:00Z', 'en')).toBe('1 Jan 2027, 00:30');
    expect(updateClock('2026-09-27T16:10:00Z')).toBe('20:10');
  });
});
