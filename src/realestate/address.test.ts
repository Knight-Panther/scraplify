import { describe, expect, it } from 'vitest';
import { parseHouseNumber } from './address.js';

/** The shapes posters typed on the active Tbilisi listings of 2026-11-06, and how each reads. */
describe('parseHouseNumber', () => {
  it.each([
    ['12', 12, null],
    [' 75 ', 75, null],
    ['117დ', 117, 'დ'],
    ['35 ა', 35, 'ა'],
    ['12A', 12, 'a'],
    ['№12', 12, null],
    ['N 12', 12, null],
    ['#4ბ', 4, 'ბ'],
    ['49-51', 49, null],
    ['9–11', 9, null],
    ['12/14', 12, null],
    ['2-4ბ', 2, null],
  ])('reads %j as number %s, letter %s', (raw, houseNumber, houseSuffix) => {
    expect(parseHouseNumber(raw)).toEqual({ houseNumber, houseSuffix });
  });

  it.each([
    [null],
    [''],
    ['0'],
    ['00'],
    ['.'],
    [','],
    ['დიღმის'],
    ['ლილო'],
    ['7ბ ბლოკი'],
    ['12 კორპ.'],
    ['Mსამედიცინო უნივერსიტეტი'],
    ['12345'],
  ])('reads %j as no house number', (raw) => {
    expect(parseHouseNumber(raw)).toEqual({ houseNumber: null, houseSuffix: null });
  });
});
