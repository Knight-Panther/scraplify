import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BALCONIES_TOP, BATHROOMS_TOP, ROOMS_TOP } from '../../src/realestate/filters.js';
import { formHref, METRO_LINES, METRO_STATIONS } from './real-estate-form.js';
import { countLabel } from './real-estate-panels.js';
import {
  buildRealEstateHref,
  countCacheKey,
  isFiltered,
  keepPlaces,
  parseRealEstateQuery,
  REAL_ESTATE_CHUNK,
  REAL_ESTATE_MAX_SHOWN,
} from './real-estate-params.js';
import { chipFilters, FILTER, FILTERS, PROMOTED } from './real-estate-registry.js';

const NOW = Date.parse('2026-10-12T22:00:00.000Z');
const parse = (raw: Record<string, string | string[]>) => parseRealEstateQuery(raw, NOW);
/** An address's query as the page receives it: a repeated key is a list. */
function rawOf(href: string): Record<string, string | string[]> {
  const raw: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(`http://x${href}`).searchParams) {
    const had = raw[key];
    raw[key] = had === undefined ? value : [...(Array.isArray(had) ? had : [had]), value];
  }
  return raw;
}
/** The address a parsed address writes back. */
const back = (raw: Record<string, string | string[]>) => buildRealEstateHref(parse(raw));

