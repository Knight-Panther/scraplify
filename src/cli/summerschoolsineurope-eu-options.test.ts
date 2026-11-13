import { describe, expect, it } from 'vitest';
import { parseSummerSchoolsEuOptions } from './summerschoolsineurope-eu-options.js';

describe('parseSummerSchoolsEuOptions', () => {
  it('defaults to changed course pages and changed sitemaps', () => {
    expect(parseSummerSchoolsEuOptions([])).toEqual({ refetch: 'changed', sitemaps: 'changed' });
  });

  it('reads every flag', () => {
    expect(
      parseSummerSchoolsEuOptions([
        '--refetch=all',
        '--sitemaps=all',
        '--max-listing-requests=20',
        '--max-detail-fetches=10',
        '--allow-mass-closure',
      ]),
    ).toEqual({
      refetch: 'all',
      sitemaps: 'all',
      maxListingRequests: 20,
      maxDetailFetches: 10,
      allowMassClosure: true,
    });
  });

  it('refuses unknown flags and values out of range', () => {
    expect(() => parseSummerSchoolsEuOptions(['--max-pages=2'])).toThrow();
    expect(() => parseSummerSchoolsEuOptions(['--refetch=some'])).toThrow(/refetch/);
    expect(() => parseSummerSchoolsEuOptions(['--sitemaps=none'])).toThrow(/sitemaps/);
    expect(() => parseSummerSchoolsEuOptions(['--max-listing-requests=0'])).toThrow(/listing/);
    expect(() => parseSummerSchoolsEuOptions(['--max-detail-fetches=1.5'])).toThrow(/detail/);
    expect(() => parseSummerSchoolsEuOptions(['--max-detail-fetches=5000'])).toThrow(/detail/);
  });
});
