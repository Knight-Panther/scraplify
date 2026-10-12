import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import { type NewRealEstateListingRow, realEstateListings } from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import {
  countRealEstate,
  type RealEstateFilters,
  realEstateLocations,
  searchRealEstate,
} from './queries.js';
import { listingSearchQuery } from './search.js';

const NOW = Date.parse('2026-10-12T22:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (daysFromNow: number) => new Date(NOW + daysFromNow * DAY_MS).toISOString();
const NOW_ISO = at(0);

describe('real-estate queries', () => {
  const sourceIds: string[] = [];
  let nextKey = 1;

  async function newSource(): Promise<string> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    return sourceId;
  }

  /** A two-room flat for sale in Saburtalo, seen today, unless told otherwise. */
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
        canonicalUrl: `https://example.invalid/${key}`,
        dealType: 'sale',
        propertyType: 'flat',
        rooms: 2,
        areaM2: '60.00',
        floor: 3,
        totalFloors: 9,
        priceUsd: '100000.00',
        priceGel: '270000.00',
        pricePerM2Usd: '1666.00',
        cityRef: 95,
        cityName: 'თბილისი',
        districtRef: 3,
        districtName: 'ვაკე-საბურთალო',
        subdistrictRef: 3,
        subdistrictName: 'საბურთალო',
        streetName: 'უნივერსიტეტის ქ.',
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

  const find = async (sourceId: string, filters: Partial<RealEstateFilters> = {}) =>
    (await searchRealEstate(db, { sourceId, ...filters }, NOW_ISO)).map((row) => row.id);

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  describe('which listings are on show', () => {
    it('shows an active listing until two days past its expected end', async () => {
      const sourceId = await newSource();
      const live = await listing(sourceId);
      const inGrace = await listing(sourceId, { expectedEndAt: at(-1), lastSeenAt: at(-10) });
      await listing(sourceId, { expectedEndAt: at(-3), lastSeenAt: at(-10) });
      await listing(sourceId, { status: 'gone', goneAt: at(-1) });

      expect((await find(sourceId)).sort()).toEqual([live, inGrace].sort());
      expect(await countRealEstate(db, { sourceId }, NOW_ISO)).toBe(2);
    });

    it('shows a listing the source listed lately, whatever its order time says', async () => {
      const sourceId = await newSource();
      // Ordered two years ago, on the site this morning (guideline §9.3, rule 2).
      const longRunning = await listing(sourceId, {
        sourceUpdatedAt: at(-700),
        expectedEndAt: at(-670),
        lastSeenAt: at(-0.5),
      });

      expect(await find(sourceId)).toEqual([longRunning]);
    });

    it('never returns the description', async () => {
      const sourceId = await newSource();
      await listing(sourceId, { description: 'ახალი რემონტით, დარეკეთ' });

      const [row] = await searchRealEstate(db, { sourceId }, NOW_ISO);

      expect(row).toBeDefined();
      expect(Object.keys(row ?? {})).not.toContain('description');
      expect(JSON.stringify(row)).not.toContain('რემონტით');
    });
  });

  describe('filters', () => {
    it('narrows by deal, kind and place', async () => {
      const sourceId = await newSource();
      const flatSale = await listing(sourceId);
      const flatRent = await listing(sourceId, { dealType: 'rent' });
      const house = await listing(sourceId, { propertyType: 'house' });
      const vake = await listing(sourceId, { subdistrictRef: 2, subdistrictName: 'ვაკე' });
      const batumi = await listing(sourceId, {
        cityRef: 96,
        cityName: 'ბათუმი',
        districtRef: null,
        districtName: null,
        subdistrictRef: null,
        subdistrictName: null,
      });

      expect(await find(sourceId, { dealType: 'rent' })).toEqual([flatRent]);
      expect(await find(sourceId, { propertyType: 'house' })).toEqual([house]);
      expect(await find(sourceId, { cityRef: 96 })).toEqual([batumi]);
      expect(await find(sourceId, { subdistrictRef: 2 })).toEqual([vake]);
      expect((await find(sourceId, { districtRef: 3 })).sort()).toEqual(
        [flatSale, flatRent, house, vake].sort(),
      );
    });

    it('narrows by price in the currency asked for, leaving out listings with no price', async () => {
      const sourceId = await newSource();
      const cheap = await listing(sourceId, { priceUsd: '50000.00', priceGel: '135000.00' });
      const dear = await listing(sourceId, { priceUsd: '200000.00', priceGel: '540000.00' });
      await listing(sourceId, { priceUsd: null, priceGel: null });

      expect(await find(sourceId, { priceMax: 60_000, currency: 'usd' })).toEqual([cheap]);
      expect(await find(sourceId, { priceMin: 150_000, currency: 'usd' })).toEqual([dear]);
      // 300,000 is above both dollar prices and between the two lari ones.
      expect(await find(sourceId, { priceMax: 300_000, currency: 'gel' })).toEqual([cheap]);
    });

    it('narrows by area, rooms, floor, poster and how lately it was updated', async () => {
      const sourceId = await newSource();
      const base = await listing(sourceId);
      const big = await listing(sourceId, { areaM2: '140.00', rooms: 5 });
      const six = await listing(sourceId, { areaM2: '150.00', rooms: 6 });
      const ground = await listing(sourceId, { floor: 1 });
      const top = await listing(sourceId, { floor: 9, totalFloors: 9 });
      const agency = await listing(sourceId, { posterType: 'agent' });
      const old = await listing(sourceId, { sourceUpdatedAt: at(-10) });

      expect((await find(sourceId, { areaMin: 120 })).sort()).toEqual([big, six].sort());
      expect(await find(sourceId, { areaMin: 120, areaMax: 145 })).toEqual([big]);
      expect(await find(sourceId, { rooms: 5 })).toEqual([big]);
      expect((await find(sourceId, { rooms: 5, roomsOrMore: true })).sort()).toEqual(
        [big, six].sort(),
      );
      expect(await find(sourceId, { floor: 'not-first' })).not.toContain(ground);
      expect(await find(sourceId, { floor: 'not-first' })).toContain(top);
      expect(await find(sourceId, { floor: 'not-last' })).not.toContain(top);
      expect(await find(sourceId, { floor: 'not-last' })).toContain(ground);
      expect(await find(sourceId, { floor: 'middle' })).not.toContain(ground);
      expect(await find(sourceId, { floor: 'middle' })).not.toContain(top);
      expect(await find(sourceId, { floor: 'middle' })).toContain(base);
      expect(await find(sourceId, { poster: 'business' })).toEqual([agency]);
      expect(await find(sourceId, { poster: 'other' })).not.toContain(agency);
      expect(await find(sourceId, { updatedSince: at(-3) })).not.toContain(old);
      expect(await find(sourceId, { updatedSince: at(-30) })).toContain(old);
    });
  });

  describe('search', () => {
    it('finds a listing by its place in any case form, and typed in Latin letters', async () => {
      const sourceId = await newSource();
      const saburtalo = await listing(sourceId);
      await listing(sourceId, {
        districtRef: 5,
        districtName: 'ძველი თბილისი',
        subdistrictRef: 23,
        subdistrictName: 'ვერა',
        streetName: null,
      });

      for (const text of ['საბურთალო', 'საბურთალოზე', 'saburtalo', 'SABURTALO']) {
        expect(await find(sourceId, { text }), text).toEqual([saburtalo]);
      }
    });

    it('finds by street and by a word of the description, every word required', async () => {
      const sourceId = await newSource();
      const renovated = await listing(sourceId, { description: '<b>ახალი</b> რემონტით, ავეჯით' });
      await listing(sourceId, { description: 'სარემონტო' });

      expect(await find(sourceId, { text: 'ავეჯით' })).toEqual([renovated]);
      expect(await find(sourceId, { text: 'უნივერსიტეტის ავეჯი' })).toEqual([renovated]);
      expect(await find(sourceId, { text: 'ავეჯით გლდანი' })).toEqual([]);
    });

    it('cannot be used to look a listing up by a phone number in its description', async () => {
      const sourceId = await newSource();
      await listing(sourceId, { description: 'დარეკეთ 599 12 34 56 ან 599123456' });

      expect(await find(sourceId, { text: '599123456' })).toEqual([]);
      expect(await find(sourceId, { text: '599' })).toEqual([]);
      expect(await find(sourceId, { text: 'დარეკეთ' })).toHaveLength(1);
    });

    it('survives anything typed into it', async () => {
      const sourceId = await newSource();
      await listing(sourceId);

      for (const text of [
        "' | ! & ( ) : * \\ <->",
        "ვაკე':*) | ('",
        '%_;--',
        '   ',
        '🙂',
        'a'.repeat(300),
      ]) {
        await expect(find(sourceId, { text }), text).resolves.toBeInstanceOf(Array);
      }
      expect(listingSearchQuery('   ')).toBeNull();
      expect(listingSearchQuery('!!!')).toBeNull();
      // Only the letters the column is cut into words by reach the query.
      expect(listingSearchQuery('c++ c# ვაკე')).not.toMatch(/[+#]/);
    });
  });

  describe('order and paging', () => {
    it('sorts newest first by default, and by price, price per metre and area on request', async () => {
      const sourceId = await newSource();
      const a = await listing(sourceId, {
        sourceUpdatedAt: at(-3),
        priceUsd: '90000.00',
        pricePerM2Usd: '1500.00',
        areaM2: '60.00',
      });
      const b = await listing(sourceId, {
        sourceUpdatedAt: at(-1),
        priceUsd: '150000.00',
        pricePerM2Usd: '1000.00',
        areaM2: '150.00',
      });
      const unpriced = await listing(sourceId, {
        sourceUpdatedAt: at(-2),
        priceUsd: null,
        priceGel: null,
        pricePerM2Usd: null,
        areaM2: null,
      });

      expect(await find(sourceId)).toEqual([b, unpriced, a]);
      // A listing with no price is never the cheapest, nor the dearest.
      expect(await find(sourceId, { sort: 'price-asc' })).toEqual([a, b, unpriced]);
      expect(await find(sourceId, { sort: 'price-desc' })).toEqual([b, a, unpriced]);
      expect(await find(sourceId, { sort: 'ppm2-asc' })).toEqual([b, a, unpriced]);
      expect(await find(sourceId, { sort: 'area-desc' })).toEqual([b, a, unpriced]);
    });

    it('pages without repeating or dropping a row when times tie', async () => {
      const sourceId = await newSource();
      const ids: string[] = [];
      for (let index = 0; index < 5; index++) ids.push(await listing(sourceId));

      const first = await find(sourceId, { limit: 2 });
      const second = await find(sourceId, { limit: 2, offset: 2 });
      const third = await find(sourceId, { limit: 2, offset: 4 });

      expect([...first, ...second, ...third].sort()).toEqual([...ids].sort());
    });

    it('counts up to a ceiling and no further', async () => {
      const sourceId = await newSource();
      for (let index = 0; index < 5; index++) await listing(sourceId);

      expect(await countRealEstate(db, { sourceId }, NOW_ISO)).toBe(5);
      // One past the ceiling means "more than that".
      expect(await countRealEstate(db, { sourceId }, NOW_ISO, 3)).toBe(4);
    });
  });

  describe('realEstateLocations', () => {
    it('lists the places that have listings on show, with how many', async () => {
      const sourceId = await newSource();
      await listing(sourceId);
      await listing(sourceId);
      await listing(sourceId, { subdistrictRef: 2, subdistrictName: 'ვაკე' });
      await listing(sourceId, { status: 'gone', subdistrictRef: 9, subdistrictName: 'დიდუბე' });
      // Active, but past its expected end and unseen for longer than the grace.
      await listing(sourceId, {
        subdistrictRef: 9,
        subdistrictName: 'დიდუბე',
        expectedEndAt: at(-5),
        lastSeenAt: at(-10),
      });
      await listing(sourceId, {
        cityRef: 96,
        cityName: 'ბათუმი',
        districtRef: null,
        districtName: null,
        subdistrictRef: null,
        subdistrictName: null,
      });

      const places = await realEstateLocations(db, { sourceId }, NOW_ISO);

      expect(places.cities).toEqual([
        { ref: 95, name: 'თბილისი', count: 3 },
        { ref: 96, name: 'ბათუმი', count: 1 },
      ]);
      expect(places.subdistricts).toEqual([
        {
          ref: 3,
          name: 'საბურთალო',
          count: 2,
          cityRef: 95,
          districtRef: 3,
          districtName: 'ვაკე-საბურთალო',
        },
        {
          ref: 2,
          name: 'ვაკე',
          count: 1,
          cityRef: 95,
          districtRef: 3,
          districtName: 'ვაკე-საბურთალო',
        },
      ]);
    });
  });
});