describe('parseRealEstateQuery (Phase 16B)', () => {
  it('asks for listings to buy, newest first, in dollars, one row per home, when the address says nothing', () => {
    const query = parse({});
    expect(query.filters).toEqual({
      dealType: 'sale',
      currency: 'usd',
      sort: 'newest',
      grouped: true,
    });
    expect(query.show).toBe(REAL_ESTATE_CHUNK);
    expect(buildRealEstateHref(query)).toBe('/real-estate');
    expect(isFiltered(query)).toBe(false);
  });

  it('reads "all" as every deal and writes it back', () => {
    const query = parse({ deal: 'all' });
    expect(query.filters.dealType).toBeUndefined();
    expect(buildRealEstateHref(query)).toBe('/real-estate?deal=all');
    expect(parse({ deal: 'rent' }).filters.dealType).toBe('rent');
    expect(parse({ deal: 'nonsense' }).filters.dealType).toBe('sale');
  });

  it('reads every filter of a flat from the address and writes the same address back', () => {
    const raw = {
      deal: 'rent',
      kind: 'flat',
      pl: ['subdistrict:3', 'street:812'],
      mm: '10',
      ms: ['rustaveli', 'delisi'],
      unc: '1',
      cur: 'gel',
      pm2: '1',
      pmin: '10',
      pmax: '25',
      amin: '40',
      amax: '90',
      rooms: ['2', '10+'],
      floor: 'middle',
      fmin: '2',
      fmax: '9',
      kmin: '8',
      kmax: '20',
      st: ['new'],
      cond: ['renovated'],
      proj: ['czech'],
      ftype: ['duplex'],
      bal: ['1', '5+'],
      bath: ['0'],
      ptype: ['owner', 'photos'],
      am: ['central-heating', 'bright'],
      by: 'business',
      since: '7',
      q: ' ავეჯით ',
      sort: 'metro',
      view: 'all',
    };
    const query = parse(raw);
    expect(query.filters).toEqual({
      dealType: 'rent',
      propertyType: 'flat',
      places: [
        { level: 'subdistrict', ref: 3 },
        { level: 'street', ref: 812 },
      ],
      metro: { maxMinutes: 10, stations: ['rustaveli', 'delisi'] },
      excludeUncertain: true,
      currency: 'gel',
      pricePerM2: true,
      priceMin: 10,
      priceMax: 25,
      areaMin: 40,
      areaMax: 90,
      roomsIn: [2, 10],
      floor: 'middle',
      floorMin: 2,
      floorMax: 9,
      kitchenAreaMin: 8,
      kitchenAreaMax: 20,
      buildingStatuses: ['new'],
      conditions: ['renovated'],
      projects: ['czech'],
      floorTypes: ['duplex'],
      balconies: [1, 5],
      bathrooms: [0],
      withPhotos: true,
      ownerOnly: true,
      amenities: ['central-heating', 'bright'],
      poster: 'business',
      updatedSince: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString(),
      text: 'ავეჯით',
      sort: 'metro',
      grouped: false,
    });
    // Parsing what it writes gives the same filters: one choice, one address.
    const again = parseRealEstateQuery(rawOf(buildRealEstateHref(query)), NOW);
    expect(again.filters).toEqual(query.filters);
  });

  it('drops what it does not recognise, so the form and the results always agree', () => {
    const query = parse({
      deal: 'swap',
      kind: 'castle',
      pl: ['planet:1', 'city:abc', 'city:0', 'street:99999999999'],
      mm: '7',
      ms: ['atlantis'],
      unc: 'yes',
      cur: 'eur',
      pmin: '-5',
      pmax: '12abc',
      rooms: ['0', '11'],
      floor: 'roof',
      by: 'cat',
      since: '2',
      sort: 'random',
      view: 'some',
      group: 'not-a-key',
    });
    expect(query.filters).toEqual({
      dealType: 'sale',
      currency: 'usd',
      sort: 'newest',
      grouped: true,
    });
    expect(isFiltered(query)).toBe(false);
  });

  it('keeps a list in its own order, each once, so one choice has one address', () => {
    expect(back({ kind: 'flat', rooms: ['3', '1', '3'] })).toBe(
      '/real-estate?kind=flat&rooms=1&rooms=3',
    );
    expect(back({ kind: 'commercial', ct: ['7', '31', '999'] })).toBe(
      '/real-estate?kind=commercial&ct=7&ct=31',
    );
    expect(back({ ms: ['delisi', 'akhmeteli'] })).toBe('/real-estate?ms=akhmeteli&ms=delisi');
  });

  it('reads the old single "5+" rooms value as five rooms or more', () => {
    expect(parse({ rooms: '5+' }).filters.roomsIn).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it('caps the search text by character, never mid-letter', () => {
    const query = parse({ q: 'ა'.repeat(500) });
    expect([...(query.filters.text ?? '')]).toHaveLength(120);
  });

  it('rounds the depth up to whole chunks and stops at the most a page will show', () => {
    expect(parse({ show: '150' }).show).toBe(200);
    expect(parse({ show: '99999' }).show).toBe(REAL_ESTATE_MAX_SHOWN);
    expect(parse({ show: 'x' }).show).toBe(REAL_ESTATE_CHUNK);
  });

  it('folds look-alikes unless asked for every listing, and lists one group by its key', () => {
    expect(parse({}).filters.grouped).toBe(true);
    expect(parse({ view: 'all' }).filters.grouped).toBe(false);
    const key = '0b5c7f2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
    const group = parse({ group: key.toUpperCase() });
    expect(group.filters.groupKey).toBe(key);
    expect(group.filters.grouped).toBeUndefined();
  });
});

describe('what each kind offers (the mockup registry)', () => {
  it('drops sub-types and panel filters a kind does not have', () => {
    const land = parse({
      kind: 'land',
      ct: '31',
      lt: '2',
      rooms: '2',
      floor: 'not-first',
      st: 'new',
      cond: 'renovated',
      ymin: '100',
      bath: '1',
      am: ['water', 'elevator'],
    });
    expect(land.filters).toEqual({
      dealType: 'sale',
      propertyType: 'land',
      landTypes: [2],
      amenities: ['water'],
      currency: 'usd',
      sort: 'newest',
      grouped: true,
    });
  });

  it('keeps rooms, floor, status and condition with no kind; amenities need a kind', () => {
    const any = parse({
      rooms: '2',
      floor: 'not-last',
      fmin: '3',
      st: 'old',
      cond: 'renovated',
      am: 'elevator',
    });
    expect(any.filters).toMatchObject({
      roomsIn: [2],
      floor: 'not-last',
      floorMin: 3,
      buildingStatuses: ['old'],
      conditions: ['renovated'],
    });
    expect(any.filters.amenities).toBeUndefined();
  });

  it('offers the floor for flats and commercial spaces only, of the kinds', () => {
    expect(parse({ kind: 'commercial', floor: 'middle' }).filters.floor).toBe('middle');
    expect(parse({ kind: 'house', floor: 'middle' }).filters.floor).toBeUndefined();
    expect(parse({ kind: 'hotel', fmin: '2' }).filters.floorMin).toBeUndefined();
  });

  it('reads a house-area link as the area, which is a house’s area on ss.ge', () => {
    expect(parse({ kind: 'house', hmin: '100', hmax: '250' }).filters).toMatchObject({
      areaMin: 100,
      areaMax: 250,
    });
    expect(parse({ kind: 'house', hmin: '100', amin: '80' }).filters.areaMin).toBe(80);
    expect(parse({ kind: 'flat', hmin: '100' }).filters.areaMin).toBeUndefined();
    expect(FILTER.area.title(parse({ kind: 'cottage' }).form)).toBe('House area');
  });

  it('keeps "other information" with the amenities, for flats only', () => {
    expect(parse({ kind: 'flat', am: ['bright', 'cozy'] }).filters.amenities).toEqual([
      'bright',
      'cozy',
    ]);
    expect(parse({ kind: 'house', am: ['bright'] }).filters.amenities).toBeUndefined();
  });

  it('promotes only filters the kind offers', () => {
    for (const [kind, keys] of Object.entries(PROMOTED)) {
      const form = parse(kind === '' ? {} : { kind }).form;
      for (const key of keys) expect(FILTER[key].applies(form), `${kind}: ${key}`).toBe(true);
    }
  });
});

describe('every filter the tab had before 16B is still reachable (exit gate)', () => {
  /*
   * The live tab's address on 2026-11-14, filter by filter, with a value it
   * accepted and the query filter it set. Each must still set the same
   * filter, and each must have its place in the registry that draws the bar,
   * the sheet and the chips.
   */
  const BEFORE: readonly {
    name: string;
    raw: Record<string, string | string[]>;
    expect: Record<string, unknown>;
    registry: string;
  }[] = [
    { name: 'search', raw: { q: 'ვაკე' }, expect: { text: 'ვაკე' }, registry: 'where' },
    { name: 'deal', raw: { deal: 'rent' }, expect: { dealType: 'rent' }, registry: 'deal' },
    { name: 'kind', raw: { kind: 'hotel' }, expect: { propertyType: 'hotel' }, registry: 'kind' },
    {
      name: 'space type',
      raw: { kind: 'commercial', ct: '7' },
      expect: { commercialTypes: [7] },
      registry: 'ctype',
    },
    {
      name: 'land type',
      raw: { kind: 'land', lt: '1' },
      expect: { landTypes: [1] },
      registry: 'ltype',
    },
    {
      name: 'building status',
      raw: { kind: 'flat', st: 'old' },
      expect: { buildingStatuses: ['old'] },
      registry: 'status',
    },
    {
      name: 'city',
      raw: { city: '95' },
      expect: { places: [{ level: 'city', ref: 95 }] },
      registry: 'where',
    },
    {
      name: 'area: a district',
      raw: { city: '95', area: 'd3' },
      expect: { places: [{ level: 'district', ref: 3 }] },
      registry: 'where',
    },
    {
      name: 'area: a sub-district',
      raw: { city: '95', area: 's12' },
      expect: { places: [{ level: 'subdistrict', ref: 12 }] },
      registry: 'where',
    },
    { name: 'rooms', raw: { rooms: '3' }, expect: { roomsIn: [3] }, registry: 'rooms' },
    {
      name: 'price',
      raw: { pmin: '5', pmax: '9', cur: 'gel', pm2: '1' },
      expect: { priceMin: 5, priceMax: 9, currency: 'gel', pricePerM2: true },
      registry: 'price',
    },
    {
      name: 'area',
      raw: { amin: '30', amax: '60' },
      expect: { areaMin: 30, areaMax: 60 },
      registry: 'area',
    },
    {
      name: 'floor',
      raw: { kind: 'flat', floor: 'not-first' },
      expect: { floor: 'not-first' },
      registry: 'floor',
    },
    { name: 'posted by', raw: { by: 'other' }, expect: { poster: 'other' }, registry: 'by' },
    {
      name: 'updated',
      raw: { since: '3' },
      expect: { updatedSince: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString() },
      registry: 'since',
    },
    {
      name: 'order',
      raw: { sort: 'area-desc' },
      expect: { sort: 'area-desc' },
      registry: 'display',
    },
    {
      name: 'house area',
      raw: { kind: 'house', hmin: '120' },
      expect: { areaMin: 120 },
      registry: 'area',
    },
    {
      name: 'yard area',
      raw: { kind: 'house', ymin: '300' },
      expect: { yardAreaMin: 300 },
      registry: 'yard',
    },
    {
      name: 'condition',
      raw: { kind: 'house', cond: 'white-frame' },
      expect: { conditions: ['white-frame'] },
      registry: 'cond',
    },
    {
      name: 'kitchen area',
      raw: { kind: 'flat', kmax: '12' },
      expect: { kitchenAreaMax: 12 },
      registry: 'kitchen',
    },
    {
      name: 'floor range',
      raw: { kind: 'flat', fmin: '2', fmax: '5' },
      expect: { floorMin: 2, floorMax: 5 },
      registry: 'floor',
    },
    {
      name: 'floor type',
      raw: { kind: 'flat', ftype: 'attic' },
      expect: { floorTypes: ['attic'] },
      registry: 'ftype',
    },
    {
      name: 'balconies',
      raw: { kind: 'flat', bal: '2' },
      expect: { balconies: [2] },
      registry: 'bal',
    },
    {
      name: 'bathrooms',
      raw: { kind: 'flat', bath: '5+' },
      expect: { bathrooms: [5] },
      registry: 'bath',
    },
    {
      name: 'project',
      raw: { kind: 'flat', proj: 'lviv' },
      expect: { projects: ['lviv'] },
      registry: 'proj',
    },
    {
      name: 'other information',
      raw: { kind: 'flat', am: 'street-view' },
      expect: { amenities: ['street-view'] },
      registry: 'other',
    },
    {
      name: 'listing type',
      raw: { kind: 'hotel', ptype: ['developer', 'exclusive'] },
      expect: { developerOnly: true, exclusiveOnly: true },
      registry: 'ptype',
    },
    {
      name: 'amenities',
      raw: { kind: 'land', am: 'sewage' },
      expect: { amenities: ['sewage'] },
      registry: 'am',
    },
    {
      name: 'every listing',
      raw: { view: 'all' },
      expect: { grouped: false },
      registry: 'display',
    },
  ];

  for (const filter of BEFORE) {
    it(`keeps "${filter.name}"`, () => {
      const query = parse(filter.raw);
      expect(query.filters).toMatchObject(filter.expect);
      if (filter.registry !== 'display') {
        const def = FILTERS.find((f) => f.key === filter.registry);
        expect(def, filter.registry).toBeDefined();
        expect(def?.applies(query.form)).toBe(true);
        expect(def?.active(query.form)).toBe(true);
      }
    });
  }
});

describe('the registry', () => {
  it('clears each filter it shows as a chip, and nothing else', () => {
    const query = parse({
      kind: 'flat',
      rooms: '2',
      pmin: '50000',
      mm: '10',
      unc: '1',
      ptype: 'photos',
      am: ['elevator', 'bright'],
      pl: 'city:95',
    });
    const chips = chipFilters(query.form).map((filter) => filter.key);
    expect(chips).toEqual(['metro', 'uncertain', 'price', 'rooms', 'am', 'other', 'ptype']);
    for (const filter of chipFilters(query.form)) {
      const cleared = filter.clear(query.form);
      expect(filter.active(cleared), filter.key).toBe(false);
      const left = chipFilters(cleared).map((f) => f.key);
      expect(left).toEqual(chips.filter((key) => key !== filter.key));
      // The places stay: they are the Where box's.
      expect(cleared.pl).toEqual(['city:95']);
    }
  });

  it('says what each set filter is, in words', () => {
    const { form } = parse({
      kind: 'flat',
      rooms: ['2', '3'],
      pmin: '50000',
      pmax: '120000',
      ms: 'rustaveli',
      mm: '10',
    });
    expect(FILTER.rooms.summary(form, { placeNames: new Map() })).toBe('2, 3');
    expect(FILTER.price.summary(form, { placeNames: new Map() })).toBe('$50k–$120k');
    expect(FILTER.metro.summary(form, { placeNames: new Map() })).toBe('≤ 10 min of Rustaveli');
  });
});

describe('the shared form', () => {
  it('keeps the old places of an address as the narrowest one named', () => {
    expect(parse({ city: '95', area: 's3' }).form.pl).toEqual(['subdistrict:3']);
    expect(parse({ city: '95', area: 'd3' }).form.pl).toEqual(['district:3']);
    expect(parse({ city: '95', area: 'x3' }).form.pl).toEqual(['city:95']);
    expect(formHref(parse({ city: '95' }).form)).toBe('/real-estate?pl=city%3A95');
  });

  it('drops the places the catalogue does not know, once the page has asked it', () => {
    const query = parse({ pl: ['city:95', 'street:4'] });
    const kept = keepPlaces(query, new Set(['city:95']), NOW);
    expect(kept.filters.places).toEqual([{ level: 'city', ref: 95 }]);
    expect(keepPlaces(query, new Set(['city:95', 'street:4']), NOW)).toBe(query);
  });

  it('draws the metro lines from the same stations as the place file', () => {
    const file = JSON.parse(
      readFileSync(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '../../src/realestate/places/tbilisi.json',
        ),
        'utf8',
      ),
    ) as { stations: { code: string; nameKa: string; nameEn: string; lines: number[] }[] };
    expect(METRO_STATIONS).toEqual(
      file.stations.map((s) => ({ code: s.code, ka: s.nameKa, en: s.nameEn })),
    );
    for (const line of METRO_LINES) {
      expect(line.codes).toEqual(
        file.stations.filter((s) => s.lines.includes(line.line)).map((s) => s.code),
      );
    }
  });

  it('has the same top count chips as the query layer', () => {
    expect(countLabel('rooms', ROOMS_TOP)).toBe(`${ROOMS_TOP}+`);
    expect(countLabel('bathrooms', BATHROOMS_TOP)).toBe(`${BATHROOMS_TOP}+`);
    expect(countLabel('balconies', BALCONIES_TOP)).toBe(`${BALCONIES_TOP}+`);
    expect(countLabel('rooms', ROOMS_TOP - 1)).toBe(String(ROOMS_TOP - 1));
  });
});

describe('buildRealEstateHref', () => {
  it('changes the depth, the grouping or the group and keeps the rest', () => {
    const query = parse({ kind: 'flat', rooms: '2', show: '300' });
    expect(buildRealEstateHref(query)).toBe('/real-estate?kind=flat&rooms=2&show=300');
    expect(buildRealEstateHref(query, { show: 400 })).toBe(
      '/real-estate?kind=flat&rooms=2&show=400',
    );
    // A change of grouping or group starts the list from its top.
    expect(buildRealEstateHref(query, { view: 'all' })).toBe(
      '/real-estate?kind=flat&rooms=2&view=all',
    );
    const key = '0b5c7f2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
    expect(buildRealEstateHref(query, { group: key })).toBe(
      `/real-estate?kind=flat&rooms=2&group=${key}`,
    );
  });
});

describe('countCacheKey', () => {
  const TEN_MINUTES = 10 * 60_000;

  it('is one key for the same filters, whatever their order, sort or page', () => {
    const a = parse({ deal: 'sale', kind: 'flat', sort: 'price-asc' });
    const b = parse({ kind: 'flat', show: '300' });
    expect(countCacheKey(a.filters, TEN_MINUTES)).toBe(countCacheKey(b.filters, TEN_MINUTES));
    const c = parse({ deal: 'rent', kind: 'flat' });
    expect(countCacheKey(c.filters, TEN_MINUTES)).not.toBe(countCacheKey(a.filters, TEN_MINUTES));
  });

  it('gives "updated within" asked moments apart one key, and a later window another', () => {
    const at = (ms: number) =>
      countCacheKey(parseRealEstateQuery({ since: '7' }, ms).filters, TEN_MINUTES);
    const start = Math.ceil(NOW / TEN_MINUTES) * TEN_MINUTES;
    expect(at(start + 5)).toBe(at(start + 1_234));
    expect(at(start + TEN_MINUTES)).not.toBe(at(start));
    expect(
      countCacheKey(parseRealEstateQuery({ since: '1' }, start).filters, TEN_MINUTES),
    ).not.toBe(at(start));
  });
});
