import { describe, expect, it } from 'vitest';
import type { RealEstateLocations } from '../../src/realestate/queries.js';
import {
  buildRealEstateHref,
  countCacheKey,
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

  describe('more filters (Phase 12C)', () => {
    it('drops an amenity the chosen kind does not offer', () => {
      // Land offers gas, electricity, sewage, water and video calls; never an elevator.
      const land = parse({ kind: 'land', am: ['elevator', 'water', 'natural-gas', 'pool'] });
      expect(land.form.am).toEqual(['natural-gas', 'water']);
      expect(land.filters.amenities).toEqual(['natural-gas', 'water']);

      // A flat for sale offers "top floor" but not pets; for rent, the other way round.
      const sale = parse({ kind: 'flat', deal: 'sale', am: ['pets-allowed', 'top-floor'] });
      expect(sale.form.am).toEqual(['top-floor']);
      const rent = parse({ kind: 'flat', deal: 'rent', am: ['pets-allowed', 'top-floor'] });
      expect(rent.form.am).toEqual(['pets-allowed']);
      // No deal: whatever any deal offers.
      expect(parse({ kind: 'flat', am: ['pets-allowed', 'top-floor'] }).form.am).toEqual([
        'pets-allowed',
        'top-floor',
      ]);

      // No kind, no panel.
      const none = parse({ am: 'balcony' });
      expect(none.form.am).toEqual([]);
      expect(none.filters).not.toHaveProperty('amenities');
      expect(isFiltered(none)).toBe(false);
    });

    it('keeps "other information" with the amenities, for flats only', () => {
      const flat = parse({ kind: 'flat', am: ['bright', 'balcony', 'yard-view'] });
      expect(flat.form.am).toEqual(['balcony', 'yard-view', 'bright']);
      expect(flat.filters.amenities).toEqual(['balcony', 'yard-view', 'bright']);
      expect(parse({ kind: 'house', am: ['bright', 'balcony'] }).form.am).toEqual(['balcony']);
    });

    it('keeps several conditions and projects and writes them back', () => {
      const query = parse({
        kind: 'flat',
        cond: ['renovated', 'needs-renovation', 'shiny', 'renovated'],
        proj: ['khrushchev', 'czech'],
      });

      // In the vocabulary's own order, so one choice has one address.
      expect(query.form.cond).toEqual(['needs-renovation', 'renovated']);
      expect(query.form.proj).toEqual(['czech', 'khrushchev']);
      expect(query.filters.conditions).toEqual(['needs-renovation', 'renovated']);
      expect(query.filters.projects).toEqual(['czech', 'khrushchev']);
      expect(isFiltered(query)).toBe(true);
      expect(buildRealEstateHref(query)).toBe(
        '/real-estate?kind=flat&cond=needs-renovation&cond=renovated&proj=czech&proj=khrushchev',
      );
    });

    it('reads building status, floor type, bathrooms and balconies', () => {
      const query = parse({
        kind: 'flat',
        st: ['old', 'new', 'ancient'],
        ftype: ['attic', 'duplex'],
        bath: ['0', '5+', '2', '5'],
        bal: ['6', '1'],
      });

      expect(query.filters).toMatchObject({
        buildingStatuses: ['new', 'old'],
        floorTypes: ['duplex', 'attic'],
        // The top chip is that many or more and is written "5+"; 0 is none.
        bathrooms: [2, 5, 0],
        balconies: [1],
      });
      expect(query.form).toMatchObject({
        st: ['new', 'old'],
        ftype: ['duplex', 'attic'],
        bath: ['2', '5+', '0'],
        bal: ['1'],
      });
    });

    it('reads several room counts, the top one meaning that many or more', () => {
      const query = parse({ rooms: ['3', '10+', '1', '11', '10'] });

      expect(query.form.rooms).toEqual(['1', '3', '10+']);
      expect(query.filters.roomsIn).toEqual([1, 3, 10]);
    });

    it('reads the old single rooms value', () => {
      // Links made before Phase 12C said "5+" for five or more.
      const query = parse({ kind: 'flat', rooms: '5+' });

      expect(query.form.rooms).toEqual(['5', '6', '7', '8', '9', '10+']);
      expect(query.filters.roomsIn).toEqual([5, 6, 7, 8, 9, 10]);
      expect(buildRealEstateHref(query)).toBe(
        '/real-estate?kind=flat&rooms=5&rooms=6&rooms=7&rooms=8&rooms=9&rooms=10%2B',
      );
    });

    it('applies price bounds per m² when asked', () => {
      const query = parse({ pmin: '800', pmax: '1500', pm2: '1' });
      expect(query.filters).toMatchObject({ priceMin: 800, priceMax: 1500, pricePerM2: true });
      expect(query.form.pm2).toBe('1');
      expect(buildRealEstateHref(query)).toBe('/real-estate?pm2=1&pmin=800&pmax=1500');

      expect(parse({ pmin: '800' }).filters).not.toHaveProperty('pricePerM2');
      expect(parse({ pm2: 'yes' }).form.pm2).toBe('');
      // How prices are counted is not a narrowing of the list.
      expect(isFiltered(parse({ pm2: '1' }))).toBe(false);
    });

    it('reads the floor, kitchen, house and yard ranges', () => {
      expect(
        parse({ kind: 'flat', fmin: '2', fmax: '9', kmin: '8', kmax: '20' }).filters,
      ).toMatchObject({ floorMin: 2, floorMax: 9, kitchenAreaMin: 8, kitchenAreaMax: 20 });
      expect(
        parse({ kind: 'house', hmin: '120', hmax: '300', ymin: '200', ymax: 'big' }),
      ).toMatchObject({
        filters: { houseAreaMin: 120, houseAreaMax: 300, yardAreaMin: 200 },
        form: { hmin: '120', hmax: '300', ymin: '200', ymax: '' },
      });
    });

    it('reads each listing type into its own filter', () => {
      const query = parse({ kind: 'hotel', ptype: ['exclusive', 'owner', 'agent', 'photos'] });

      expect(query.form.ptype).toEqual(['photos', 'owner', 'exclusive']);
      expect(query.filters).toMatchObject({
        withPhotos: true,
        ownerOnly: true,
        exclusiveOnly: true,
      });
      expect(query.filters).not.toHaveProperty('developerOnly');
      expect(parse({ kind: 'land', ptype: 'developer' }).filters.developerOnly).toBe(true);
    });

    it('drops every choice the chosen kind’s panel does not offer', () => {
      const everything = {
        st: 'new',
        cond: 'renovated',
        proj: 'czech',
        ftype: 'duplex',
        bath: '1',
        bal: '1',
        rooms: '2',
        fmin: '2',
        kmin: '8',
        hmin: '100',
        ymin: '100',
        ptype: 'photos',
      };
      const form = (kind?: string) =>
        parse({ ...everything, ...(kind === undefined ? {} : { kind }) }).form;
      const kept = (kind?: string) =>
        Object.entries(form(kind))
          .filter(([key, value]) => key in everything && value.length > 0)
          .map(([key]) => key)
          .sort();

      expect(kept('flat')).toEqual(
        ['st', 'cond', 'proj', 'ftype', 'bath', 'bal', 'rooms', 'fmin', 'kmin', 'ptype'].sort(),
      );
      expect(kept('house')).toEqual(['st', 'cond', 'rooms', 'hmin', 'ymin', 'ptype'].sort());
      expect(kept('cottage')).toEqual(kept('house'));
      expect(kept('commercial')).toEqual(['st', 'cond', 'ptype'].sort());
      expect(kept('land')).toEqual(['ptype']);
      expect(kept('hotel')).toEqual(['st', 'cond', 'rooms', 'ptype'].sort());
      // With no kind there is no panel; rooms stay, as the main bar has them.
      expect(kept()).toEqual(['rooms']);
      expect(parse(everything).filters).toEqual({
        currency: 'usd',
        sort: 'newest',
        grouped: true,
        roomsIn: [2],
      });
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
      roomsIn: [2],
      floor: 'middle',
      poster: 'business',
      updatedSince: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString(),
      text: 'ავეჯით',
      sort: 'price-asc',
      grouped: true,
    });
  });

  it('reads a whole district', () => {
    const query = parse({ city: '95', area: 'd3' });

    expect(query.filters).toMatchObject({ cityRef: 95, districtRef: 3 });
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
      rooms: [],
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
    const raw: [string, string][] = [
      ['deal', 'rent'],
      ['kind', 'flat'],
      ['st', 'new'],
      ['st', 'under-construction'],
      ['city', '95'],
      ['area', 's3'],
      ['cur', 'gel'],
      ['pm2', '1'],
      ['pmin', '1000'],
      ['pmax', '2500'],
      ['amin', '40'],
      ['amax', '90'],
      ['rooms', '2'],
      ['rooms', '10+'],
      ['floor', 'not-first'],
      ['by', 'other'],
      ['since', '3'],
      ['cond', 'newly-renovated'],
      ['kmin', '8'],
      ['kmax', '20'],
      ['fmin', '2'],
      ['fmax', '12'],
      ['ftype', 'duplex'],
      ['bal', '1'],
      ['bal', '0'],
      ['bath', '5+'],
      ['proj', 'non-standard'],
      ['ptype', 'owner'],
      ['am', 'balcony'],
      ['am', 'pets-allowed'],
      ['am', 'cozy'],
      ['q', 'ავეჯით'],
      ['sort', 'area-desc'],
      ['view', 'all'],
      ['show', '300'],
    ];
    const asRaw: Record<string, string[]> = {};
    for (const [key, value] of raw) asRaw[key] = [...(asRaw[key] ?? []), value];
    const href = buildRealEstateHref(parse(asRaw));
    const params = [...new URL(href, 'https://x.invalid').searchParams];

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

describe('countCacheKey', () => {
  const TEN_MINUTES = 10 * 60_000;

  it('is one key for the same filters, whatever their order, sort or page', () => {
    const a = parseRealEstateQuery({ deal: 'sale', kind: 'flat', sort: 'price-asc' }, PLACES, NOW);
    const b = parseRealEstateQuery({ kind: 'flat', deal: 'sale', show: '300' }, PLACES, NOW);
    expect(countCacheKey(a.filters, TEN_MINUTES)).toBe(countCacheKey(b.filters, TEN_MINUTES));
    const c = parseRealEstateQuery({ deal: 'rent', kind: 'flat' }, PLACES, NOW);
    expect(countCacheKey(c.filters, TEN_MINUTES)).not.toBe(countCacheKey(a.filters, TEN_MINUTES));
  });

  it('gives "updated within" asked moments apart one key, and a later window another', () => {
    const at = (ms: number) =>
      countCacheKey(parseRealEstateQuery({ since: '7' }, PLACES, ms).filters, TEN_MINUTES);
    const start = Math.ceil(NOW / TEN_MINUTES) * TEN_MINUTES;
    expect(at(start + 5)).toBe(at(start + 1_234));
    expect(at(start + TEN_MINUTES)).not.toBe(at(start));
    // A different choice is a different key.
    expect(
      countCacheKey(parseRealEstateQuery({ since: '1' }, PLACES, start).filters, TEN_MINUTES),
    ).not.toBe(at(start));
  });
});
