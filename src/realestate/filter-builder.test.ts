import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { db, pool } from '../db/client.js';
import {
  type NewRealEstateListingRow,
  realEstateListings,
  realEstatePlaces,
} from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import {
  type BuiltSql,
  FILTER_BUILDER_VERSION,
  parseRealEstateFilters,
  realEstateWhere,
  toPsycopg,
} from './filter-builder.js';
import { detailsCoverage, searchRealEstate } from './queries.js';

interface CaseFile {
  version: number;
  now: string;
  places: Omit<typeof realEstatePlaces.$inferInsert, 'sourceId' | 'firstSeenAt' | 'lastSeenAt'>[];
  listings: Record<string, Record<string, unknown>>;
  cases: {
    name: string;
    filters: Record<string, unknown>;
    expected: string[];
    ordered?: boolean;
    coverage?: { total: number; read: number };
    unknown?: string[];
  }[];
  placeColumn: { listing: string; place: Record<string, unknown> };
}

const CASES: CaseFile = JSON.parse(
  readFileSync(new URL('./filter-cases.json', import.meta.url), 'utf8'),
);
const NOW_MS = Date.parse(CASES.now);
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW_MS + days * DAY_MS).toISOString();
const NUMERIC = new Set([
  'areaM2',
  'priceUsd',
  'priceGel',
  'pricePerM2Usd',
  'pricePerM2Gel',
  'kitchenArea',
  'houseArea',
  'yardArea',
]);

/** A case file listing as a row: numbers of days for times, numbers for numeric columns. */
function fixtureRow(fields: Record<string, unknown>): Partial<NewRealEstateListingRow> {
  const row: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (name.endsWith('At') && typeof value === 'number') row[name] = at(value);
    else if (NUMERIC.has(name) && typeof value === 'number') row[name] = String(value);
    else row[name] = value;
  }
  return row as Partial<NewRealEstateListingRow>;
}

