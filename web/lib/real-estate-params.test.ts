import { describe, expect, it } from 'vitest';
import type { RealEstateLocations } from '../../src/realestate/queries.js';
import {
  buildRealEstateHref,
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
  it('asks for everything, newest first, in dollars, when the address says nothing', () => {
    const query = parse({});

    expect(query.filters).toEqual({ currency: 'usd', sort: 'newest' });
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
    });

    expect(query.filters).toEqual({ currency: 'usd', sort: 'newest' });
    expect(query.form).toMatchObject({
      deal: '',
      kind: '',
      city: '',
      area: '',
      pmin: '',
      rooms: '',
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
});
