import { describe, expect, it } from 'vitest';
import { RATES_DATE, toEur, toGel } from './reference-rates.js';

describe('reference rates', () => {
  it('are dated', () => {
    expect(RATES_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('convert through lari, whatever the case of the code', () => {
    expect(toGel(100, 'GEL')).toBe(100);
    expect(toEur(100, 'EUR')).toBeCloseTo(100, 6);
    expect(toEur(100, 'gbp')).toBeCloseTo((100 * 3.4287) / 2.8649, 6);
    expect(toGel(10, 'NOK')).toBeCloseTo(2.7107, 6);
  });

  it('never guess a currency they do not hold', () => {
    expect(toGel(100, 'PLN')).toBeNull();
    expect(toEur(100, 'XYZ')).toBeNull();
    expect(toGel(Number.NaN, 'EUR')).toBeNull();
  });
});
