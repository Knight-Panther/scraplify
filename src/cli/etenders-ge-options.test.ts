import { describe, expect, it } from 'vitest';
import { parseEtendersGeOptions } from './etenders-ge-options.js';

describe('parseEtendersGeOptions', () => {
  it('defaults to changed-only refetch and the automatic window', () => {
    expect(parseEtendersGeOptions([])).toEqual({ refetch: 'changed' });
  });

  it('accepts a window override and a full refetch', () => {
    expect(parseEtendersGeOptions(['--window-days=90', '--refetch=all'])).toEqual({
      refetch: 'all',
      windowDays: 90,
    });
  });

  it('rejects bad values and unknown flags', () => {
    expect(() => parseEtendersGeOptions(['--window-days=0'])).toThrow();
    expect(() => parseEtendersGeOptions(['--window-days=121'])).toThrow();
    expect(() => parseEtendersGeOptions(['--window-days=7.5'])).toThrow();
    expect(() => parseEtendersGeOptions(['--refetch=some'])).toThrow();
    expect(() => parseEtendersGeOptions(['--mode=full'])).toThrow();
  });
});
