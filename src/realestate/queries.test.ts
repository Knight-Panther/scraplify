import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import { type NewRealEstateListingRow, realEstateListings } from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import {
  countExactly,
  countRealEstate,
  detailsCoverage,
  hasDetailFilter,
  type RealEstateFilters,
  realEstateLocations,
  searchRealEstate,
  withinTimeout,
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
    it('shows an active listing until its expected end, with no days of grace', async () => {
      // 2026-11-10: of 60 listings shown in their two days of grace, 51 were
      // gone on ss.ge, and the end we expect is the site's own to the second.
      const sourceId = await newSource();
      const live = await listing(sourceId);
      const endsInAnHour = await listing(sourceId, { expectedEndAt: at(1 / 24) });
      await listing(sourceId, { expectedEndAt: at(-1 / 24), lastSeenAt: at(-10) });
      await listing(sourceId, { expectedEndAt: at(-1), lastSeenAt: at(-10) });
      await listing(sourceId, { status: 'gone', goneAt: at(-1) });

      expect((await find(sourceId)).sort()).toEqual([live, endsInAnHour].sort());
      expect(await countRealEstate(db, { sourceId }, NOW_ISO)).toBe(2);
    });

    it('does not show a listing past its expected end because a list showed it lately', async () => {
      const sourceId = await newSource();
      // Ordered two years ago, on the site this morning. It is first among the
      // night's checks, and its own page then states an end (guideline §9.3).
      await listing(sourceId, {
        sourceUpdatedAt: at(-700),
        expectedEndAt: at(-670),
        lastSeenAt: at(-0.5),
      });

      expect(await find(sourceId)).toEqual([]);
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

    it('filters commercial listings by space type, several at once', async () => {
      const sourceId = await newSource();
      const commercial = {
        propertyType: 'commercial' as const,
        dealType: 'rent' as const,
        rooms: null,
      };
      const office = await listing(sourceId, { ...commercial, commercialType: 7 });
      const shop = await listing(sourceId, { ...commercial, commercialType: 22 });
      await listing(sourceId, { ...commercial, commercialType: 14 });
      await listing(sourceId, { ...commercial, commercialType: null });
      const farm = await listing(sourceId, { propertyType: 'land', rooms: null, landType: 6 });
      await listing(sourceId, { propertyType: 'land', rooms: null, landType: 1 });

      expect((await find(sourceId, { commercialTypes: [7, 22] })).sort()).toEqual(
        [office, shop].sort(),
      );
      expect(await find(sourceId, { landTypes: [6] })).toEqual([farm]);
      // An empty choice narrows nothing.
      expect(await find(sourceId, { commercialTypes: [] })).toHaveLength(6);
      const [row] = await searchRealEstate(db, { sourceId, landTypes: [6] }, NOW_ISO);
      expect(row).toMatchObject({ propertyType: 'land', landType: 6, commercialType: null });
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
      expect(await find(sourceId, { roomsIn: [5] })).toEqual([big]);
      expect((await find(sourceId, { roomsIn: [5, 6] })).sort()).toEqual([big, six].sort());
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

  describe('more filters (Phase 12C)', () => {
    /** A listing whose own page was read (Phase 12B). */
    const read = { detailsReadAt: at(-0.5) };
    const sorted = (ids: string[]) => [...ids].sort();

    it('narrows by building status, condition, project and floor type, any of each', async () => {
      const sourceId = await newSource();
      const fresh = await listing(sourceId, {
        ...read,
        buildingStatus: 'new',
        condition: 'newly-renovated',
        project: 'czech',
        floorType: 'duplex',
      });
      const old = await listing(sourceId, {
        ...read,
        buildingStatus: 'old',
        condition: 'renovated',
        project: 'khrushchev',
      });
      const building = await listing(sourceId, {
        ...read,
        buildingStatus: 'under-construction',
        condition: 'white-frame',
        floorType: 'attic',
      });
      await listing(sourceId, read);

      expect(await find(sourceId, { buildingStatuses: ['new'] })).toEqual([fresh]);
      expect(sorted(await find(sourceId, { buildingStatuses: ['new', 'old'] }))).toEqual(
        sorted([fresh, old]),
      );
      expect(sorted(await find(sourceId, { conditions: ['renovated', 'white-frame'] }))).toEqual(
        sorted([old, building]),
      );
      expect(await find(sourceId, { projects: ['khrushchev'] })).toEqual([old]);
      expect(sorted(await find(sourceId, { floorTypes: ['duplex', 'attic'] }))).toEqual(
        sorted([fresh, building]),
      );
      // Two choices from different groups must both hold.
      expect(
        await find(sourceId, { buildingStatuses: ['new', 'old'], conditions: ['renovated'] }),
      ).toEqual([old]);
      // An empty choice narrows nothing.
      expect(await find(sourceId, { conditions: [], projects: [] })).toHaveLength(4);
    });

    it('counts bathrooms, balconies and rooms, the top choice meaning that many or more', async () => {
      const sourceId = await newSource();
      const one = await listing(sourceId, { ...read, bathrooms: 1, balconies: 1, rooms: 1 });
      const five = await listing(sourceId, { ...read, bathrooms: 5, balconies: 5, rooms: 10 });
      const seven = await listing(sourceId, { ...read, bathrooms: 7, balconies: 6, rooms: 12 });
      const none = await listing(sourceId, { ...read, bathrooms: 0, balconies: 0, rooms: 3 });
      // Read, but the page did not say: unknown, never "none".
      const unsaid = await listing(sourceId, {
        ...read,
        bathrooms: null,
        balconies: null,
        rooms: 4,
      });

      expect(sorted(await find(sourceId, { bathrooms: [5] }))).toEqual(sorted([five, seven]));
      expect(await find(sourceId, { bathrooms: [0] })).toEqual([none]);
      expect(sorted(await find(sourceId, { bathrooms: [1, 5] }))).toEqual(
        sorted([one, five, seven]),
      );
      expect(sorted(await find(sourceId, { balconies: [5] }))).toEqual(sorted([five, seven]));
      expect(await find(sourceId, { balconies: [0] })).toEqual([none]);
      expect(await find(sourceId, { balconies: [0, 1] })).not.toContain(unsaid);
      expect(sorted(await find(sourceId, { roomsIn: [1, 10] }))).toEqual(
        sorted([one, five, seven]),
      );
      expect(await find(sourceId, { roomsIn: [2, 3] })).toEqual([none]);
    });

    it('narrows by a floor range, which needs no listing page, and by kitchen, house and yard area', async () => {
      const sourceId = await newSource();
      const third = await listing(sourceId);
      await listing(sourceId, { floor: 1 });
      await listing(sourceId, { floor: 9 });
      const house = await listing(sourceId, {
        ...read,
        propertyType: 'house',
        floor: null,
        houseArea: '180.00',
        yardArea: '600.00',
      });
      const kitchen = await listing(sourceId, { ...read, floor: null, kitchenArea: '14.50' });

      expect(await find(sourceId, { floorMin: 2, floorMax: 5 })).toEqual([third]);
      expect(await find(sourceId, { kitchenAreaMin: 12 })).toEqual([kitchen]);
      expect(await find(sourceId, { kitchenAreaMax: 12 })).toEqual([]);
      expect(await find(sourceId, { houseAreaMin: 150, houseAreaMax: 200 })).toEqual([house]);
      expect(await find(sourceId, { yardAreaMin: 700 })).toEqual([]);
      expect(await find(sourceId, { yardAreaMax: 700 })).toEqual([house]);
    });

    it('matches amenities only when a listing has all of those chosen', async () => {
      const sourceId = await newSource();
      const both = await listing(sourceId, {
        ...read,
        amenities: ['elevator', 'garage', 'storage'],
      });
      const lift = await listing(sourceId, { ...read, amenities: ['elevator'] });
      await listing(sourceId, { ...read, amenities: [] });

      expect(sorted(await find(sourceId, { amenities: ['elevator'] }))).toEqual(
        sorted([both, lift]),
      );
      expect(await find(sourceId, { amenities: ['elevator', 'garage'] })).toEqual([both]);
      expect(await find(sourceId, { amenities: [] })).toHaveLength(3);
    });

    it('narrows to owners, developers, listings with photos and exclusive listings', async () => {
      const sourceId = await newSource();
      const owner = await listing(sourceId, { ...read, posterEntity: 'individual' });
      await listing(sourceId, { ...read, posterEntity: 'agency', posterType: 'agent' });
      // Developer, photos and exclusive come from the results row: no page needed.
      const developer = await listing(sourceId, { posterType: 'developer' });
      const photos = await listing(sourceId, { imageCount: 4 });
      await listing(sourceId, { imageCount: 0 });
      const exclusive = await listing(sourceId, { exclusive: true });

      expect(await find(sourceId, { ownerOnly: true })).toEqual([owner]);
      expect(await find(sourceId, { developerOnly: true })).toEqual([developer]);
      expect(await find(sourceId, { withPhotos: true })).toEqual([photos]);
      expect(await find(sourceId, { exclusiveOnly: true })).toEqual([exclusive]);
      expect(await find(sourceId, { ownerOnly: false, withPhotos: false })).toHaveLength(6);
    });

    it('applies the price bounds to the price per m² when asked, in the currency asked for', async () => {
      const sourceId = await newSource();
      // $100,000 for 60 m² and for 200 m².
      await listing(sourceId);
      const roomy = await listing(sourceId, {
        areaM2: '200.00',
        pricePerM2Usd: '500.00',
        pricePerM2Gel: '1350.00',
      });

      expect(await find(sourceId, { pricePerM2: true, priceMax: 1000, currency: 'usd' })).toEqual([
        roomy,
      ]);
      expect(await find(sourceId, { pricePerM2: true, priceMax: 1000, currency: 'gel' })).toEqual(
        [],
      );
      expect(await find(sourceId, { pricePerM2: true, priceMin: 1000, currency: 'gel' })).toEqual([
        roomy,
      ]);
      expect(await find(sourceId, { priceMax: 1000, currency: 'usd' })).toEqual([]);
    });

    it('never matches a listing whose page was not read, for any detail filter', async () => {
      const sourceId = await newSource();
      const details = {
        buildingStatus: 'new',
        condition: 'renovated',
        project: 'czech',
        floorType: 'duplex',
        bathrooms: 2,
        balconies: 0,
        kitchenArea: '12.00',
        houseArea: '150.00',
        yardArea: '300.00',
        amenities: ['elevator'],
        posterEntity: 'individual',
      };
      const judged = await listing(sourceId, { ...details, ...read });
      await listing(sourceId, { ...details, detailsReadAt: null });

      const detailFilters: Partial<RealEstateFilters>[] = [
        { buildingStatuses: ['new'] },
        { conditions: ['renovated'] },
        { projects: ['czech'] },
        { floorTypes: ['duplex'] },
        { bathrooms: [2] },
        { balconies: [0] },
        { kitchenAreaMin: 10 },
        { houseAreaMax: 200 },
        { yardAreaMin: 100 },
        { amenities: ['elevator'] },
        { ownerOnly: true },
      ];
      for (const filter of detailFilters) {
        expect(await find(sourceId, filter), JSON.stringify(filter)).toEqual([judged]);
      }
    });

    it('counts how many of the matching listings have details', async () => {
      const sourceId = await newSource();
      await listing(sourceId, { ...read, condition: 'renovated' });
      await listing(sourceId, { ...read, condition: 'old-renovation' });
      await listing(sourceId);
      await listing(sourceId, { ...read, propertyType: 'house' });
      const filters = {
        sourceId,
        propertyType: 'flat' as const,
        conditions: ['renovated' as const],
      };

      // Every flat counts, whatever its condition: the line says how many could be judged.
      expect(await detailsCoverage(db, filters, NOW_ISO)).toEqual({ read: 2, total: 3 });
      expect(await detailsCoverage(db, { sourceId, grouped: true }, NOW_ISO)).toEqual({
        read: 3,
        total: 4,
      });
      // Counted no further than one past the ceiling, as countRealEstate is.
      expect(await detailsCoverage(db, filters, NOW_ISO, 1)).toEqual({ read: 2, total: 2 });
      // Or every one.
      expect(await detailsCoverage(db, filters, NOW_ISO, null)).toEqual({ read: 2, total: 3 });
    });

    it('returns each row’s building status and condition, or null when not known', async () => {
      const sourceId = await newSource();
      const known = await listing(sourceId, {
        ...read,
        buildingStatus: 'new',
        condition: 'white-frame',
      });
      const unread = await listing(sourceId);

      const rows = await searchRealEstate(db, { sourceId }, NOW_ISO);
      const byId = new Map(rows.map((row) => [row.id, row]));

      expect(byId.get(known)).toMatchObject({ buildingStatus: 'new', condition: 'white-frame' });
      expect(byId.get(unread)).toMatchObject({ buildingStatus: null, condition: null });
    });

    it('says which filters need a listing page', () => {
      expect(hasDetailFilter({ conditions: ['renovated'] })).toBe(true);
      expect(hasDetailFilter({ ownerOnly: true })).toBe(true);
      expect(hasDetailFilter({ yardAreaMax: 500 })).toBe(true);
      expect(hasDetailFilter({ conditions: [], ownerOnly: false })).toBe(false);
      expect(
        hasDetailFilter({ developerOnly: true, withPhotos: true, floorMin: 2, roomsIn: [3] }),
      ).toBe(false);
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

    it('does not answer a neighbourhood with the whole district that carries its name', async () => {
      // Tbilisi districts are named as pairs ('ვაკე-საბურთალო'); with the
      // district searched, 'vake' returned 5,812 houses for rent of which 479
      // were in Vake (first pass, 2026-10-13).
      const sourceId = await newSource();
      await listing(sourceId);
      const vake = await listing(sourceId, { subdistrictRef: 2, subdistrictName: 'ვაკე' });

      for (const text of ['ვაკე', 'ვაკეში', 'vake']) {
        expect(await find(sourceId, { text }), text).toEqual([vake]);
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

    it('takes a phone number out however its digits are spaced', async () => {
      const sourceId = await newSource();
      await listing(sourceId, {
        description: [
          'წერტილებით 577.11.22.33',
          'ხაზებით 568/44/55/66',
          'უწყვეტი ჰარით 591\u00a077\u00a088\u00a099',
          'ახალი ხაზით 555\n12\n34\n56',
          'კოდით (+995) 514-10-20-30',
        ].join(' ; '),
      });

      for (const fragment of ['577', '568', '591', '555', '514', '995', '22', '66', '99', '34']) {
        expect(await find(sourceId, { text: fragment }), fragment).toEqual([]);
      }
      // The words around the numbers are still found.
      expect(await find(sourceId, { text: 'წერტილებით კოდით' })).toHaveLength(1);
    });

    it('keeps short numbers a reader may search by', async () => {
      const sourceId = await newSource();
      const flat = await listing(sourceId, {
        description: 'კორპუსი 12, მე-3 სადარბაზო, 2020 წელი',
      });

      expect(await find(sourceId, { text: '2020' })).toEqual([flat]);
      expect(await find(sourceId, { text: 'კორპუსი 12' })).toEqual([flat]);
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

    it('puts a typo price or area after every other listing in the price and area sorts', async () => {
      const sourceId = await newSource();
      const fair = await listing(sourceId, {
        sourceUpdatedAt: at(-3),
        priceUsd: '90000.00',
        priceGel: '243000.00',
        pricePerM2Usd: '1500.00',
        areaM2: '60.00',
      });
      // Each is real (2026-10-27): its rent posted as the sale price, no area
      // given, the price typed as the area.
      const rentAsSale = await listing(sourceId, {
        sourceUpdatedAt: at(-1),
        priceUsd: '462.00',
        priceGel: '1200.00',
        pricePerM2Usd: '10.00',
        areaM2: '46.00',
      });
      const oneMetre = await listing(sourceId, {
        sourceUpdatedAt: at(-2),
        priceUsd: '72000.00',
        priceGel: '194000.00',
        pricePerM2Usd: '72000.00',
        areaM2: '1.00',
      });
      const priceAsArea = await listing(sourceId, {
        sourceUpdatedAt: at(-4),
        priceUsd: '42000.00',
        priceGel: '109000.00',
        pricePerM2Usd: '1.00',
        areaM2: '42000.00',
      });
      // Big but plausible: a 1,100 m² flat at $1.6 million.
      const big = await listing(sourceId, {
        sourceUpdatedAt: at(-5),
        priceUsd: '1600000.00',
        priceGel: '4158000.00',
        pricePerM2Usd: '1454.00',
        areaM2: '1100.00',
      });
      // No price and no area is not a typo either.
      const bare = await listing(sourceId, {
        sourceUpdatedAt: at(-6),
        priceUsd: null,
        priceGel: null,
        pricePerM2Usd: null,
        areaM2: null,
      });

      expect(await find(sourceId, { sort: 'price-asc' })).toEqual([
        fair,
        big,
        bare,
        rentAsSale,
        priceAsArea,
        oneMetre,
      ]);
      expect(await find(sourceId, { sort: 'price-asc', currency: 'gel' })).toEqual([
        fair,
        big,
        bare,
        rentAsSale,
        priceAsArea,
        oneMetre,
      ]);
      expect(await find(sourceId, { sort: 'price-desc' })).toEqual([
        big,
        fair,
        bare,
        oneMetre,
        priceAsArea,
        rentAsSale,
      ]);
      expect(await find(sourceId, { sort: 'ppm2-asc' })).toEqual([
        big,
        fair,
        bare,
        priceAsArea,
        rentAsSale,
        oneMetre,
      ]);
      expect(await find(sourceId, { sort: 'area-desc' })).toEqual([
        big,
        fair,
        bare,
        priceAsArea,
        rentAsSale,
        oneMetre,
      ]);
      // Newest first is not about value: the typos keep their place there.
      expect((await find(sourceId))[0]).toBe(rentAsSale);
    });

    it('takes a rent of $87,500 a month for a typo, and $3,500 for a rent', async () => {
      const sourceId = await newSource();
      const rent = { dealType: 'rent' as const, pricePerM2Usd: '58.00', areaM2: '60.00' };
      const saleAsRent = await listing(sourceId, {
        ...rent,
        priceUsd: '87500.00',
        priceGel: '227000.00',
      });
      const dear = await listing(sourceId, { ...rent, priceUsd: '3500.00', priceGel: '9450.00' });
      const cheap = await listing(sourceId, { ...rent, priceUsd: '400.00', priceGel: '1080.00' });

      expect(await find(sourceId, { sort: 'price-desc' })).toEqual([dear, cheap, saleAsRent]);
    });

    it('takes a sale price posted as rent for a typo by its price per m², however far under $50,000', async () => {
      const sourceId = await newSource();
      const rent = { dealType: 'rent' as const };
      // Live on 2026-11-06: $43,000 for 25 m² and $12,000 for 35 m² "a month".
      const saleAsRent = await listing(sourceId, {
        ...rent,
        priceUsd: '43000.00',
        areaM2: '25.00',
      });
      const small = await listing(sourceId, { ...rent, priceUsd: '12000.00', areaM2: '35.00' });
      // $43 a m² in Vake is a dear rent, not a typo; with no area there is no ratio to judge.
      const dear = await listing(sourceId, { ...rent, priceUsd: '5200.00', areaM2: '120.00' });
      const noArea = await listing(sourceId, {
        ...rent,
        priceUsd: '900.00',
        areaM2: null,
        pricePerM2Usd: '900.00',
      });

      expect(await find(sourceId, { sort: 'price-desc' })).toEqual([
        dear,
        noArea,
        saleAsRent,
        small,
      ]);
    });

    it('does not sort a $31-a-night daily rent last as a typo', async () => {
      const sourceId = await newSource();
      const daily = { dealType: 'daily' as const, areaM2: '45.00', pricePerM2Usd: '1.00' };
      const night = await listing(sourceId, { ...daily, priceUsd: '31.00', priceGel: '84.00' });
      const villa = await listing(sourceId, { ...daily, priceUsd: '450.00', priceGel: '1215.00' });
      // A sale price typed into a daily rent, and a price of nothing.
      const saleAsDaily = await listing(sourceId, {
        ...daily,
        priceUsd: '95000.00',
        priceGel: '256000.00',
      });
      const oneDollar = await listing(sourceId, { ...daily, priceUsd: '1.00', priceGel: '3.00' });

      expect(await find(sourceId, { sort: 'price-asc' })).toEqual([
        night,
        villa,
        oneDollar,
        saleAsDaily,
      ]);
    });

    it('takes $1,500 for pledge for real, and $500 for a typo', async () => {
      const sourceId = await newSource();
      const pledge = { dealType: 'pledge' as const };
      const small = await listing(sourceId, {
        ...pledge,
        priceUsd: '1500.00',
        priceGel: '4050.00',
      });
      const typo = await listing(sourceId, { ...pledge, priceUsd: '500.00', priceGel: '1350.00' });

      expect(await find(sourceId, { sort: 'price-asc' })).toEqual([small, typo]);
    });

    it('does not call 50,000 m² of land at $2 a m² a typo', async () => {
      const sourceId = await newSource();
      const field = await listing(sourceId, {
        propertyType: 'land',
        rooms: null,
        areaM2: '50000.00',
        priceUsd: '100000.00',
        priceGel: '270000.00',
        pricePerM2Usd: '2.00',
      });
      const plot = await listing(sourceId, {
        propertyType: 'land',
        rooms: null,
        areaM2: '600.00',
        priceUsd: '30000.00',
        priceGel: '81000.00',
        pricePerM2Usd: '50.00',
      });
      // A warehouse of 20,000 m² at $5 a m² is still a typo.
      const warehouse = await listing(sourceId, {
        propertyType: 'commercial',
        rooms: null,
        areaM2: '20000.00',
        priceUsd: '100000.00',
        priceGel: '270000.00',
        pricePerM2Usd: '5.00',
      });

      expect(await find(sourceId, { sort: 'area-desc' })).toEqual([field, plot, warehouse]);
    });

    it('still sorts a flat for sale at $462 last', async () => {
      const sourceId = await newSource();
      const fair = await listing(sourceId, { priceUsd: '90000.00', priceGel: '243000.00' });
      const rentAsSale = await listing(sourceId, { priceUsd: '462.00', priceGel: '1200.00' });

      expect(await find(sourceId, { sort: 'price-asc' })).toEqual([fair, rentAsSale]);
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
      // No ceiling: every one.
      expect(await countRealEstate(db, { sourceId }, NOW_ISO, null)).toBe(5);
    });

    it('counts look-alike groups exactly, one per group, with no ceiling', async () => {
      const sourceId = await newSource();
      for (let index = 0; index < 3; index++) await listing(sourceId, { groupKey: 'g1' });
      for (let index = 0; index < 2; index++) await listing(sourceId, { groupKey: 'g2' });
      await listing(sourceId);

      expect(await countRealEstate(db, { sourceId, grouped: true }, NOW_ISO, null)).toBe(3);
      expect(await countRealEstate(db, { sourceId, grouped: true }, NOW_ISO, 1)).toBe(2);
    });

    it('counts exactly within the time limit, and settles for the capped count past it', async () => {
      const sourceId = await newSource();
      for (let index = 0; index < 5; index++) await listing(sourceId);

      expect(
        await countExactly(
          db,
          (tx) => countRealEstate(tx, { sourceId }, NOW_ISO, null),
          () => countRealEstate(db, { sourceId }, NOW_ISO, 3),
        ),
      ).toEqual({ value: 5, exact: true });
      // A count that outlasts the limit gives way to the capped one.
      expect(
        await countExactly(
          db,
          async (tx) => {
            await tx.execute(sql`select pg_sleep(1)`);
            return countRealEstate(tx, { sourceId }, NOW_ISO, null);
          },
          () => countRealEstate(db, { sourceId }, NOW_ISO, 3),
          50,
        ),
      ).toEqual({ value: 4, exact: false });
    });
  });

  describe('withinTimeout', () => {
    it('answers within the limit, gives null past it, and lets every other error through', async () => {
      const read = (tx: Parameters<Parameters<typeof withinTimeout>[2]>[0]) =>
        tx.execute<{ n: number }>(sql`select 1 as n`).then((r) => r.rows[0]?.n);
      expect(await withinTimeout(db, 1_000, read)).toBe(1);
      expect(
        await withinTimeout(db, 50, (tx) =>
          tx.execute(sql`select pg_sleep(1)`).then(() => 'slept'),
        ),
      ).toBeNull();
      await expect(
        withinTimeout(db, 1_000, (tx) => tx.execute(sql`select * from no_such_table`)),
      ).rejects.toThrow();
    });

    it('reads only, and leaves the pool’s statements without its limit', async () => {
      await expect(
        withinTimeout(db, 1_000, (tx) => tx.execute(sql`create temporary table t (n int)`)),
      ).rejects.toThrow();
      const after = await db.execute<{ limit: string }>(
        sql`select current_setting('statement_timeout') as limit`,
      );
      expect(after.rows[0]?.limit).toBe('0');
    });
  });

  describe('realEstateLocations', () => {
    it('lists the places that have listings on show, with how many', async () => {
      const sourceId = await newSource();
      await listing(sourceId);
      await listing(sourceId);
      await listing(sourceId, { subdistrictRef: 2, subdistrictName: 'ვაკე' });
      await listing(sourceId, { status: 'gone', subdistrictRef: 9, subdistrictName: 'დიდუბე' });
      // Active, but past its expected end.
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

  describe('look-alike groups (Phase 11D)', () => {
    /** Three copies of one flat (an agent's, an owner's, another agent's) and a flat on its own. */
    async function oneFlatThreeTimes(sourceId: string) {
      const agentNewest = await listing(sourceId, {
        groupKey: 'g1',
        posterType: 'agent',
        priceUsd: '151000.00',
        sourceUpdatedAt: at(-0.2),
      });
      const owner = await listing(sourceId, {
        groupKey: 'g1',
        posterType: 'owner',
        priceUsd: '149000.00',
        sourceUpdatedAt: at(-2),
      });
      const agentOld = await listing(sourceId, {
        groupKey: 'g1',
        posterType: 'agent',
        priceUsd: '150000.00',
        sourceUpdatedAt: at(-4),
      });
      const alone = await listing(sourceId, { rooms: 3, sourceUpdatedAt: at(-1) });
      return { agentNewest, owner, agentOld, alone };
    }

    it('folds a group into its first row in the page’s order, with how many it stands for', async () => {
      const sourceId = await newSource();
      const flat = await oneFlatThreeTimes(sourceId);

      const newest = await searchRealEstate(db, { sourceId, grouped: true }, NOW_ISO);
      expect(newest.map((row) => [row.id, row.alikeCount])).toEqual([
        [flat.agentNewest, 3],
        [flat.alone, 1],
      ]);
      expect(newest[0]?.groupKey).toBe('g1');

      // Cheapest first, the group is shown by its cheapest copy.
      const cheapest = await searchRealEstate(
        db,
        { sourceId, grouped: true, sort: 'price-asc' },
        NOW_ISO,
      );
      expect(cheapest.map((row) => row.id)).toEqual([flat.alone, flat.owner]);
      expect(await countRealEstate(db, { sourceId, grouped: true }, NOW_ISO)).toBe(2);
    });

    it('filters every listing before folding, so a group led by an agent still answers “not an agency”', async () => {
      const sourceId = await newSource();
      const flat = await oneFlatThreeTimes(sourceId);

      const rows = await searchRealEstate(
        db,
        { sourceId, grouped: true, poster: 'other' },
        NOW_ISO,
      );
      expect(rows.map((row) => [row.id, row.alikeCount])).toEqual([
        [flat.alone, 1],
        [flat.owner, 1],
      ]);
    });

    it('lists every member of one group, and every listing when not grouping', async () => {
      const sourceId = await newSource();
      const flat = await oneFlatThreeTimes(sourceId);

      expect(await find(sourceId, { groupKey: 'g1' })).toEqual([
        flat.agentNewest,
        flat.owner,
        flat.agentOld,
      ]);
      expect(await countRealEstate(db, { sourceId, groupKey: 'g1' }, NOW_ISO)).toBe(3);
      expect(await countRealEstate(db, { sourceId }, NOW_ISO)).toBe(4);
      const all = await searchRealEstate(db, { sourceId }, NOW_ISO);
      expect(all.map((row) => row.alikeCount)).toEqual([1, 1, 1, 1]);
    });

    it('pages through groups without repeating or dropping one', async () => {
      const sourceId = await newSource();
      for (let n = 0; n < 6; n++) {
        await listing(sourceId, {
          groupKey: `p${n}`,
          sourceUpdatedAt: at(-n),
          priceUsd: '100000.00',
        });
        await listing(sourceId, {
          groupKey: `p${n}`,
          sourceUpdatedAt: at(-n - 0.5),
          priceUsd: '100500.00',
        });
      }
      const pages = [0, 2, 4].map((offset) =>
        searchRealEstate(db, { sourceId, grouped: true, limit: 2, offset }, NOW_ISO),
      );
      const keys = (await Promise.all(pages)).flat().map((row) => row.groupKey);
      expect(keys).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    });
  });
});
