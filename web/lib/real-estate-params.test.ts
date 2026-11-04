import { describe, expect, it } from 'vitest';
import type { RealEstateLocations } from '../../src/realestate/queries.js';
import {
  buildRealEstateHref,
  isFiltered,
  parseRealEstateQuery,
  REAL_ESTATE_CHUNK,
  REAL_ESTATE_MAX_SHOWN,
} from './real-estate-params.js';

const NOW = Date.parse('2026-10-12T22:00:00.000Z');

const PLACES: RealEstateLocations = {
  cities: [
    { ref: 95, name: 'თბილისი', count: 900 },
    { ref: 96, name: 'ბათუმი', count: 100 },
  ],
  subdistricts: [
    {
      ref: 3,
      name: 'საბურთალო',
      count: 200,
      cityRef: 95,
      districtRef: 3,
      districtName: 'ვაკე-საბურთალო',
    },
    {
      ref: 2,
      name: 'ვაკე',
      count: 150,
      cityRef: 95,
      districtRef: 3,
      districtName: 'ვაკე-საბურთალო',
    },
    {
      ref: 40,
      name: 'ძველი ბათუმი',
      count: 30,
      cityRef: 96,
      districtRef: null,
      districtName: null,
    },
  ],
};

const parse = (raw: Record<string, string | string[]>) => parseRealEstateQuery(raw, PLACES, NOW);

describe('parseRealEstateQuery', () => {
  describe('sub-types (Phase 12A)', () => {
    it('accepts several commercial types and drops unknown codes', () => {
      const query = parse({ kind: 'commercial', ct: ['22', '7', '99', 'x', '7', ''] });

      // In the order of the code list, so one choice has one address.
      expect(query.form.ct).toEqual(['7', '22']);
      expect(query.filters.commercialTypes).toEqual([7, 22]);
      expect(query.filters.propertyType).toBe('commercial');
    });

    it('accepts land types the same way', () => {
      const query = parse({ kind: 'land', lt: '6' });

      expect(query.form.lt).toEqual(['6']);
      expect(query.filters.landTypes).toEqual([6]);
    });

    it('ignores commercial types when the kind is not commercial', () => {
      const flat = parse({ kind: 'flat', ct: '7', lt: '1' });
      expect(flat.form).toMatchObject({ ct: [], lt: [] });
      expect(flat.filters).not.toHaveProperty('commercialTypes');
      expect(flat.filters).not.toHaveProperty('landTypes');
      // No kind at all is not commercial either.
      expect(parse({ ct: '7' }).filters).not.toHaveProperty('commercialTypes');
      expect(isFiltered(parse({ ct: '7' }))).toBe(false);
    });

    it('writes repeated parameters back into the address', () => {
      const query = parse({ kind: 'commercial', ct: ['22', '7'], deal: 'daily' });

      expect(buildRealEstateHref(query)).toBe('/real-estate?deal=daily&kind=commercial&ct=7&ct=22');
      expect(isFiltered(query)).toBe(true);
    });

    it('accepts every kind and deal', () => {
      for (const kind of ['flat', 'house', 'cottage', 'commercial', 'land', 'hotel']) {
        expect(parse({ kind }).filters.propertyType).toBe(kind);
      }
      for (const deal of ['sale', 'rent', 'daily', 'pledge']) {
        expect(parse({ deal }).filters.dealType).toBe(deal);
      }
    });
  });

  it('asks for everything, newest first, in dollars, when the address says nothing', () => {
    const query = parse({});

    expect(query.filters).toEqual({ currency: 'usd', sort: 'newest', grouped: true });
    expect(query.show).toBe(REAL_ESTATE_CHUNK);
    expect(buildRealEstateHref(query)).toBe('/real-estate');
  });

  it('reads every filter from the address', () => {
    const query = parse({
      deal: 'rent',
      kind: 'flat',
      city: '95',
      area: 's3',
      cur: 'gel',
      pmin: '1000',
      pmax: '2500',
      amin: '40',
      amax: '90',
      rooms: '2',
      floor: 'middle',
      by: 'business',
      since: '7',
      q: ' ავეჯით ',
      sort: 'price-asc',
    });

    expect(query.filters).toEqual({
      dealType: 'rent',
      propertyType: 'flat',
      cityRef: 95,
      subdistrictRef: 3,
      currency: 'gel',
      priceMin: 1000,
      priceMax: 2500,
      areaMin: 40,
      areaMax: 90,
      rooms: 2,
      floor: 'middle',
      poster: 'business',
      updatedSince: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString(),
      text: 'ავეჯით',
      sort: 'price-asc',
      grouped: true,
    });
  });

  it('reads a whole district and "five rooms or more"', () => {
    const query = parse({ city: '95', area: 'd3', rooms: '5+' });

    expect(query.filters).toMatchObject({
      cityRef: 95,
      districtRef: 3,
      rooms: 5,
      roomsOrMore: true,
    });
    expect(query.filters.subdistrictRef).toBeUndefined();
  });

  it('drops what it does not recognise, so the form and the results always agree', () => {
    const query = parse({
      deal: 'swap',
      kind: 'castle',
      city: '7',
      area: 's3',
      cur: 'eur',
      pmin: '-5',
      pmax: 'cheap',
      amin: '1e9',
      rooms: '0',
      floor: 'basement',
      by: 'me',
      since: '2',
      sort: 'random',
      view: 'some',
      group: 'not-a-key',
    });

    expect(query.filters).toEqual({ currency: 'usd', sort: 'newest', grouped: true });
    expect(query.form).toMatchObject({
      deal: '',
      kind: '',
      city: '',
      area: '',
      pmin: '',
      rooms: '',
      view: '',
      group: '',
    });
  });

  it('drops an area that is not in the chosen city', () => {
    // Saburtalo is in Tbilisi; with Batumi chosen the two cannot both hold.
    const query = parse({ city: '96', area: 's3' });

    expect(query.filters).toMatchObject({ cityRef: 96 });
    expect(query.filters.subdistrictRef).toBeUndefined();
    expect(query.form.area).toBe('');
  });

  it('takes the first value when a parameter is repeated', () => {
    expect(parse({ deal: ['rent', 'sale'] }).filters.dealType).toBe('rent');
  });

  it('caps the search text by character, never mid-letter', () => {
    const query = parse({ q: 'ა'.repeat(500) });

    expect([...(query.filters.text ?? '')]).toHaveLength(120);
  });

  it('folds look-alikes unless asked for every listing, and lists one group by its key', () => {
    expect(parse({ view: 'all' }).filters).toMatchObject({ grouped: false });
    const key = '6a546aed-492a-4cf2-9627-072e6fc768bf';
    const query = parse({ group: key.toUpperCase() });
    expect(query.filters.groupKey).toBe(key);
    expect(query.filters.grouped).toBeUndefined();
    expect(isFiltered(query)).toBe(true);
    // Grouped or not is how the list is shown, not a narrowing of it.
    expect(isFiltered(parse({ view: 'all' }))).toBe(false);
  });

  it('rounds the depth up to whole chunks and stops at the most a page will show', () => {
    expect(parse({ show: '150' }).show).toBe(200);
    expect(parse({ show: '99999999' }).show).toBe(REAL_ESTATE_MAX_SHOWN);
    expect(parse({ show: 'lots' }).show).toBe(REAL_ESTATE_CHUNK);
  });
});

