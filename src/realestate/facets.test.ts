import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  type NewRealEstateListingRow,
  realEstateListings,
  realEstatePlaces,
} from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import { type FacetKey, type FacetResult, facetCounts } from './facets.js';
import type { RealEstateFilters } from './filters.js';
import { searchRealEstate } from './queries.js';

const NOW = Date.parse('2026-10-12T22:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (daysFromNow: number) => new Date(NOW + daysFromNow * DAY_MS).toISOString();
const NOW_ISO = at(0);

describe('facet counts (Phase 16B)', () => {
  const sourceIds: string[] = [];
  let nextKey = 1;

  async function newSource(): Promise<string> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    return sourceId;
  }

  /** A two-room flat for sale in Tbilisi, seen today, unless told otherwise. */
  async function listing(
    sourceId: string,
    overrides: Partial<NewRealEstateListingRow> = {},
  ): Promise<string> {
    const key = String(nextKey++);
    const [row] = await db
      .insert(realEstateListings)
      .values({
        sourceId,
        sourceListingKey: key,
        canonicalUrl: `https://example.invalid/facets/${key}`,
        dealType: 'sale',
        propertyType: 'flat',
        rooms: 2,
        areaM2: '60.00',
        priceUsd: '100000.00',
        priceGel: '270000.00',
        pricePerM2Usd: '1666.00',
        cityRef: 95,
        cityName: 'თბილისი',
        sourceUpdatedAt: at(-1),
        expectedEndAt: at(29),
        firstSeenAt: at(-1),
        lastSeenAt: at(-0.1),
        contentHash: 'h',
        ...overrides,
      })
      .returning({ id: realEstateListings.id });
    if (row === undefined) throw new Error('listing was not inserted');
    return row.id;
  }

  /** A listing whose own page was read, so listing-page fields can be judged. */
  const read = (sourceId: string, overrides: Partial<NewRealEstateListingRow> = {}) =>
    listing(sourceId, { detailsReadAt: at(-0.5), ...overrides });

  async function facet(
    sourceId: string,
    which: FacetKey,
    filters: Partial<RealEstateFilters> = {},
  ): Promise<FacetResult> {
    return facetCounts(db, { sourceId, ...filters }, NOW_ISO, which);
  }

  async function counts(
    sourceId: string,
    which: FacetKey,
    filters: Partial<RealEstateFilters> = {},
  ): Promise<Record<string, number>> {
    const result = await facet(sourceId, which, filters);
    if (result.type !== 'counts') throw new Error(`${which} is a ${result.type}`);
    return result.counts;
  }

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  describe('a facet leaves its own filter out and keeps every other', () => {
    it('counts kinds under the deal but not under the kind, nor its sub-types', async () => {
      const sourceId = await newSource();
      await listing(sourceId);
      await listing(sourceId);
      await listing(sourceId, { propertyType: 'house' });
      await listing(sourceId, { propertyType: 'commercial', commercialType: 7 });
      await listing(sourceId, { propertyType: 'house', dealType: 'rent' });

      const sale = { dealType: 'sale' } as const;
      expect(await counts(sourceId, 'kind', sale)).toEqual({ flat: 2, house: 1, commercial: 1 });
      // Picking a flat does not hide the other kinds' numbers.
      expect(await counts(sourceId, 'kind', { ...sale, propertyType: 'flat' })).toEqual({
        flat: 2,
        house: 1,
        commercial: 1,
      });
      expect(
        await counts(sourceId, 'kind', {
          ...sale,
          propertyType: 'commercial',
          commercialTypes: [7],
        }),
      ).toEqual({ flat: 2, house: 1, commercial: 1 });
    });

    it('counts commercial and land types by their ss.ge codes, under the kind', async () => {
      const sourceId = await newSource();
      await listing(sourceId, { propertyType: 'commercial', commercialType: 7 });
      await listing(sourceId, { propertyType: 'commercial', commercialType: 7 });
      await listing(sourceId, { propertyType: 'commercial', commercialType: 31 });
      await listing(sourceId, { propertyType: 'land', landType: 2 });
      await listing(sourceId);

      const commercial = { propertyType: 'commercial' } as const;
      expect(await counts(sourceId, 'commercialType', commercial)).toEqual({ '7': 2, '31': 1 });
      expect(
        await counts(sourceId, 'commercialType', { ...commercial, commercialTypes: [31] }),
      ).toEqual({ '7': 2, '31': 1 });
      expect(await counts(sourceId, 'landType', { propertyType: 'land' })).toEqual({ '2': 1 });
    });

    it('counts rooms by their value, folding ten or more into 10+, and leaves out no-room listings', async () => {
      const sourceId = await newSource();
      for (const rooms of [1, 2, 2, 9, 10, 12]) await listing(sourceId, { rooms });
      await listing(sourceId, { rooms: 0 });
      await listing(sourceId, { rooms: null });
      await listing(sourceId, { rooms: 3, dealType: 'rent' });

      const sale = { dealType: 'sale' } as const;
      const all = { '1': 1, '2': 2, '9': 1, '10+': 2 };
      expect(await counts(sourceId, 'rooms', sale)).toEqual(all);
      // The rooms already chosen do not change the other rooms' numbers.
      expect(await counts(sourceId, 'rooms', { ...sale, roomsIn: [2] })).toEqual(all);
    });

    it('counts bathrooms and balconies with 5+ as five or more, and 0 as none', async () => {
      const sourceId = await newSource();
      for (const bathrooms of [0, 1, 1, 4, 5, 7]) await read(sourceId, { bathrooms });
      for (const balconies of [0, 5, 6]) await read(sourceId, { balconies });
      await listing(sourceId, { bathrooms: null });

      expect(await counts(sourceId, 'bathrooms')).toEqual({ '0': 1, '1': 2, '4': 1, '5+': 2 });
      expect(await counts(sourceId, 'balconies')).toEqual({ '0': 1, '5+': 2 });
    });

    it('counts listing-page fields over the listings whose page says, under every other filter', async () => {
      const sourceId = await newSource();
      await read(sourceId, { condition: 'renovated', buildingStatus: 'old' });
      await read(sourceId, {
        condition: 'renovated',
        buildingStatus: 'new',
        floorType: 'duplex',
      });
      await read(sourceId, { condition: 'needs-renovation', buildingStatus: 'new' });
      await listing(sourceId, { condition: null });
      await read(sourceId, { condition: 'renovated', dealType: 'rent' });

      const sale = { dealType: 'sale' } as const;
      expect(await counts(sourceId, 'condition', sale)).toEqual({
        renovated: 2,
        'needs-renovation': 1,
      });
      // Its own filter is left out; the other panel's still counts.
      expect(
        await counts(sourceId, 'condition', {
          ...sale,
          conditions: ['renovated'],
          buildingStatuses: ['new'],
        }),
      ).toEqual({ renovated: 1, 'needs-renovation': 1 });
      expect(await counts(sourceId, 'buildingStatus', sale)).toEqual({
        old: 1,
        'new': 2,
      });
      expect(await counts(sourceId, 'floorType', sale)).toEqual({ duplex: 1 });
    });
  });

  describe('the every-one-ticked lists', () => {
    it('counts an amenity among the listings that also have every amenity ticked', async () => {
      const sourceId = await newSource();
      await read(sourceId, { amenities: ['balcony', 'elevator'] });
      await read(sourceId, { amenities: ['balcony'] });
      await read(sourceId, { amenities: ['elevator', 'garage'] });

      const none = await counts(sourceId, 'amenities');
      expect(none.balcony).toBe(2);
      expect(none.elevator).toBe(2);
      expect(none.garage).toBe(1);
      expect(none.pool).toBe(0);

      const balcony = await counts(sourceId, 'amenities', { amenities: ['balcony'] });
      expect(balcony.balcony).toBe(2);
      expect(balcony.elevator).toBe(1);
      expect(balcony.garage).toBe(0);
    });

    it('counts a listing type among the listings that already have every type ticked', async () => {
      const sourceId = await newSource();
      await read(sourceId, { posterType: 'developer', imageCount: 3, exclusive: true });
      await read(sourceId, { posterType: 'developer', imageCount: 0 });
      await read(sourceId, { posterType: 'owner', posterEntity: 'individual', imageCount: 2 });
      await listing(sourceId, { posterType: 'agent', imageCount: 1 });

      expect(await counts(sourceId, 'listingType')).toEqual({
        developer: 2,
        photos: 3,
        owner: 1,
        exclusive: 1,
      });
      expect(await counts(sourceId, 'listingType', { developerOnly: true })).toEqual({
        developer: 2,
        photos: 1,
        owner: 0,
        exclusive: 1,
      });
    });
  });

  describe('units', () => {
    it('counts properties, not listings, when the tab folds look-alikes', async () => {
      const sourceId = await newSource();
      for (let copy = 0; copy < 3; copy++) await listing(sourceId, { groupKey: 'g1', rooms: 3 });
      await listing(sourceId, { rooms: 3 });
      await listing(sourceId, { rooms: 1 });

      expect(await counts(sourceId, 'rooms')).toEqual({ '1': 1, '3': 4 });
      expect(await counts(sourceId, 'rooms', { grouped: true })).toEqual({ '1': 1, '3': 2 });
      expect(await counts(sourceId, 'kind', { grouped: true })).toEqual({ flat: 3 });
    });
  });

  describe('metro stations', () => {
    it('counts the listings near each station within the band, whatever station is chosen', async () => {
      const sourceId = await newSource();
      // One station is also in the catalogue as a metro_station, so its code is offered.
      await db.insert(realEstatePlaces).values([
        {
          sourceId,
          level: 'metro_station',
          ref: 8801,
          code: 'facet-a',
          nameKa: 'ა',
          firstSeenAt: at(-1),
          lastSeenAt: at(0),
        },
        {
          sourceId,
          level: 'metro_station',
          ref: 8802,
          code: 'facet-b',
          nameKa: 'ბ',
          firstSeenAt: at(-1),
          lastSeenAt: at(0),
        },
      ]);
      await listing(sourceId, {
        metroNearby: ['facet-a', 'facet-b'],
        metroNearbyMinutes: [5, 15],
        metroMinutes: 5,
      });
      await listing(sourceId, {
        metroNearby: ['facet-b'],
        metroNearbyMinutes: [10],
        metroMinutes: 10,
      });
      await listing(sourceId, {
        metroNearby: ['facet-a'],
        metroNearbyMinutes: [20],
        metroMinutes: 20,
      });
      await listing(sourceId);

      const ours = async (filters: Partial<RealEstateFilters> = {}) => {
        const found = await counts(sourceId, 'metroStations', filters);
        return { a: found['facet-a'], b: found['facet-b'] };
      };
      expect(await ours()).toEqual({ a: 2, b: 2 });
      expect(await ours({ metro: { maxMinutes: 10 } })).toEqual({ a: 1, b: 1 });
      expect(await ours({ metro: { maxMinutes: 5 } })).toEqual({ a: 1, b: 0 });
      // A chosen station does not hide the other's number.
      expect(await ours({ metro: { maxMinutes: 10, stations: ['facet-a'] } })).toEqual({
        a: 1,
        b: 1,
      });
    });
  });

  describe('price', () => {
    it('is 36 log-spaced bins of 37 edges that add up to the listings, under the other filters but not the price bounds', async () => {
      const sourceId = await newSource();
      for (let at_ = 0; at_ < 60; at_++) {
        await listing(sourceId, {
          priceUsd: String(50_000 + at_ * 5_000),
          priceGel: String(140_000 + at_ * 13_000),
        });
      }
      await listing(sourceId, { priceUsd: '90000.00', dealType: 'rent' });

      const result = await facet(sourceId, 'price', { dealType: 'sale', priceMin: 200_000 });
      if (result.type !== 'histogram') throw new Error('not a histogram');
      expect(result.edges).toHaveLength(37);
      expect(result.counts).toHaveLength(36);
      expect(result.counts.reduce((sum, count) => sum + count, 0)).toBe(60);
      expect(result.edges).toEqual([...result.edges].sort((a, b) => a - b));
      // Log spacing: the ratio between neighbouring edges is the same.
      const ratio = (i: number) => (result.edges[i + 1] ?? 0) / (result.edges[i] ?? 1);
      expect(ratio(0)).toBeCloseTo(ratio(30), 1);
      // The range is the 2nd to 98th percentile of the prices.
      expect(result.edges[0]).toBeGreaterThan(50_000);
      expect(result.edges[36]).toBeLessThan(345_000);

      const gel = await facet(sourceId, 'price', { dealType: 'sale', currency: 'gel' });
      if (gel.type !== 'histogram') throw new Error('not a histogram');
      expect(gel.edges[0]).toBeGreaterThan(140_000);
    });

    it('is empty when fewer than five listings have a price', async () => {
      const sourceId = await newSource();
      for (let i = 0; i < 4; i++) await listing(sourceId);
      await listing(sourceId, { priceUsd: null });
      expect(await facet(sourceId, 'price')).toEqual({ type: 'histogram', edges: [], counts: [] });
    });

    it('still has bins when every price is the same', async () => {
      const sourceId = await newSource();
      for (let i = 0; i < 6; i++) await listing(sourceId);
      const result = await facet(sourceId, 'price');
      if (result.type !== 'histogram') throw new Error('not a histogram');
      expect(result.edges).toHaveLength(37);
      expect(result.counts.reduce((sum, count) => sum + count, 0)).toBe(6);
    });
  });

  describe('location', () => {
    it('counts the uncertain listings, whether or not they are already left out', async () => {
      const sourceId = await newSource();
      await listing(sourceId, { locationUncertain: true });
      await listing(sourceId, { locationUncertain: true, dealType: 'rent' });
      await listing(sourceId);

      expect(await facet(sourceId, 'uncertain', { dealType: 'sale' })).toEqual({
        type: 'uncertain',
        count: 1,
      });
      expect(
        await facet(sourceId, 'uncertain', { dealType: 'sale', excludeUncertain: true }),
      ).toEqual({ type: 'uncertain', count: 1 });
    });

    it('splits the listings into those the metro can be judged for, those it cannot, and those outside Tbilisi', async () => {
      const sourceId = await newSource();
      await db.insert(realEstatePlaces).values([
        {
          sourceId,
          level: 'city',
          ref: 95,
          nameKa: 'თბილისი',
          firstSeenAt: at(-1),
          lastSeenAt: at(0),
        },
        {
          sourceId,
          level: 'city',
          ref: 96,
          nameKa: 'ბათუმი',
          firstSeenAt: at(-1),
          lastSeenAt: at(0),
        },
      ]);
      await listing(sourceId, {
        metroBasis: 'pin',
        metroNearby: ['x'],
        metroNearbyMinutes: [5],
        metroMinutes: 5,
      });
      await listing(sourceId, { metroBasis: 'street' });
      await listing(sourceId, { metroBasis: null });
      await listing(sourceId, { metroBasis: null });
      await listing(sourceId, { cityRef: 96, cityName: 'ბათუმი', metroBasis: null });
      await listing(sourceId, { cityRef: null, cityName: null });

      expect(await facet(sourceId, 'metroCoverage')).toEqual({
        type: 'metroCoverage',
        total: 6,
        unknown: 2,
        outside: 2,
      });
      // The metro filter itself does not narrow it.
      expect(await facet(sourceId, 'metroCoverage', { metro: { maxMinutes: 5 } })).toMatchObject({
        total: 6,
      });
    });
  });

  describe('the metro sort', () => {
    it('puts the nearest first, then the newest, with the unlocated last', async () => {
      const sourceId = await newSource();
      const far = await listing(sourceId, { metroMinutes: 15, sourceUpdatedAt: at(-1) });
      const unknown = await listing(sourceId, { metroMinutes: null, sourceUpdatedAt: at(-0.1) });
      const nearOld = await listing(sourceId, { metroMinutes: 5, sourceUpdatedAt: at(-5) });
      const nearNew = await listing(sourceId, { metroMinutes: 5, sourceUpdatedAt: at(-2) });
      const rows = await searchRealEstate(db, { sourceId, sort: 'metro' }, NOW_ISO);
      expect(rows.map((row) => row.id)).toEqual([nearNew, nearOld, far, unknown]);
      expect(rows[0]).toMatchObject({ metroMinutes: 5, cityRef: 95, metroBasis: null });
    });
  });
});
