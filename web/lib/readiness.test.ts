import { describe, expect, it } from 'vitest';
import { MAX_BUNDLE_AGE_HOURS } from '../../src/matching/bundle/contract.js';
import { matchingState, summarize } from './readiness.js';

describe('summarize', () => {
  it('is ready whenever the database is up, whatever matching says', () => {
    for (const matching of ['ok', 'stale', 'unavailable', 'not_served'] as const) {
      expect(summarize('public', 'ok', matching).status).toBe('ready');
    }
  });

  it('is not ready when the database is down', () => {
    expect(summarize('public', 'down', 'unavailable')).toEqual({
      status: 'not_ready',
      surface: 'public',
      database: 'down',
      matching: 'unavailable',
    });
  });
});

describe('matchingState', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

  it('is ok inside the bundle age limit and stale past it', () => {
    expect(matchingState(hoursAgo(1), now)).toBe('ok');
    expect(matchingState(hoursAgo(MAX_BUNDLE_AGE_HOURS - 0.1), now)).toBe('ok');
    expect(matchingState(hoursAgo(MAX_BUNDLE_AGE_HOURS + 0.1), now)).toBe('stale');
  });

  it('is unavailable with no bundle', () => {
    expect(matchingState(null, now)).toBe('unavailable');
  });
});
