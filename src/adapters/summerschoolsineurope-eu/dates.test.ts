import { describe, expect, it } from 'vitest';
import { deadlineInstant, parseFullDate, parseWhen, resolveCardDeadline } from './dates.js';

describe('parseWhen', () => {
  it('a range within one year', () => {
    expect(parseWhen('18 July - 05 August 2027')).toEqual({
      raw: '18 July - 05 August 2027',
      startDate: '2027-07-18',
      endDate: '2027-08-05',
      durationDays: 19,
      suspect: false,
    });
  });

  it('a range across months and years', () => {
    expect(parseWhen('28 December - 08 January 2027')).toMatchObject({
      startDate: '2026-12-28',
      endDate: '2027-01-08',
      durationDays: 12,
      suspect: false,
    });
    expect(parseWhen('05 February 2027 - 15 April 2028')).toMatchObject({
      startDate: '2027-02-05',
      endDate: '2028-04-15',
      suspect: false,
    });
  });

  it('end before start is kept raw and marked suspect', () => {
    expect(parseWhen('28 June - 02 June 2027')).toEqual({
      raw: '28 June - 02 June 2027',
      startDate: '2027-06-28',
      endDate: '2027-06-02',
      durationDays: null,
      suspect: true,
    });
  });

  it('an unknown shape or an impossible day keeps the raw text and no dates', () => {
    for (const raw of ['Summer 2027', '31 February - 05 March 2027', '']) {
      expect(parseWhen(raw)).toMatchObject({ startDate: null, endDate: null, suspect: false });
    }
    expect(parseWhen(null)).toMatchObject({ raw: null, startDate: null });
  });
});

describe('resolveCardDeadline', () => {
  it('a yearless deadline takes the latest year not after the start date', () => {
    expect(resolveCardDeadline('01 December', '2027-01-25', '2027-01-29')).toBe('2026-12-01');
    expect(resolveCardDeadline('30 November', '2027-01-05', '2027-01-15')).toBe('2026-11-30');
    expect(resolveCardDeadline('01 June', '2027-07-18', '2027-08-05')).toBe('2027-06-01');
    // On the start date itself still fits.
    expect(resolveCardDeadline('18 July', '2027-07-18', '2027-08-05')).toBe('2027-07-18');
  });

  it('two fitting years or none give an unparsed deadline', () => {
    // 01 March falls both a year before the start and inside the course: no guess.
    expect(resolveCardDeadline('01 March', '2027-02-05', '2027-04-15')).toBeNull();
    expect(resolveCardDeadline('30 February', '2027-07-18', '2027-08-05')).toBeNull();
    expect(resolveCardDeadline('soon', '2027-07-18', '2027-08-05')).toBeNull();
    expect(resolveCardDeadline('01 June', null, null)).toBeNull();
  });

  it('29 February takes the latest leap year that fits', () => {
    expect(resolveCardDeadline('29 February', '2028-07-01', '2028-07-20')).toBe('2028-02-29');
    expect(resolveCardDeadline('29 February', '2027-07-01', '2027-07-20')).toBeNull();
  });
});

describe('deadlineInstant', () => {
  it('a deadline is the end of its day at +04:00', () => {
    expect(deadlineInstant('2026-12-01')).toBe('2026-12-01T19:59:59.000Z');
  });
});

describe('parseFullDate', () => {
  it('reads a printed day with its year, and nothing else', () => {
    expect(parseFullDate('07 February 2027')).toBe('2027-02-07');
    expect(parseFullDate('1 March 2027')).toBe('2027-03-01');
    expect(parseFullDate('31 February 2027')).toBeNull();
    expect(parseFullDate('07 February')).toBeNull();
    expect(parseFullDate(null)).toBeNull();
  });
});
