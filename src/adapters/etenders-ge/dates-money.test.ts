import { describe, expect, it } from 'vitest';
import { parseEtendersDate } from './dates.js';
import { parseMoneyAmount, parsePriceBasis } from './money.js';

describe('parseEtendersDate', () => {
  it('reads a Tbilisi date-time as UTC+4', () => {
    expect(parseEtendersDate('13/10/2026 15:00')).toEqual({
      raw: '13/10/2026 15:00',
      parsed: '2026-10-13T11:00:00.000Z',
    });
  });

  it('reads seconds, and a bare date as the start of that Tbilisi day', () => {
    expect(parseEtendersDate('28/09/2026 18:14:49').parsed).toBe('2026-09-28T14:14:49.000Z');
    expect(parseEtendersDate('09/10/2026').parsed).toBe('2026-10-08T20:00:00.000Z');
  });

  it('keeps the raw text but refuses impossible or unexpected values', () => {
    expect(parseEtendersDate('31/02/2026')).toEqual({ raw: '31/02/2026', parsed: null });
    expect(parseEtendersDate('16/10/2026 24:00')).toEqual({
      raw: '16/10/2026 24:00',
      parsed: null,
    });
    expect(parseEtendersDate('2026-10-16')).toEqual({ raw: '2026-10-16', parsed: null });
    expect(parseEtendersDate('  ')).toEqual({ raw: null, parsed: null });
    expect(parseEtendersDate(null)).toEqual({ raw: null, parsed: null });
  });

  it('normalises internal whitespace before matching', () => {
    expect(parseEtendersDate(' 05/10/2026   17:47 ').parsed).toBe('2026-10-05T13:47:00.000Z');
  });
});

describe('parsePriceBasis', () => {
  it('reads VAT and currency, with either spelling of the VAT abbreviation', () => {
    expect(parsePriceBasis('დ.ღ.გ-ს ჩათვლით ლარში')).toMatchObject({
      vat: 'included',
      currency: 'GEL',
    });
    expect(parsePriceBasis('დ.ღ.გ-ს ჩათვლით დოლარში')).toMatchObject({
      vat: 'included',
      currency: 'USD',
    });
    expect(parsePriceBasis('დ.ღ.გ.-ს გარეშე დოლარში')).toMatchObject({
      vat: 'excluded',
      currency: 'USD',
    });
    expect(parsePriceBasis('დ.ღ.გ-ს ჩათვლით')).toMatchObject({ vat: 'included', currency: null });
    expect(parsePriceBasis('დ.ღ.გ-ს ჩათვლით ევროში')).toMatchObject({ currency: 'EUR' });
  });

  it('treats "not specified" and empty as null', () => {
    expect(parsePriceBasis('არ არის მითითებული')).toBeNull();
    expect(parsePriceBasis('')).toBeNull();
    expect(parsePriceBasis(undefined)).toBeNull();
  });
});

describe('parseMoneyAmount', () => {
  it('reads space-separated thousands with currency and VAT', () => {
    expect(parseMoneyAmount('12 200 ლარი დ.ღ.გ-ს ჩათვლით')).toEqual({
      raw: '12 200 ლარი დ.ღ.გ-ს ჩათვლით',
      amount: 12200,
      vat: 'included',
      currency: 'GEL',
    });
    expect(parseMoneyAmount('120 000 დოლარი დ.ღ.გ.-ს გარეშე')).toMatchObject({
      amount: 120000,
      vat: 'excluded',
      currency: 'USD',
    });
    expect(parseMoneyAmount('1 000 დოლარი')).toMatchObject({
      amount: 1000,
      vat: null,
      currency: 'USD',
    });
    expect(parseMoneyAmount('2 000 ლარი')).toMatchObject({ amount: 2000, currency: 'GEL' });
  });

  it('reads an unseparated number and a decimal part', () => {
    expect(parseMoneyAmount('140000 ლარი')).toMatchObject({ amount: 140000 });
    expect(parseMoneyAmount('12 200,50 ლარი')).toMatchObject({ amount: 12200.5 });
  });

  it('keeps unparseable text as raw with a null amount, and maps "not specified" to null', () => {
    expect(parseMoneyAmount('შეთანხმებით')).toEqual({
      raw: 'შეთანხმებით',
      amount: null,
      vat: null,
      currency: null,
    });
    expect(parseMoneyAmount('არ არის მითითებული')).toBeNull();
  });
});
