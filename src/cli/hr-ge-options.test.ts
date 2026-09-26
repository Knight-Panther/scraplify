import { expect, it } from 'vitest';
import { parseHrGeOptions } from './hr-ge-options.js';

it('defaults to full and exposes bounded incremental discovery', () => {
  expect(parseHrGeOptions([])).toEqual({
    mode: 'full',
    missingStreakThreshold: 3,
    refetch: 'changed',
  });
  expect(parseHrGeOptions(['--mode=incremental', '--pages=1'])).toEqual({
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
  expect(() => parseHrGeOptions(args)).toThrow();
});
it('only lifts the mass-closure cap when explicitly asked to', () => {
  expect(parseHrGeOptions([])).not.toHaveProperty('allowMassClosure');
  expect(parseHrGeOptions(['--allow-mass-closure'])).toEqual({
    mode: 'full',
    missingStreakThreshold: 3,
    refetch: 'changed',
    allowMassClosure: true,
  });
});
it('fetches only changed listings by default, and every listing when asked (Phase 7C)', () => {
  expect(parseHrGeOptions([]).refetch).toBe('changed');
  expect(parseHrGeOptions(['--refetch=all']).refetch).toBe('all');
});
