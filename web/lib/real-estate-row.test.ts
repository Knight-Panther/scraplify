import { describe, expect, it } from 'vitest';
import type { RealEstateRow } from '../../src/realestate/queries.js';
import {
  floorText,
  listingLabel,
  money,
  perMetre,
  placeText,
  posterText,
  priceOf,
  streetText,
} from './real-estate-row.js';

function row(overrides: Partial<RealEstateRow> = {}): RealEstateRow {
  return {
    id: 'id',
    canonicalUrl: 'https://home.ss.ge/ka/udzravi-qoneba/1',
    dealType: 'sale',
    propertyType: 'flat',
    rooms: 3,
    bedrooms: 2,
    areaM2: 80,
    floor: 6,
    totalFloors: 14,
    priceGel: 270000,
    priceUsd: 100000,
    pricePerM2Usd: 1250,
    currencyPosted: 'usd',
    cityName: 'თბილისი',
    districtName: 'ვაკე-საბურთალო',
    subdistrictName: 'საბურთალო',
    streetName: 'უნივერსიტეტის ქ.',
    streetNumber: '2',
    posterType: 'agent',
    promoted: false,
    sourceUpdatedAt: '2026-10-12T12:00:00.000Z',
    firstSeenAt: '2026-10-12T12:00:00.000Z',
    groupKey: null,
    alikeCount: 1,
    ...overrides,
  };
}

describe('real-estate row text', () => {
  it('names a listing by its kind and deal, never by a database value', () => {
    expect(listingLabel(row())).toBe('Flat for sale');
    expect(listingLabel(row({ propertyType: 'house', dealType: 'rent' }))).toBe('House for rent');
    expect(listingLabel(row({ propertyType: 'cottage' }))).toBe('Summer cottage for sale');
  });

  it('writes a floor as "6 / 14" and leaves out what is not known', () => {
    expect(floorText(row())).toBe('6 / 14');
    expect(floorText(row({ totalFloors: null }))).toBe('6');
    // A house has storeys, not a floor it is on.
    expect(floorText(row({ floor: null, totalFloors: 2 }))).toBe('2 floors');
    expect(floorText(row({ floor: null, totalFloors: 1 }))).toBe('1 floor');
    expect(floorText(row({ floor: null, totalFloors: null }))).toBeNull();
  });

  it('gives the price in the currency asked for, as the source stated it', () => {
    expect(priceOf(row(), 'usd')).toBe(100000);
    expect(priceOf(row(), 'gel')).toBe(270000);
    expect(priceOf(row({ priceGel: null }), 'gel')).toBeNull();
    expect(money(100000, 'usd')).toBe('$100,000');
    expect(money(270000, 'gel')).toBe('270,000 ₾');
    expect(money(1250.6, 'usd')).toBe('$1,251');
  });

  it('works the price per square metre out of the price shown, or says nothing', () => {
    expect(perMetre(row(), 'usd')).toBe(1250);
    expect(perMetre(row(), 'gel')).toBe(3375);
    expect(perMetre(row({ areaM2: null }), 'usd')).toBeNull();
    expect(perMetre(row({ areaM2: 0 }), 'usd')).toBeNull();
    expect(perMetre(row({ priceUsd: null }), 'usd')).toBeNull();
  });

  it('names the place from the most local name it has', () => {
    expect(placeText(row())).toBe('საბურთალო, თბილისი');
    expect(placeText(row({ subdistrictName: null }))).toBe('ვაკე-საბურთალო, თბილისი');
    expect(placeText(row({ subdistrictName: null, districtName: null }))).toBe('თბილისი');
    expect(
      placeText(row({ subdistrictName: null, districtName: null, cityName: null })),
    ).toBeNull();
  });

  it('joins a street and its number, when there is a street', () => {
    expect(streetText(row())).toBe('უნივერსიტეტის ქ. 2');
    expect(streetText(row({ streetNumber: null }))).toBe('უნივერსიტეტის ქ.');
    expect(streetText(row({ streetName: null }))).toBeNull();
  });

  it('says who posted only when the source marks it', () => {
    expect(posterText(row())).toBe('agency');
    expect(posterText(row({ posterType: 'developer' }))).toBe('developer');
    expect(posterText(row({ posterType: 'owner' }))).toBe('owner');
    // "Unknown" is not something to print on every other row.
    expect(posterText(row({ posterType: 'unknown' }))).toBeNull();
  });
});
