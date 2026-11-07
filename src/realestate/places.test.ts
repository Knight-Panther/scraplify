import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  type NewRealEstateListingRow,
  realEstateListings,
  realEstatePlaces,
} from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import type { PlaceLevel } from './kinds.js';
import {
  backfillStoredListings,
  loadDistrictParents,
  loadListingsForPlacePoints,
  recordStreetPoint,
  syncPlaces,
} from './places.js';

const NOW = '2026-11-07T14:00:00.000Z';
const LATER = '2026-11-08T14:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(Date.parse(NOW) + days * DAY_MS).toISOString();

describe('the place tree (Phase 14A)', () => {
  const sourceIds: string[] = [];
  let nextKey = 1;

  async function newSource(): Promise<string> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    return sourceId;
  }

  /** A flat in Saburtalo on Shartava St, unless told otherwise. */
  async function listing(sourceId: string, overrides: Partial<NewRealEstateListingRow> = {}) {
    const key = `p${nextKey++}`;
    const [row] = await db
      .insert(realEstateListings)
      .values({
        sourceId,
        sourceListingKey: key,
        canonicalUrl: `https://example.invalid/${key}`,
        dealType: 'sale',
        propertyType: 'flat',
        cityRef: 95,
        cityName: 'თბილისი',
        districtRef: 3,
        districtName: 'ვაკე-საბურთალო',
        subdistrictRef: 3,
        subdistrictName: 'საბურთალო',
        streetRef: 116,
        streetName: 'შარტავას ქ.',
        sourceUpdatedAt: at(-1),
        expectedEndAt: at(29),
        firstSeenAt: at(-1),
        lastSeenAt: at(-1),
        contentHash: 'h',
        ...overrides,
      })
      .returning({ id: realEstateListings.id });
    if (row === undefined) throw new Error('listing was not inserted');
    return row.id;
  }

  async function place(sourceId: string, level: PlaceLevel, ref: number) {
    const [row] = await db
      .select()
      .from(realEstatePlaces)
      .where(
        and(
          eq(realEstatePlaces.sourceId, sourceId),
          eq(realEstatePlaces.level, level),
          eq(realEstatePlaces.ref, ref),
        ),
      );
    return row;
  }

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  describe('syncPlaces', () => {
    it('builds each level from the active listings, under its parent, with how many name it', async () => {
      const sourceId = await newSource();
      await listing(sourceId);
      await listing(sourceId);
      await listing(sourceId, { status: 'gone', streetRef: 999, streetName: 'გონე ქ.' });
      // A settlement outside the main cities, its municipality from its page.
      await listing(sourceId, {
        cityRef: 70,
        cityName: 'წავკისი',
        districtRef: null,
        districtName: null,
        subdistrictRef: null,
        subdistrictName: null,
        streetRef: null,
        streetName: null,
        municipalityRef: 1,
        municipalityName: 'თბილისის შემოგარენი',
      });

      const added = await syncPlaces(db, { sourceId, at: NOW });

      expect(added).toEqual({ municipality: 1, city: 2, district: 1, subdistrict: 1, street: 1 });
      expect(await place(sourceId, 'street', 116)).toMatchObject({
        parentLevel: 'subdistrict',
        parentRef: 3,
        nameKa: 'შარტავას ქ.',
        activeListings: 2,
        pointStatus: 'unknown',
      });
      expect(await place(sourceId, 'subdistrict', 3)).toMatchObject({
        parentLevel: 'district',
        parentRef: 3,
      });
      expect(await place(sourceId, 'district', 3)).toMatchObject({
        parentLevel: 'city',
        parentRef: 95,
      });
      expect(await place(sourceId, 'city', 70)).toMatchObject({
        parentLevel: 'municipality',
        parentRef: 1,
      });
      expect(await place(sourceId, 'street', 999)).toBeUndefined();
    });

    it('names a place as most of its listings do, and keeps the old name of a renamed one', async () => {
      const sourceId = await newSource();
      await listing(sourceId);
      await syncPlaces(db, { sourceId, at: NOW });
      await listing(sourceId, { streetName: 'ჟ. შარტავას ქ.' });
      await listing(sourceId, { streetName: 'ჟ. შარტავას ქ.' });

      const added = await syncPlaces(db, { sourceId, at: LATER });

      expect(added.street).toBe(0);
      expect(await place(sourceId, 'street', 116)).toMatchObject({
        nameKa: 'ჟ. შარტავას ქ.',
        aliases: ['შარტავას ქ.'],
        activeListings: 3,
      });
    });

    it('takes a sub-district’s district over the city its legacy listings name, and never a filled one', async () => {
      const sourceId = await newSource();
      // Two legacy listings with no district, one stating it, one filled in.
      await listing(sourceId, { districtRef: null, districtName: null });
      await listing(sourceId, { districtRef: null, districtName: null });
      await listing(sourceId);
      await listing(sourceId, { districtRef: 9, districtName: 'x', districtInferred: true });

      await syncPlaces(db, { sourceId, at: NOW });

      expect(await place(sourceId, 'subdistrict', 3)).toMatchObject({
        parentLevel: 'district',
        parentRef: 3,
      });
      expect(await place(sourceId, 'district', 9)).toBeUndefined();
    });

    it('keeps a place no active listing names any more, with none, and its parent', async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId);
      await syncPlaces(db, { sourceId, at: NOW });
      await db
        .update(realEstateListings)
        .set({ status: 'gone' })
        .where(eq(realEstateListings.id, id));

      await syncPlaces(db, { sourceId, at: LATER });

      expect(await place(sourceId, 'street', 116)).toMatchObject({
        activeListings: 0,
        parentLevel: 'subdistrict',
      });
    });

    it('never moves a place to a vaguer parent', async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId);
      await syncPlaces(db, { sourceId, at: NOW });
      await db
        .update(realEstateListings)
        .set({ districtRef: null, districtName: null })
        .where(eq(realEstateListings.id, id));

      await syncPlaces(db, { sourceId, at: LATER });

      expect(await place(sourceId, 'subdistrict', 3)).toMatchObject({
        parentLevel: 'district',
        parentRef: 3,
      });
    });

    it('feeds the district fill: each sub-district’s district by its name', async () => {
      const sourceId = await newSource();
      await listing(sourceId);
      await listing(sourceId, {
        districtRef: 5,
        districtName: 'ძველი თბილისი',
        subdistrictRef: 21,
        subdistrictName: 'ავლაბარი',
      });
      await syncPlaces(db, { sourceId, at: NOW });

      const parents = await loadDistrictParents(db, sourceId);

      expect([...parents.entries()].sort(([a], [b]) => a - b)).toEqual([
        [3, { ref: 3, name: 'ვაკე-საბურთალო' }],
        [21, { ref: 5, name: 'ძველი თბილისი' }],
      ]);
    });
  });

  describe('recordStreetPoint', () => {
    const shartava = {
      streetRef: 116,
      streetName: 'შარტავას ქ.',
      subdistrictRef: 3,
      cityRef: 95,
    };

    it('adds a street the tree does not hold yet, with its point', async () => {
      const sourceId = await newSource();

      await recordStreetPoint(db, {
        sourceId,
        ...shartava,
        point: { status: 'known', latitude: 41.73067, longitude: 44.769665 },
        readAt: NOW,
      });

      const row = await place(sourceId, 'street', 116);
      expect(row).toMatchObject({
        parentLevel: 'subdistrict',
        parentRef: 3,
        nameKa: 'შარტავას ქ.',
        pointStatus: 'known',
        latitude: '41.730670',
        longitude: '44.769665',
      });
      expect(Date.parse(row?.pointCheckedAt ?? '')).toBe(Date.parse(NOW));
    });

    it('keeps a street ss.ge has no point for as none, and a later point replaces it', async () => {
      const sourceId = await newSource();
      await recordStreetPoint(db, {
        sourceId,
        ...shartava,
        point: { status: 'none' },
        readAt: NOW,
      });
      expect(await place(sourceId, 'street', 116)).toMatchObject({
        pointStatus: 'none',
        latitude: null,
      });

      await recordStreetPoint(db, {
        sourceId,
        ...shartava,
        streetName: null,
        point: { status: 'known', latitude: 41.7, longitude: 44.7 },
        readAt: LATER,
      });

      expect(await place(sourceId, 'street', 116)).toMatchObject({
        pointStatus: 'known',
        nameKa: 'შარტავას ქ.',
      });
    });

    it('adds no street it has no name for', async () => {
      const sourceId = await newSource();
      await recordStreetPoint(db, {
        sourceId,
        ...shartava,
        streetName: null,
        point: { status: 'none' },
        readAt: NOW,
      });
      expect(await place(sourceId, 'street', 116)).toBeUndefined();
    });
  });

  describe('loadListingsForPlacePoints', () => {
    it('picks one listing per street with no point, busiest first, an unread page first', async () => {
      const sourceId = await newSource();
      await listing(sourceId, { detailsReadAt: at(-1) });
      const unread = await listing(sourceId);
      const quiet = await listing(sourceId, { streetRef: 52, streetName: 'წყნეთის გზატკეცილი' });
      await listing(sourceId, { streetRef: 7, streetName: 'ცნობილი ქ.' });
      await listing(sourceId, { detailsReadAt: at(-1), cityRef: 70, streetRef: null });
      await syncPlaces(db, { sourceId, at: NOW });
      await recordStreetPoint(db, {
        sourceId,
        streetRef: 7,
        streetName: 'ცნობილი ქ.',
        subdistrictRef: 3,
        cityRef: 95,
        point: { status: 'known', latitude: 41.7, longitude: 44.7 },
        readAt: NOW,
      });

      const picked = await loadListingsForPlacePoints(db, { sourceId, asOf: NOW, limit: 10 });

      expect(picked.map((row) => row.id)).toEqual([unread, quiet]);
    });

    it('asks a "none" street again only after 60 days, and never in a city ss.ge never places', async () => {
      const sourceId = await newSource();
      await listing(sourceId, { detailsReadAt: at(-1) });
      await syncPlaces(db, { sourceId, at: NOW });
      await recordStreetPoint(db, {
        sourceId,
        streetRef: 116,
        streetName: 'შარტავას ქ.',
        subdistrictRef: 3,
        cityRef: 95,
        point: { status: 'none' },
        readAt: at(-61),
      });
      expect(await loadListingsForPlacePoints(db, { sourceId, asOf: NOW, limit: 10 })).toHaveLength(
        1,
      );

      // Twenty more streets of the same city, all "none".
      for (let ref = 200; ref < 220; ref++) {
        await listing(sourceId, { streetRef: ref, streetName: `ქ. ${ref}`, detailsReadAt: at(-1) });
        await recordStreetPoint(db, {
          sourceId,
          streetRef: ref,
          streetName: `ქ. ${ref}`,
          subdistrictRef: 3,
          cityRef: 95,
          point: { status: 'none' },
          readAt: at(-61),
        });
      }
      await syncPlaces(db, { sourceId, at: NOW });
      expect(await loadListingsForPlacePoints(db, { sourceId, asOf: NOW, limit: 50 })).toEqual([]);
    });

    it('picks one listing of a settlement none of whose pages has been read', async () => {
      const sourceId = await newSource();
      const village = {
        cityRef: 70,
        cityName: 'წავკისი',
        districtRef: null,
        districtName: null,
        subdistrictRef: null,
        subdistrictName: null,
        streetRef: null,
        streetName: null,
      };
      const newest = await listing(sourceId, { ...village, sourceUpdatedAt: at(-1) });
      await listing(sourceId, { ...village, sourceUpdatedAt: at(-3) });
      await listing(sourceId, { ...village, cityRef: 71, detailsReadAt: at(-1) });

      expect(
        (await loadListingsForPlacePoints(db, { sourceId, asOf: NOW, limit: 10 })).map(
          (row) => row.id,
        ),
      ).toEqual([newest]);
    });
  });

  describe('backfillStoredListings', () => {
    it('reads stored house numbers and fills the districts the source left out', async () => {
      const sourceId = await newSource();
      await listing(sourceId);
      const legacy = await listing(sourceId, {
        districtRef: null,
        districtName: null,
        streetNumber: '49-51',
      });
      const gone = await listing(sourceId, {
        districtRef: null,
        districtName: null,
        streetNumber: '7ა',
        status: 'gone',
      });
      await syncPlaces(db, { sourceId, at: NOW });

      const result = await backfillStoredListings(db, { sourceId });

      expect(result).toEqual({ houseNumbers: 2, districts: 2 });
      const rows = await db
        .select()
        .from(realEstateListings)
        .where(eq(realEstateListings.sourceId, sourceId));
      expect(rows.find((row) => row.id === legacy)).toMatchObject({
        houseNumber: 49,
        houseSuffix: null,
        districtRef: 3,
        districtName: 'ვაკე-საბურთალო',
        districtInferred: true,
      });
      expect(rows.find((row) => row.id === gone)).toMatchObject({
        houseNumber: 7,
        houseSuffix: 'ა',
        districtInferred: true,
      });
      // Run again, nothing is left to do.
      expect(await backfillStoredListings(db, { sourceId })).toEqual({
        houseNumbers: 0,
        districts: 0,
      });
    });
  });
});
