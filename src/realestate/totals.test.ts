import { inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  type NewRealEstateListingRow,
  realEstateDailyTotals,
  realEstateListings,
} from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import {
  takeDailyTotals,
  TOTALS_MIN_LISTINGS,
  TOTALS_RULES_VERSION,
  tbilisiDay,
} from './totals.js';

const NOW = '2026-11-06T13:30:00.000Z';
const DAY = '2026-11-06';
const NEXT_NOW = '2026-11-07T13:30:00.000Z';
const NEXT_DAY = '2026-11-07';
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(Date.parse(NOW) + days * DAY_MS).toISOString();

describe('daily totals (contract C3)', () => {
  const sourceIds: string[] = [];
  let nextKey = 1;

  async function newSource(): Promise<string> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    return sourceId;
  }

  /** A two-room flat for sale in Saburtalo, on show at `NOW`, unless told otherwise. */
  async function listing(sourceId: string, overrides: Partial<NewRealEstateListingRow> = {}) {
    const key = `t${nextKey++}`;
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
        pricePerM2Gel: '4500.00',
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

  /**
   * Saburtalo: six two-room flats, two of them one group (the newer leads),
   * one with its page read, one with no room count, one typo price, one past
   * its end. Vake: four three-room flats, a cell too small to keep.
   */
  async function market(sourceId: string) {
    const prices = [100_000, 110_000, 120_000, 130_000, 140_000, 150_000];
    const ids: string[] = [];
    for (const [i, price] of prices.entries()) {
      ids.push(
        await listing(sourceId, {
          priceUsd: String(price),
          priceGel: String(price * 2.7),
          pricePerM2Usd: String(1000 + i * 100),
          pricePerM2Gel: String(2700 + i * 270),
          areaM2: String(50 + i * 2),
          ...(i === 0 ? { detailsReadAt: at(-1) } : {}),
          ...(i === 4 ? { groupKey: 'g1', sourceUpdatedAt: at(-1) } : {}),
          ...(i === 5 ? { groupKey: 'g1', sourceUpdatedAt: at(-3) } : {}),
        }),
      );
    }
    await listing(sourceId, { rooms: null, priceUsd: '90000' });
    await listing(sourceId, { priceUsd: '462', pricePerM2Usd: '7.70' });
    await listing(sourceId, { expectedEndAt: at(-5), lastSeenAt: at(-5) });
    for (const price of [200_000, 210_000, 220_000, 230_000]) {
      await listing(sourceId, {
        rooms: 3,
        priceUsd: String(price),
        subdistrictRef: 1,
        subdistrictName: 'ვაკე',
      });
    }
    return ids;
  }

  const cellsOf = async (day: string) =>
    (await db.select().from(realEstateDailyTotals)).filter((row) => row.day === day);
  const cell = (rows: Awaited<ReturnType<typeof cellsOf>>, level: string, band: string) =>
    rows.find((row) => row.areaLevel === level && row.roomsBand === band);

  afterEach(async () => {
    await db
      .delete(realEstateDailyTotals)
      .where(inArray(realEstateDailyTotals.day, [DAY, NEXT_DAY]));
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  it('keeps every area level and room band with five or more listings, and no smaller cell', async () => {
    const sourceId = await newSource();
    await market(sourceId);
    const result = await takeDailyTotals(db, { sourceId, now: NOW, crawlRunId: null });
    const rows = await cellsOf(DAY);
    const kept = rows
      .map(
        (row) =>
          `${row.areaLevel}:${row.areaRef}:${row.dealType}:${row.propertyType}:${row.roomsBand}`,
      )
      .sort();
    expect(kept).toEqual([
      'all:0:sale:flat:2',
      'all:0:sale:flat:all',
      'city:95:sale:flat:2',
      'city:95:sale:flat:all',
      'district:3:sale:flat:2',
      'district:3:sale:flat:all',
      'subdistrict:3:sale:flat:2',
      'subdistrict:3:sale:flat:all',
    ]);
    expect(result).toEqual({ day: DAY, cells: 8 });
    expect(rows.every((row) => row.listings >= TOTALS_MIN_LISTINGS)).toBe(true);
  });

  it('counts listings on show, reposts merged and typo prices out, with their prices', async () => {
    const sourceId = await newSource();
    await market(sourceId);
    await takeDailyTotals(db, { sourceId, now: NOW, crawlRunId: null });
    const rows = await cellsOf(DAY);

    const saburtalo = rows.find(
      (row) => row.areaLevel === 'subdistrict' && row.areaRef === 3 && row.roomsBand === '2',
    );
    expect(saburtalo).toMatchObject({
      areaName: 'საბურთალო',
      listings: 5,
      posts: 6,
      withDetails: 1,
      priceUsdP25: '110000.00',
      priceUsdMedian: '120000.00',
      priceUsdP75: '130000.00',
      pricePerM2UsdMedian: '1200.00',
      priceGelMedian: '324000.00',
      pricePerM2GelMedian: '3240.00',
      areaM2Median: '54.00',
    });
    // Every place at once, and the Vake flats in the district.
    expect(cell(rows, 'all', 'all')).toMatchObject({
      areaRef: 0,
      areaName: null,
      listings: 10,
      posts: 11,
    });
    expect(
      rows.find((row) => row.areaLevel === 'district' && row.roomsBand === 'all'),
    ).toMatchObject({ areaName: 'ვაკე-საბურთალო', listings: 10, posts: 11 });
  });

  it('puts a listing with no room count in its kind’s "all" band only', async () => {
    const sourceId = await newSource();
    await market(sourceId);
    await takeDailyTotals(db, { sourceId, now: NOW, crawlRunId: null });
    const rows = await cellsOf(DAY);
    const saburtalo = (band: string) =>
      rows.find(
        (row) => row.areaLevel === 'subdistrict' && row.areaRef === 3 && row.roomsBand === band,
      );
    expect(saburtalo('all')).toMatchObject({ listings: 6, posts: 7 });
    expect(saburtalo('2')).toMatchObject({ listings: 5, posts: 6 });
  });

  it('counts one source only', async () => {
    const sourceId = await newSource();
    await market(sourceId);
    const other = await newSource();
    for (let i = 0; i < 6; i++) await listing(other, { subdistrictRef: 1 });
    await takeDailyTotals(db, { sourceId, now: NOW, crawlRunId: null });
    expect(cell(await cellsOf(DAY), 'all', 'all')).toMatchObject({ listings: 10, posts: 11 });
  });

  it('records when, after which run and by which rules', async () => {
    const sourceId = await newSource();
    await market(sourceId);
    const crawlRunId = '6f7d3c1e-0000-4000-8000-000000000001';
    await takeDailyTotals(db, { sourceId, now: NOW, crawlRunId });
    for (const row of await cellsOf(DAY)) {
      expect(row).toMatchObject({ crawlRunId, rulesVersion: TOTALS_RULES_VERSION });
      expect(Date.parse(row.takenAt)).toBe(Date.parse(NOW));
    }
  });

  it('replaces a day taken twice, leaving no cell of the first, and keeps other days', async () => {
    const sourceId = await newSource();
    const saburtaloTwoRooms = await market(sourceId);
    await takeDailyTotals(db, { sourceId, now: NEXT_NOW, crawlRunId: null });
    await takeDailyTotals(db, { sourceId, now: NOW, crawlRunId: null });
    expect(await cellsOf(DAY)).toHaveLength(8);

    // Two Saburtalo flats leave: its two-room cell falls below five.
    await db
      .delete(realEstateListings)
      .where(inArray(realEstateListings.id, saburtaloTwoRooms.slice(0, 2)));
    const again = await takeDailyTotals(db, { sourceId, now: NOW, crawlRunId: null });
    const rows = await cellsOf(DAY);
    expect(again.cells).toBe(rows.length);
    expect(rows.some((row) => row.roomsBand === '2')).toBe(false);
    expect(cell(rows, 'all', 'all')).toMatchObject({ listings: 8, posts: 9 });
    expect(await cellsOf(NEXT_DAY)).toHaveLength(8);
  });

  it('takes prices per m² only from listings whose area is known', async () => {
    const sourceId = await newSource();
    for (const [i, price] of [100_000, 110_000, 120_000, 130_000, 140_000].entries()) {
      await listing(sourceId, { priceUsd: String(price), pricePerM2Usd: String(1000 + i * 100) });
    }
    // With no area, ss.ge's price per m² is the whole price.
    await listing(sourceId, { priceUsd: '100000', areaM2: null, pricePerM2Usd: '100000' });
    await takeDailyTotals(db, { sourceId, now: NOW, crawlRunId: null });
    expect(cell(await cellsOf(DAY), 'all', 'all')).toMatchObject({
      listings: 6,
      priceUsdMedian: '115000.00',
      pricePerM2UsdMedian: '1200.00',
    });
  });

  it('dates the totals by the calendar in Tbilisi', () => {
    expect(tbilisiDay('2026-11-06T19:59:59.000Z')).toBe('2026-11-06');
    expect(tbilisiDay('2026-11-06T20:00:00.000Z')).toBe('2026-11-07');
    expect(tbilisiDay('2026-11-06T23:30:00+04:00')).toBe('2026-11-06');
  });
});