describe('the filter builder (contract C1)', () => {
  let sourceId = '';
  const keyOf = new Map<string, string>();

  beforeAll(async () => {
    sourceId = await createTestSource();
    await db.insert(realEstatePlaces).values(
      CASES.places.map((place) => ({
        ...place,
        sourceId,
        firstSeenAt: at(-1),
        lastSeenAt: at(0),
      })),
    );
    for (const [key, fields] of Object.entries(CASES.listings)) {
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
          ...fixtureRow(fields),
        })
        .returning({ id: realEstateListings.id });
      if (row === undefined) throw new Error(`fixture ${key} was not inserted`);
      keyOf.set(row.id, key);
    }
  });

  afterAll(async () => {
    if (sourceId !== '') await cleanupTestSource(sourceId);
  });

  const keys = (ids: string[]) => ids.map((id) => keyOf.get(id) ?? `unknown ${id}`);
  const run = async (built: BuiltSql, tail = '') =>
    keys(
      (
        await pool.query<{ id: string }>(
          `select id from realestate.public_listings where ${built.sql}${tail}`,
          built.params,
        )
      ).rows.map((row) => row.id),
    );

  it('is the version its case file was written for', () => {
    expect(CASES.version).toBe(FILTER_BUILDER_VERSION);
    expect(realEstateWhere({}, CASES.now).version).toBe(FILTER_BUILDER_VERSION);
  });

  describe.each(CASES.cases)('$name', (testCase) => {
    const filters = () => ({ sourceId, ...testCase.filters });
    const inOrder = (found: string[]) => (testCase.ordered === true ? found : found.sort());
    const expected = inOrder([...testCase.expected]);

    it('returns the listings the case expects, through the SQL handed on', async () => {
      const built = realEstateWhere(filters(), CASES.now);
      expect(inOrder(await run(built.where, ` order by ${built.orderBy}`))).toEqual(expected);
    });

    it('returns the same through the Real estate tab’s own query', async () => {
      const rows = await searchRealEstate(
        db,
        { ...parseRealEstateFilters(filters()), limit: 500 },
        CASES.now,
      );
      expect(inOrder(keys(rows.map((row) => row.id)))).toEqual(expected);
    });

    it('counts the listings a listing-page filter could judge, as the tab does', async () => {
      const { coverage } = realEstateWhere(filters(), CASES.now);
      if (testCase.coverage === undefined) {
        expect(coverage).toBeNull();
        return;
      }
      if (coverage === null) throw new Error('expected a coverage condition');
      const total = (await run(coverage)).length;
      const read = (await run(coverage, ' and details_read_at is not null')).length;
      expect({ total, read }).toEqual(testCase.coverage);
      expect(await detailsCoverage(db, parseRealEstateFilters(filters()), CASES.now)).toEqual(
        testCase.coverage,
      );
    });

    it('lists the listings the location filters might hold though their location does not say', async () => {
      const { locationCoverage } = realEstateWhere(filters(), CASES.now);
      if (testCase.unknown === undefined) {
        expect(locationCoverage).toBeNull();
        return;
      }
      if (locationCoverage === null) throw new Error('expected a location coverage condition');
      expect((await run(locationCoverage)).sort()).toEqual([...testCase.unknown].sort());
    });

    it('writes the same SQL with psycopg’s placeholders', () => {
      const postgres = realEstateWhere(filters(), CASES.now);
      const psycopg = realEstateWhere(filters(), CASES.now, { placeholders: 'psycopg' });
      expect(psycopg.where.params).toEqual(postgres.where.params);
      expect(psycopg.where.sql).toBe(postgres.where.sql.replace(/\$\d+/g, '%s'));
      expect(psycopg.where.sql.split('%s').length - 1).toBe(psycopg.where.params.length);
      expect(psycopg.locationCoverage?.params).toEqual(postgres.locationCoverage?.params);
      expect(psycopg.locationCoverage?.sql).toBe(
        postgres.locationCoverage?.sql.replace(/\$\d+/g, '%s'),
      );
    });
  });

  it('names a listing’s place on both maps in the column it hands on', async () => {
    const { where, placeColumn } = realEstateWhere({ sourceId }, CASES.now);
    const id = [...keyOf].find(([, key]) => key === CASES.placeColumn.listing)?.[0];
    const { rows } = await pool.query<{ place: unknown }>(
      `select ${placeColumn} from realestate.public_listings where ${where.sql} and id = $${where.params.length + 1}`,
      [...where.params, id],
    );
    expect(rows).toEqual([{ place: CASES.placeColumn.place }]);
  });

  it('says which places it matched as the ss.ge place holding them', () => {
    const places = [
      { level: 'neighbourhood', ref: 990031 },
      { level: 'subdistrict', ref: 990021 },
    ];
    expect(realEstateWhere({ places }, CASES.now).widenedPlaces).toEqual([places[0]]);
  });

  it('marks the typo prices with the expression it hands on', async () => {
    const { implausible } = realEstateWhere({}, CASES.now);
    const typos = await run({
      sql: `source_id = $1 and ${implausible}`,
      params: [sourceId],
    });
    expect(typos.sort()).toEqual(['g2-typo', 'typo-sale']);
  });

  it('doubles a literal % for psycopg and refuses parameters out of order', () => {
    expect(toPsycopg({ sql: "a like '%x' and b = $1 and c = $2", params: ['b', 3] })).toEqual({
      sql: "a like '%%x' and b = %s and c = %s",
      params: ['b', 3],
    });
    expect(() => toPsycopg({ sql: 'a = $2 and b = $1', params: [1, 2] })).toThrow(/in order/);
    expect(() => toPsycopg({ sql: 'a = $1 and b = $1', params: [1] })).toThrow(/in order/);
  });

  describe('refuses input it cannot take, never ignoring it', () => {
    it.each([
      ['a misspelled filter', { rooms: 3 }, 'rooms'],
      ['limit, which the reader adds itself', { limit: 10 }, 'limit'],
      ['a count as text', { roomsIn: '3' }, 'roomsIn'],
      ['a deal ss.ge does not have', { dealType: 'buy' }, 'dealType'],
      ['a condition by its Georgian label', { conditions: ['გარემონტებული'] }, 'conditions'],
      ['a place level that is not one', { places: [{ level: 'country', ref: 1 }] }, 'places'],
      ['a metro band ss.ge does not have', { metro: { maxMinutes: 12 } }, 'maxMinutes'],
      ['a station by its name, not its code', { metro: { stations: ['Rustaveli'] } }, 'stations'],
      ['a metro key that is not one', { metro: { station: 'rustaveli' } }, 'metro'],
      ['a precision that is not one', { minPrecision: 'exact' }, 'minPrecision'],
      ['a date without a zone', { updatedSince: '2026-11-01' }, 'updatedSince'],
      ['a price that is not a number', { priceMin: Number.NaN }, 'priceMin'],
    ])('%s', (_label, input, key) => {
      const error = (() => {
        try {
          parseRealEstateFilters(input);
        } catch (thrown) {
          return thrown;
        }
        return null;
      })();
      expect(error).toBeInstanceOf(ZodError);
      expect(JSON.stringify((error as ZodError).issues)).toContain(key);
    });

    it('a time of asking that is not an instant', () => {
      expect(() => realEstateWhere({}, 'yesterday')).toThrow(ZodError);
      expect(() => realEstateWhere({}, '2026-11-06')).toThrow(ZodError);
    });

    it('nothing at all, or an array', () => {
      expect(() => parseRealEstateFilters(null)).toThrow(ZodError);
      expect(() => parseRealEstateFilters([])).toThrow(ZodError);
    });
  });
});
