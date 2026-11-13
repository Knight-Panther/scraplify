import { describe, expect, it } from 'vitest';
import { parseCredits, parseFee } from './money.js';

describe('parseFee', () => {
  it('1850 EUR and 4640 GBP', () => {
    expect(parseFee('1850 EUR')).toEqual({ amount: 1850, currency: 'EUR', raw: '1850 EUR' });
    expect(parseFee('4640 GBP')).toEqual({ amount: 4640, currency: 'GBP', raw: '4640 GBP' });
    expect(parseFee('14560 NOK')).toEqual({ amount: 14560, currency: 'NOK', raw: '14560 NOK' });
  });

  it('a dot before three digits groups thousands', () => {
    expect(parseFee('1.450 EUR')).toEqual({ amount: 1450, currency: 'EUR', raw: '1.450 EUR' });
    expect(parseFee('1,450 EUR')).toEqual({ amount: 1450, currency: 'EUR', raw: '1,450 EUR' });
    expect(parseFee('99.50 EUR')).toEqual({ amount: 99.5, currency: 'EUR', raw: '99.50 EUR' });
  });

  it('a currency sign is read as its code', () => {
    expect(parseFee('€ 1250')).toMatchObject({ amount: 1250, currency: 'EUR' });
    expect(parseFee('£995')).toMatchObject({ amount: 995, currency: 'GBP' });
  });

  it('an unknown currency keeps the raw text', () => {
    expect(parseFee('1500 euros')).toEqual({ amount: null, currency: null, raw: '1500 euros' });
    expect(parseFee('on request')).toEqual({ amount: null, currency: null, raw: 'on request' });
  });

  it('free', () => {
    expect(parseFee('Free')).toEqual({ amount: 0, currency: null, raw: 'Free' });
    expect(parseFee('free of charge')).toEqual({
      amount: 0,
      currency: null,
      raw: 'free of charge',
    });
  });

  it('no fee printed is null', () => {
    expect(parseFee(null)).toBeNull();
    expect(parseFee('  ')).toBeNull();
  });
});

describe('parseCredits', () => {
  it('reads whole and decimal EC', () => {
    expect(parseCredits('6 EC')).toEqual({ amount: 6, unit: 'EC' });
    expect(parseCredits('7.5 EC')).toEqual({ amount: 7.5, unit: 'EC' });
    expect(parseCredits('12 EC')).toEqual({ amount: 12, unit: 'EC' });
  });

  it('anything else is null', () => {
    expect(parseCredits('none')).toBeNull();
    expect(parseCredits(null)).toBeNull();
  });
});