describe('buildRealEstateHref', () => {
  it('writes back exactly the state it read', () => {
    const raw = {
      deal: 'rent',
      kind: 'flat',
      city: '95',
      area: 's3',
      cur: 'gel',
      pmin: '1000',
      pmax: '2500',
      amin: '40',
      amax: '90',
      rooms: '5+',
      floor: 'not-first',
      by: 'other',
      since: '3',
      q: 'ავეჯით',
      sort: 'area-desc',
      view: 'all',
      show: '300',
    };
    const href = buildRealEstateHref(parse(raw));
    const params = Object.fromEntries(new URL(href, 'https://x.invalid').searchParams);

    expect(params).toEqual(raw);
  });

  it('changes one thing and keeps the rest', () => {
    const query = parse({ deal: 'rent', q: 'ვაკე', show: '300' });

    expect(buildRealEstateHref(query, { show: 400 })).toBe(
      `/real-estate?${new URLSearchParams({ deal: 'rent', q: 'ვაკე', show: '400' })}`,
    );
  });

  it('switches the grouping or opens a group from the top of the list, keeping the filters', () => {
    const query = parse({ deal: 'rent', show: '300' });
    expect(buildRealEstateHref(query, { view: 'all' })).toBe('/real-estate?deal=rent&view=all');
    expect(buildRealEstateHref(parse({ view: 'all' }), { view: '' })).toBe('/real-estate');
    const key = '6a546aed-492a-4cf2-9627-072e6fc768bf';
    expect(buildRealEstateHref(query, { group: key })).toBe(`/real-estate?deal=rent&group=${key}`);
  });
});
