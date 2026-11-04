import { describe, expect, it } from 'vitest';
import { parseSsGeOptions } from './ss-ge-options.js';

describe('parseSsGeOptions', () => {
  it('defaults to a nightly run with the standing budgets', () => {
    expect(parseSsGeOptions([])).toEqual({ mode: 'nightly' });
  });

  it('accepts a sweep, a page limit, a check budget and a fresh start', () => {
    expect(
      parseSsGeOptions(['--mode=sweep', '--max-pages=500', '--max-detail-checks=0', '--fresh']),
    ).toEqual({ mode: 'sweep', maxPages: 500, maxDetailChecks: 0, fresh: true });
  });

  it('rejects bad values and unknown flags', () => {
    expect(() => parseSsGeOptions(['--mode=full'])).toThrow();
    expect(() => parseSsGeOptions(['--max-pages=0'])).toThrow();
    expect(() => parseSsGeOptions(['--max-pages=2.5'])).toThrow();
    expect(() => parseSsGeOptions(['--max-pages=abc'])).toThrow();
    expect(() => parseSsGeOptions(['--max-detail-checks=-1'])).toThrow();
    expect(() => parseSsGeOptions(['--max-detail-checks=20001'])).toThrow();
    expect(() => parseSsGeOptions(['--refetch=all'])).toThrow();
  });

  it("accepts a time box of 1 to 19 hours, under the unit's 20", () => {
    expect(parseSsGeOptions(['--stop-after-hours=1'])).toEqual({
      mode: 'nightly',
      stopAfterMs: 60 * 60 * 1000,
    });
    expect(parseSsGeOptions(['--stop-after-hours=19']).stopAfterMs).toBe(19 * 60 * 60 * 1000);
    expect(() => parseSsGeOptions(['--stop-after-hours=20'])).toThrow();
    expect(() => parseSsGeOptions(['--stop-after-hours=0'])).toThrow();
    expect(() => parseSsGeOptions(['--stop-after-hours=21'])).toThrow();
    expect(() => parseSsGeOptions(['--stop-after-hours=1.5'])).toThrow();
  });

  it('accepts a fresh start for a nightly run, which resumes an interrupted one otherwise', () => {
    expect(parseSsGeOptions(['--fresh'])).toEqual({ mode: 'nightly', fresh: true });
  });
});
