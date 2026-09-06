import { expect, it } from 'vitest';
import { parseJobsGeOptions } from './jobs-ge-options.js';

it('defaults to full and exposes bounded incremental discovery', () => {
  expect(parseJobsGeOptions([])).toEqual({ mode: 'full', missingStreakThreshold: 3 });
  expect(parseJobsGeOptions(['--mode=incremental', '--pages=1'])).toEqual({
    mode: 'incremental',
    incrementalPages: 1,
    missingStreakThreshold: 3,
  });
});
it.each([
  ['--mode=unknown'],
  ['--pages=1'],
  ['--mode=incremental', '--pages=0'],
  ['--mode=incremental', '--pages=201'],
  ['--mode=incremental', '--pages=1.5'],
  ['--typo'],
])('rejects invalid options before starting a crawl: %j', (...args) => {
  expect(() => parseJobsGeOptions(args)).toThrow();
});
