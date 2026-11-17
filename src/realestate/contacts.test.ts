import { describe, expect, it } from 'vitest';
import { fakePhone, fakePhoneTyped } from '../adapters/ss-ge/fakes.js';
import { extractContacts, normaliseEmail, normalisePhone } from './contacts.js';

// Every number here is invented: the reserved range 500 00 00 NN, or digits
// that are not a phone at all.
const phones = (text: string) =>
  extractContacts(text)
    .filter((contact) => contact.kind === 'phone')
    .map((contact) => contact.value);

describe('normalisePhone (a field that states a phone)', () => {
  it('reads a Georgian number with or without +995, however spaced', () => {
    expect(normalisePhone('500000001')).toBe(fakePhone(1));
    expect(normalisePhone('+995 500 00 00 01')).toBe(fakePhone(1));
    expect(normalisePhone('995500000001')).toBe(fakePhone(1));
    expect(normalisePhone('00995500000001')).toBe(fakePhone(1));
    expect(normalisePhone(500000001)).toBe(fakePhone(1));
    expect(normalisePhone('322000001')).toBe('+995322000001');
  });

  it('refuses what is not one, and a masked number', () => {
    for (const value of ['', '12345', '0500000001', '900000001', '500 00 00 **', null, {}]) {
      expect(normalisePhone(value), String(value)).toBeNull();
    }
  });
});

describe('normaliseEmail', () => {
  it('lower-cases and trims, and refuses what is not an address', () => {
    expect(normaliseEmail(' Agent.Fake@Example.Invalid. ')).toBe('agent.fake@example.invalid');
    expect(normaliseEmail('no-at-sign.example')).toBeNull();
    expect(normaliseEmail('a@b')).toBeNull();
  });
});

describe('extractContacts (free text)', () => {
  it('finds mobiles however posters space them, in Georgian and English text', () => {
    expect(phones(`დარეკეთ: ${fakePhoneTyped(1)}`)).toEqual([fakePhone(1)]);
    expect(phones('ტელ: 500-00-00-02, ან 500000003.')).toEqual([fakePhone(2), fakePhone(3)]);
    expect(phones('call +995 500 000 004 or (500) 00 00 05')).toEqual([fakePhone(4), fakePhone(5)]);
    expect(phones('995500000006 მესაკუთრე')).toEqual([fakePhone(6)]);
    expect(phones('ტელ:500000007ზე დარეკეთ')).toEqual([fakePhone(7)]);
  });

  it('finds a Tbilisi landline, written either way', () => {
    expect(phones('ოფისი: 32 2 00 00 01')).toEqual(['+995322000001']);
    expect(phones('office (032) 200-00-02')).toEqual(['+995322000002']);
    expect(phones('+995 32 200 00 03')).toEqual(['+995322000003']);
  });

  it('keeps each phone once, in the order found', () => {
    expect(phones(`${fakePhoneTyped(8)}; ${fakePhoneTyped(8)}; 500000008`)).toEqual([fakePhone(8)]);
  });

  it('never reads a price, an area, a cadastral code, a year or a floor as a phone', () => {
    const text = [
      'ფასი 120000 $',
      'ფასი: 550 000 000 ლარი',
      'price 500000000',
      '1 500 000 ლარი',
      'ფართი 520 მ²',
      'საკადასტრო კოდი 01.10.13.002.015',
      'cadastral 52.06.12.345',
      'cadastral 52.06.12.345.012',
      'აშენდა 2024 წელს',
      'სართული 5/12',
      'ბინა 500.000.001',
      'კოდი 1500000001',
      'id 5000000011',
      '10/500000001',
      'ფასი 500,000001',
    ].join('. ');
    expect(extractContacts(text)).toEqual([]);
  });

  it('finds emails, lower-cased, beside phones', () => {
    expect(extractContacts(`მოგვწერეთ Agent.Fake@Example.Invalid ან ${fakePhoneTyped(9)}`)).toEqual(
      [
        { kind: 'phone', value: fakePhone(9) },
        { kind: 'email', value: 'agent.fake@example.invalid' },
      ],
    );
  });

  it('reads nothing from nothing', () => {
    expect(extractContacts(null)).toEqual([]);
    expect(extractContacts('')).toEqual([]);
  });
});
