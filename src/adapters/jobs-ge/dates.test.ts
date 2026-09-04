import { describe, expect, it } from 'vitest';
import { parseYearlessGeorgianDate } from './dates.js';

describe('parseYearlessGeorgianDate', () => {
  it('parses a date shortly after the reference instant as the current year', () => {
    const result = parseYearlessGeorgianDate('02 სექტემბერი', '2026-09-04T12:00:00Z');
    expect(result).toEqual({ raw: '02 სექტემბერი', parsed: '2026-09-02T00:00:00+04:00' });
  });

  it('parses a near-future deadline (~1 month out) as the current year, not next year', () => {
    const result = parseYearlessGeorgianDate('02 ოქტომბერი', '2026-09-04T12:00:00Z');
    expect(result).toEqual({ raw: '02 ოქტომბერი', parsed: '2026-10-02T00:00:00+04:00' });
  });

  it('infers the previous year for a date shortly before a year boundary reference', () => {
    // Reference is early January; "28 December" is closer as last year's
    // December than as this year's (11 months away either direction if it
    // were forced into the current year).
    const result = parseYearlessGeorgianDate('28 დეკემბერი', '2026-01-05T12:00:00Z');
    expect(result).toEqual({ raw: '28 დეკემბერი', parsed: '2025-12-28T00:00:00+04:00' });
  });

  it('infers the next year for a date shortly after a year boundary reference', () => {
    // Reference is late December; "03 იანვარი" is closer as next year's
    // January than as this year's.
    const result = parseYearlessGeorgianDate('03 იანვარი', '2026-12-28T12:00:00Z');
    expect(result).toEqual({ raw: '03 იანვარი', parsed: '2027-01-03T00:00:00+04:00' });
  });

  it('handles 29 February against a reference in a leap year', () => {
    const result = parseYearlessGeorgianDate('29 თებერვალი', '2028-02-20T12:00:00Z');
    expect(result).toEqual({ raw: '29 თებერვალი', parsed: '2028-02-29T00:00:00+04:00' });
  });

  it('skips a non-leap candidate year for 29 February rather than rolling into March', () => {
    // 2026 and 2027 are both non-leap; only 2028 (one of the three
    // candidates around a 2027 reference) actually has a 29 February.
    const result = parseYearlessGeorgianDate('29 თებერვალი', '2027-12-15T12:00:00Z');
    expect(result).toEqual({ raw: '29 თებერვალი', parsed: '2028-02-29T00:00:00+04:00' });
  });

  it('returns parsed: null for an unrecognized month name', () => {
    const result = parseYearlessGeorgianDate('02 NotAMonth', '2026-09-04T12:00:00Z');
    expect(result).toEqual({ raw: '02 NotAMonth', parsed: null });
  });

  it('returns parsed: null for malformed input', () => {
    const result = parseYearlessGeorgianDate('სექტემბერი', '2026-09-04T12:00:00Z');
    expect(result).toEqual({ raw: 'სექტემბერი', parsed: null });
  });

  it('returns parsed: null for a day out of range', () => {
    const result = parseYearlessGeorgianDate('32 სექტემბერი', '2026-09-04T12:00:00Z');
    expect(result).toEqual({ raw: '32 სექტემბერი', parsed: null });
  });

  it('tolerates extra internal whitespace', () => {
    const result = parseYearlessGeorgianDate('  02   სექტემბერი  ', '2026-09-04T12:00:00Z');
    expect(result.parsed).toBe('2026-09-02T00:00:00+04:00');
  });
});
