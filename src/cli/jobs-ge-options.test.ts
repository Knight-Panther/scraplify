import { expect, it } from 'vitest';
import { parseJobsGeOptions } from './jobs-ge-options.js';

it('defaults to full and exposes bounded incremental discovery', () => {
  expect(parseJobsGeOptions([])).toEqual({
    mode: 'full',
    missingStreakThreshold: 3,
    refetch: 'changed',
  });
  expect(parseJobsGeOptions(['--mode=incremental', '--pages=1'])).toEqual({
    mode: 'incremental',
    incrementalPages: 1,
    missingStreakThreshold: 3,
    refetch: 'changed',
  });
});
it.each([
  ['--mode=unknown'],
  ['--pages=1'],
  ['--mode=incremental', '--pages=0'],
  ['--mode=incremental', '--pages=201'],
  ['--mode=incremental', '--pages=1.5'],
  ['--typo'],
  ['--refetch=sometimes'],
])('rejects invalid options before starting a crawl: %j', (...args) => {
  expect(() => parseJobsGeOptions(args)).toThrow();
});
it('only lifts the mass-closure cap when explicitly asked to', () => {
  expect(parseJobsGeOptions([])).not.toHaveProperty('allowMassClosure');
  expect(parseJobsGeOptions(['--allow-mass-closure'])).toEqual({
    mode: 'full',
    missingStreakThreshold: 3,
    refetch: 'changed',
    allowMassClosure: true,
  });
});
it('fetches only changed listings by default, and every listing when asked (Phase 7C)', () => {
  expect(parseJobsGeOptions([]).refetch).toBe('changed');
  expect(parseJobsGeOptions(['--refetch=all']).refetch).toBe('all');
});
