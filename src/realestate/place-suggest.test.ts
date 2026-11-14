import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  type NewRealEstateListingRow,
  realEstateListings,
  realEstatePlaces,
} from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import type { RealEstateFilters } from './filters.js';
import {
  type PlaceSuggestions,
  placeLabels,
  stationLabels,
  suggestPlaces,
} from './place-suggest.js';
import { matchKeys } from './places/catalogue.js';

const NOW = Date.parse('2026-10-12T22:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (daysFromNow: number) => new Date(NOW + daysFromNow * DAY_MS).toISOString();
const NOW_ISO = at(0);

// Invented names, so no real place nor another test's meets the words typed here.
const AREA = { ref: 7701, ka: 'ზუბროვკა', en: 'Zubrovka' };
const CITY = { ref: 7702, ka: 'ზუბროვკაგრადი', en: 'Zubrovkagrad' };
const STATION = { ref: 7703, code: 'zubr-st', ka: 'ზუბროვსკაია', en: 'Zubrovskaya' };
const STREET = { ref: 7704, ka: 'ზუბროვკას ქ.', en: null };

describe('place suggestions (Phase 16B)', () => {
  const sourceIds: string[] = [];
  let nextKey = 1;

  async function newSource(): Promise<string> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    return sourceId;
  }

  async function place(
    sourceId: string,
    level: 'city' | 'district' | 'subdistrict' | 'street' | 'metro_station' | 'neighbourhood',
    ref: number,
    names: { ka: string; en?: string | null },
    extra: Partial<typeof realEstatePlaces.$inferInsert> = {},
  ) {
    await db.insert(realEstatePlaces).values({
      sourceId,
      level,
      ref,
      nameKa: names.ka,
      nameEn: names.en ?? null,
      matchKeys: matchKeys(level, [names.ka, ...(names.en ? [names.en] : [])]),
      activeListings: 1_000_000,
      firstSeenAt: at(-1),
      lastSeenAt: at(0),
      ...extra,
    });
  }

  async function listing(sourceId: string, overrides: Partial<NewRealEstateListingRow> = {}) {
    const key = String(nextKey++);
    await db.insert(realEstateListings).values({
      sourceId,
      sourceListingKey: key,
      canonicalUrl: `https://example.invalid/suggest/${key}`,
      dealType: 'sale',
      propertyType: 'flat',
      rooms: 2,
      areaM2: '60.00',
      priceUsd: '100000.00',
      priceGel: '270000.00',
      pricePerM2Usd: '1666.00',
      sourceUpdatedAt: at(-1),
      expectedEndAt: at(29),
      firstSeenAt: at(-1),
      lastSeenAt: at(-0.1),
      contentHash: 'h',
      ...overrides,
    });
  }

  /** Places of one made-up name at every level, and listings under some of them. */
  async function setup() {
    const sourceId = await newSource();
    await place(sourceId, 'city', CITY.ref, CITY);
    await place(sourceId, 'subdistrict', AREA.ref, AREA, {
      parentLevel: 'city',
      parentRef: CITY.ref,
    });
    await place(sourceId, 'metro_station', STATION.ref, STATION, { code: STATION.code });
    await place(sourceId, 'street', STREET.ref, STREET, {
      parentLevel: 'subdistrict',
      parentRef: AREA.ref,
    });
    for (let i = 0; i < 3; i++)
      await listing(sourceId, { subdistrictRef: AREA.ref, streetRef: STREET.ref });
    await listing(sourceId, { subdistrictRef: AREA.ref, dealType: 'rent' });
    await listing(sourceId, {
      cityRef: CITY.ref,
      metroNearby: [STATION.code],
      metroNearbyMinutes: [10],
      metroMinutes: 10,
    });
    return sourceId;
  }

  const suggest = (sourceId: string, text: string, filters: Partial<RealEstateFilters> = {}) =>
    suggestPlaces(db, text, { sourceId, ...filters }, NOW_ISO);

  const groupOf = (found: PlaceSuggestions, group: string) =>
    found.groups.find((entry) => entry.group === group)?.places ?? [];

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  it('finds a place by the start of its Georgian, English or romanised name, in groups', async () => {
    const sourceId = await setup();
    for (const text of ['zubr', 'Zubrov', 'ზუბრ', 'ZUBR']) {
      const found = await suggest(sourceId, text);
      expect(
        groupOf(found, 'area').map((p) => p.ref),
        text,
      ).toEqual([AREA.ref]);
      expect(
        groupOf(found, 'street').map((p) => p.ref),
        text,
      ).toEqual([STREET.ref]);
      expect(
        groupOf(found, 'metro').map((p) => p.code),
        text,
      ).toEqual([STATION.code]);
      expect(found.groups.map((entry) => entry.group)).toEqual(['area', 'city', 'metro', 'street']);
    }
    // "Zubrovkagrad" is a city, found from "zubrovkag" and not an area.
    const city = await suggest(sourceId, 'zubrovkag');
    expect(groupOf(city, 'city').map((p) => p.ref)).toEqual([CITY.ref]);
    expect(groupOf(city, 'area')).toEqual([]);
  });

  it('finds a place by the start of a later word of its name', async () => {
    const sourceId = await newSource();
    await place(sourceId, 'subdistrict', 7710, { ka: 'ძველი ზუბროვკა', en: 'Old Zubrovka' });
    const found = await suggest(sourceId, 'zubrov');
    expect(groupOf(found, 'area').map((p) => p.ref)).toEqual([7710]);
  });

  it('says where a street or a sub-district is, by its parent', async () => {
    const sourceId = await setup();
    const found = await suggest(sourceId, 'zubr');
    expect(groupOf(found, 'street')[0]?.parentKa).toBe(AREA.ka);
    expect(groupOf(found, 'area')[0]?.parentKa).toBe(CITY.ka);
    expect(groupOf(found, 'city')[0]?.parentKa).toBeNull();
    expect(groupOf(found, 'street')[0]).toMatchObject({
      level: 'street',
      nameKa: STREET.ka,
      nameEn: null,
    });
  });

  it('leaves out a place with nothing on show, and answers an empty list to words that name a kind of place', async () => {
    const sourceId = await newSource();
    await place(
      sourceId,
      'subdistrict',
      7711,
      { ka: 'ზუბრუგა', en: 'Zubruga' },
      { activeListings: 0 },
    );
    expect((await suggest(sourceId, 'zubruga')).groups).toEqual([]);
    expect((await suggest(sourceId, 'street')).groups).toEqual([]);
    expect((await suggest(sourceId, 'zzzzqqqq')).groups).toEqual([]);
  });

  it('gives at most six of a group and eight streets, busiest first', async () => {
    const sourceId = await newSource();
    for (let i = 0; i < 9; i++) {
      await place(
        sourceId,
        'subdistrict',
        7720 + i,
        { ka: `ზუბროლი ${i}`, en: `Zubrol ${i}` },
        { activeListings: 1_000_000 - i },
      );
      await place(
        sourceId,
        'street',
        7740 + i,
        { ka: `ზუბროლის ${i} ქ.`, en: null },
        { activeListings: 1_000_000 - i },
      );
    }
    const found = await suggest(sourceId, 'zubrol');
    expect(groupOf(found, 'area').map((p) => p.ref)).toEqual([7720, 7721, 7722, 7723, 7724, 7725]);
    expect(groupOf(found, 'street')).toHaveLength(8);
  });

  describe('counts', () => {
    it('are what picking the place would show, under the other filters and not the places', async () => {
      const sourceId = await setup();
      const all = await suggest(sourceId, 'zubr');
      expect(groupOf(all, 'area')[0]?.count).toBe(4);
      expect(groupOf(all, 'street')[0]?.count).toBe(3);
      expect(groupOf(all, 'city')[0]?.count).toBe(1);
      // A station, within the metro band's default 15 minutes.
      expect(groupOf(all, 'metro')[0]?.count).toBe(1);

      const sale = await suggest(sourceId, 'zubr', { dealType: 'sale' });
      expect(groupOf(sale, 'area')[0]?.count).toBe(3);

      // A place already chosen does not narrow the other suggestions.
      const chosen = await suggest(sourceId, 'zubr', {
        places: [{ level: 'city', ref: CITY.ref }],
      });
      expect(groupOf(chosen, 'area')[0]?.count).toBe(4);
    });

    it('count a station by its band and keep a metro filter on an area', async () => {
      const sourceId = await setup();
      await listing(sourceId, {
        subdistrictRef: AREA.ref,
        metroNearby: [STATION.code],
        metroNearbyMinutes: [10],
        metroMinutes: 10,
      });
      const near = await suggest(sourceId, 'zubr', { metro: { maxMinutes: 5 } });
      expect(groupOf(near, 'metro')[0]?.count).toBe(0);
      expect(groupOf(near, 'area')[0]?.count).toBe(0);
      const wider = await suggest(sourceId, 'zubr', { metro: { maxMinutes: 10 } });
      expect(groupOf(wider, 'metro')[0]?.count).toBe(2);
      expect(groupOf(wider, 'area')[0]?.count).toBe(1);
    });

    it('count properties, not listings, when the tab folds look-alikes', async () => {
      const sourceId = await setup();
      for (let i = 0; i < 3; i++)
        await listing(sourceId, { subdistrictRef: AREA.ref, groupKey: 'zg' });
      expect(groupOf(await suggest(sourceId, 'zubr'), 'area')[0]?.count).toBe(7);
      expect(groupOf(await suggest(sourceId, 'zubr', { grouped: true }), 'area')[0]?.count).toBe(5);
    });
  });

  it('gives the popular places for an empty box: the busiest areas, two cities, two stations', async () => {
    const sourceId = await setup();
    const found = await suggest(sourceId, '');
    expect(found.groups.map((entry) => entry.group)).toEqual(['area', 'city', 'metro']);
    expect(groupOf(found, 'area').length).toBeLessThanOrEqual(8);
    expect(groupOf(found, 'city').length).toBeLessThanOrEqual(2);
    expect(groupOf(found, 'metro').length).toBeLessThanOrEqual(2);
    // Ours have a million places on show: the busiest.
    expect(groupOf(found, 'area').map((p) => p.ref)).toContain(AREA.ref);
    expect(groupOf(found, 'metro').map((p) => p.code)).toContain(STATION.code);
  });

  describe('labels', () => {
    it('names the places a filter holds, in the order asked, leaving out those C6 does not know', async () => {
      const sourceId = await setup();
      const labels = await placeLabels(db, [
        { level: 'street', ref: STREET.ref },
        { level: 'city', ref: 999_999 },
        { level: 'subdistrict', ref: AREA.ref },
        { level: 'metro_station', ref: STATION.ref },
      ]);
      expect(labels).toEqual([
        { level: 'street', ref: STREET.ref, code: null, nameKa: STREET.ka, nameEn: null },
        { level: 'subdistrict', ref: AREA.ref, code: null, nameKa: AREA.ka, nameEn: AREA.en },
        {
          level: 'metro_station',
          ref: STATION.ref,
          code: STATION.code,
          nameKa: STATION.ka,
          nameEn: STATION.en,
        },
      ]);
      expect(await placeLabels(db, [])).toEqual([]);
      expect(sourceId).not.toBe('');
    });

    it('lists the metro stations with their codes', async () => {
      await setup();
      const stations = await stationLabels(db);
      expect(stations.every((station) => station.level === 'metro_station')).toBe(true);
      expect(stations.find((station) => station.code === STATION.code)).toMatchObject({
        nameKa: STATION.ka,
        nameEn: STATION.en,
      });
    });
  });
});
