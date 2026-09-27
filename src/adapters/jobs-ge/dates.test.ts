import { describe, expect, it } from 'vitest';
import {
  parseYearlessDeadlineDate,
  parseYearlessGeorgianDate,
  parseYearlessPublishedDate,
} from './dates.js';

// The live case that found this (2026-09-27): jobs.ge 679178, fetched on 26
// September, showed "03 ნოემბერი" / "07 ნოემბერი" — last November's listing,
// still up. Closest-year parsing put both into the coming November.
describe('parseYearlessPublishedDate', () => {
  const fetchedAt = '2026-09-26T20:36:13Z';

  it('puts a month-ahead publication date in the past year, never the future', () => {
    expect(parseYearlessPublishedDate('03 ნოემბერი', fetchedAt).parsed).toBe(
      '2025-11-03T00:00:00+04:00',
    );
  });

  it('keeps a recent publication date in the current year', () => {
    expect(parseYearlessPublishedDate('20 სექტემბერი', fetchedAt).parsed).toBe(
      '2026-09-20T00:00:00+04:00',
    );
  });

  it('accepts the fetch day itself and one day of clock slack', () => {
    expect(parseYearlessPublishedDate('27 სექტემბერი', fetchedAt).parsed).toBe(
      '2026-09-27T00:00:00+04:00',
    );
    expect(parseYearlessPublishedDate('28 სექტემბერი', fetchedAt).parsed).toBe(
      '2026-09-28T00:00:00+04:00',
    );
    expect(parseYearlessPublishedDate('29 სექტემბერი', fetchedAt).parsed).toBe(
      '2025-09-29T00:00:00+04:00',
    );
  });

  it('crosses the year boundary backwards: late December seen in early January', () => {
    expect(parseYearlessPublishedDate('28 დეკემბერი', '2027-01-05T09:00:00Z').parsed).toBe(
      '2026-12-28T00:00:00+04:00',
    );
  });

  it('is stable as the fetch moves later, unlike closest-year parsing', () => {
    for (const at of ['2026-04-10T12:00:00Z', '2026-09-05T12:00:00Z', '2026-11-01T12:00:00Z']) {
      expect(parseYearlessPublishedDate('02 აპრილი', at).parsed).toBe('2026-04-02T00:00:00+04:00');
    }
  });

  it('returns parsed: null for malformed input', () => {
    expect(parseYearlessPublishedDate('სექტემბერი', fetchedAt)).toEqual({
      raw: 'სექტემბერი',
      parsed: null,
    });
  });
});

describe('parseYearlessDeadlineDate', () => {
  const fetchedAt = '2026-09-26T20:36:13Z';

  it('keeps a long-past deadline in its publication year (the expired listing stays expired)', () => {
    const published = parseYearlessPublishedDate('03 ნოემბერი', fetchedAt).parsed;
    expect(parseYearlessDeadlineDate('07 ნოემბერი', fetchedAt, published).parsed).toBe(
      '2025-11-07T00:00:00+04:00',
    );
  });

  it('puts a normal month-ahead deadline in the current year', () => {
    const published = parseYearlessPublishedDate('20 სექტემბერი', fetchedAt).parsed;
    expect(parseYearlessDeadlineDate('20 ოქტომბერი', fetchedAt, published).parsed).toBe(
      '2026-10-20T00:00:00+04:00',
    );
  });

  it('rolls a deadline into the next year when published in December', () => {
    const at = '2026-12-20T12:00:00Z';
    const published = parseYearlessPublishedDate('18 დეკემბერი', at).parsed;
    expect(parseYearlessDeadlineDate('15 იანვარი', at, published).parsed).toBe(
      '2027-01-15T00:00:00+04:00',
    );
  });

  it('accepts a deadline on the publication day itself', () => {
    const published = parseYearlessPublishedDate('20 სექტემბერი', fetchedAt).parsed;
    expect(parseYearlessDeadlineDate('20 სექტემბერი', fetchedAt, published).parsed).toBe(
      '2026-09-20T00:00:00+04:00',
    );
  });

  it('falls back to the closest year without a publication date', () => {
    expect(parseYearlessDeadlineDate('02 ოქტომბერი', '2026-09-04T12:00:00Z', null).parsed).toBe(
      '2026-10-02T00:00:00+04:00',
    );
  });
});

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

  it('resolves the same yearless raw string to a different year as the reference instant moves', () => {
    // Pins the drift adversarial review (2026-09-05, round 8) identified:
    // meaningfulContentHash (detail.ts) covers this RAW string, not the
    // parsed instant below — so write-source-listing-revision.ts cannot
    // assume an unchanged hash means an unchanged parsed date.
    const nearby = parseYearlessGeorgianDate('02 აპრილი', '2026-09-05T12:00:00Z');
    expect(nearby.parsed).toBe('2026-04-02T00:00:00+04:00');

    const farther = parseYearlessGeorgianDate('02 აპრილი', '2026-11-01T12:00:00Z');
    expect(farther.parsed).toBe('2027-04-02T00:00:00+04:00');
  });

  it('tolerates extra internal whitespace', () => {
    const result = parseYearlessGeorgianDate('  02   სექტემბერი  ', '2026-09-04T12:00:00Z');
    expect(result.parsed).toBe('2026-09-02T00:00:00+04:00');
  });
});
