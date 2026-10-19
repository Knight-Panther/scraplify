import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  type NewRealEstateListingRow,
  realEstateListingGroups,
  realEstateListings,
} from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import { type GroupingRow, groupLookAlikes, regroupListings, streetKey } from './grouping.js';

describe('streetKey', () => {
  it('reads one street however its name is written', () => {
    const forms = ['იყალთოს ქ.', 'იყალთოს ქუჩა', 'იყალთოს ქ', ' იყალთოს  ქ., ', 'იყალთოს ქ'];
    expect(new Set(forms.map(streetKey))).toEqual(new Set(['იყალთოს']));
  });

  it('drops initials and a former name in brackets', () => {
    expect(streetKey('ს.ცინცაძის ქ.')).toBe(streetKey('ცინცაძის ქ.'));
    expect(streetKey('ალ. იოსელიანის ქ.')).toBe(streetKey('იოსელიანის ქ.'));
    expect(streetKey('პოლიტკოვსკაიას ქ. (ჯიქიას ქ.)')).toBe(streetKey('პოლიტკოვსკაიას ქ.'));
  });

  it('keeps an avenue, a lane off it and a numbered side street apart', () => {
    const keys = [
      'ვაჟა-ფშაველას გამზ.',
      'ვაჟა ფშაველას I ჩიხი,',
      'ვაჟა ფშაველას II ჩიხი',
      'ვაჟა-ფშაველას შესახვევი',
    ].map(streetKey);
    expect(new Set(keys).size).toBe(4);
  });

  it('treats a hyphen and a space in a name alike', () => {
    expect(streetKey('ვაჟა-ფშაველას გამზ.')).toBe(streetKey('ვაჟა ფშაველას გამზირი'));
  });

  it('has no key for a missing, blank or punctuation-only street', () => {
    for (const name of [null, '', '  ', '.', ', -', 'ქ.']) expect(streetKey(name)).toBeNull();
  });
});

function row(overrides: Partial<GroupingRow> = {}): GroupingRow {
  return {
    id: 'a',
    dealType: 'sale',
    propertyType: 'flat',
    cityRef: 95,
    subdistrictRef: 3,
    streetName: 'უნივერსიტეტის ქ.',
    rooms: 3,
    floor: 5,
    totalFloors: 12,
    areaM2: 80,
    priceUsd: 150_000,
    groupKey: null,
    ...overrides,
  };
}

/** The groups as sets of ids, in a stable order, for comparing. */
function asSets(groups: string[][]): string[][] {
  return groups
    .map((ids) => [...ids].sort())
    .sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
}

describe('groupLookAlikes', () => {
  it('groups the same flat posted three times, within the area and price margins', () => {
    const groups = groupLookAlikes([
      row({ id: 'a', areaM2: 80, priceUsd: 150_000 }),
      row({ id: 'b', areaM2: 80.5, priceUsd: 149_000, streetName: 'უნივერსიტეტის ქუჩა' }),
      row({ id: 'c', areaM2: 80, priceUsd: 146_000 }),
    ]);
    expect(asSets(groups)).toEqual([['a', 'b', 'c']]);
  });

  it('keeps apart flats that differ in any field the rule compares', () => {
    const base = row({ id: 'base' });
    const differing: GroupingRow[] = [
      row({ id: 'deal', dealType: 'rent' }),
      row({ id: 'kind', propertyType: 'house' }),
      row({ id: 'city', cityRef: 96 }),
      row({ id: 'area-ref', subdistrictRef: 4 }),
      row({ id: 'street', streetName: 'პეკინის ქ.' }),
      row({ id: 'rooms', rooms: 2 }),
      row({ id: 'floor', floor: 6 }),
      row({ id: 'height', totalFloors: 11 }),
      row({ id: 'bigger', areaM2: 80.7 }),
      row({ id: 'dearer', priceUsd: 154_600 }),
    ];
    for (const other of differing) {
      expect(groupLookAlikes([base, other]), other.id).toEqual([]);
    }
  });

  it('measures the margins from the first member, so a run of small steps does not chain', () => {
    // Each 2.5% above the last: b is within 3% of a, c is within 3% of b but not of a.
    const groups = groupLookAlikes([
      row({ id: 'a', priceUsd: 100_000 }),
      row({ id: 'b', priceUsd: 102_500 }),
      row({ id: 'c', priceUsd: 105_100 }),
      row({ id: 'd', priceUsd: 107_700 }),
    ]);
    expect(asSets(groups)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('leaves out a listing missing a field the rule needs', () => {
    for (const missing of [
      { streetName: null },
      { streetName: '.' },
      { rooms: null },
      { areaM2: null },
      { priceUsd: null },
      { floor: null },
      { totalFloors: null },
      { cityRef: null },
      { subdistrictRef: null },
    ] satisfies Partial<GroupingRow>[]) {
      const groups = groupLookAlikes([row({ id: 'a' }), row({ id: 'b', ...missing })]);
      expect(groups, JSON.stringify(missing)).toEqual([]);
    }
  });

  it('never groups two flats that both lack a floor', () => {
    expect(groupLookAlikes([row({ id: 'a', floor: null }), row({ id: 'b', floor: null })])).toEqual(
      [],
    );
  });

  it('groups houses without a floor, on the rest of the rule', () => {
    const house = { propertyType: 'house' as const, floor: null, totalFloors: 2 };
    const groups = groupLookAlikes([
      row({ id: 'a', ...house, areaM2: 220 }),
      row({ id: 'b', ...house, areaM2: 220.4 }),
      row({ id: 'c', ...house, areaM2: 220, totalFloors: null }),
    ]);
    expect(asSets(groups)).toEqual([['a', 'b']]);
  });

  it('gives the same groups whatever order the rows come in', () => {
    const rows = [
      row({ id: 'a', priceUsd: 100_000 }),
      row({ id: 'b', priceUsd: 102_500 }),
      row({ id: 'c', priceUsd: 105_100 }),
      row({ id: 'd', priceUsd: 107_700, areaM2: 80.3 }),
      row({ id: 'e', priceUsd: 101_000, areaM2: 79.6 }),
    ];
    const expected = asSets(groupLookAlikes(rows));
    expect(asSets(groupLookAlikes([...rows].reverse()))).toEqual(expected);
    expect(
      asSets(groupLookAlikes([rows[2], rows[0], rows[4], rows[1], rows[3]] as GroupingRow[])),
    ).toEqual(expected);
  });
});

describe('regroupListings', () => {
  const sourceIds: string[] = [];
  let nextKey = 1;

  afterEach(async () => {
    for (const id of sourceIds.splice(0)) await cleanupTestSource(id);
  });

  async function newSource(): Promise<string> {
    const id = await createTestSource();
    sourceIds.push(id);
    return id;
  }

  async function listing(
    sourceId: string,
    overrides: Partial<NewRealEstateListingRow> = {},
  ): Promise<string> {
    const key = String(nextKey++);
    const [inserted] = await db
      .insert(realEstateListings)
      .values({
        sourceId,
        sourceListingKey: `g${key}`,
        canonicalUrl: `https://example.invalid/g${key}`,
        dealType: 'sale',
        propertyType: 'flat',
        rooms: 3,
        areaM2: '80.00',
        floor: 5,
        totalFloors: 12,
        priceUsd: '150000.00',
        cityRef: 95,
        subdistrictRef: 3,
        streetName: 'უნივერსიტეტის ქ.',
        sourceUpdatedAt: '2026-10-18T10:00:00.000Z',
        firstSeenAt: '2026-10-18T10:00:00.000Z',
        lastSeenAt: '2026-10-18T10:00:00.000Z',
        contentHash: 'h',
        ...overrides,
      })
      .returning({ id: realEstateListings.id });
    if (inserted === undefined) throw new Error('listing was not inserted');
    return inserted.id;
  }

  const keysOf = async (ids: string[]) => {
    const rows = await db
      .select({ id: realEstateListings.id, groupKey: realEstateListings.groupKey })
      .from(realEstateListings)
      .where(inArray(realEstateListings.id, ids));
    return new Map(rows.map((r) => [r.id, r.groupKey]));
  };

  const groupRow = (key: string) =>
    db.select().from(realEstateListingGroups).where(eq(realEstateListingGroups.groupKey, key));

  it('keys each group, records it, and leaves a listing with no look-alike ungrouped', async () => {
    const sourceId = await newSource();
    const a = await listing(sourceId);
    const b = await listing(sourceId, { priceUsd: '152000.00' });
    const alone = await listing(sourceId, { rooms: 2 });

    const result = await regroupListings(db, { sourceId, now: '2026-10-19T00:00:00.000Z' });
    expect(result).toMatchObject({ groups: 1, groupedListings: 2 });

    const keys = await keysOf([a, b, alone]);
    expect(keys.get(a)).not.toBeNull();
    expect(keys.get(b)).toBe(keys.get(a));
    expect(keys.get(alone)).toBeNull();
    const [group] = await groupRow(keys.get(a) as string);
    expect(group).toMatchObject({ memberCount: 2 });
    expect(new Date(group?.formedAt ?? '').toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('keeps a group’s key through a change of members, and drops a group left with one', async () => {
    const sourceId = await newSource();
    const a = await listing(sourceId);
    const b = await listing(sourceId, { priceUsd: '151000.00' });
    await regroupListings(db, { sourceId, now: '2026-10-19T00:00:00.000Z' });
    const key = (await keysOf([a])).get(a) as string;

    // A third copy is posted, and the first is taken down.
    const c = await listing(sourceId, { priceUsd: '149000.00' });
    await db
      .update(realEstateListings)
      .set({ status: 'gone', goneAt: '2026-10-19T12:00:00.000Z', goneReason: 'expired' })
      .where(eq(realEstateListings.id, a));
    await regroupListings(db, { sourceId, now: '2026-10-20T00:00:00.000Z' });

    const keys = await keysOf([a, b, c]);
    expect(keys.get(b)).toBe(key);
    expect(keys.get(c)).toBe(key);
    expect(keys.get(a)).toBeNull();
    const [group] = await groupRow(key);
    expect(group?.memberCount).toBe(2);
    expect(new Date(group?.formedAt ?? '').toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(new Date(group?.updatedAt ?? '').toISOString()).toBe('2026-10-20T00:00:00.000Z');

    // Then c goes too: b has no look-alike left.
    await db
      .update(realEstateListings)
      .set({ status: 'gone', goneAt: '2026-10-20T12:00:00.000Z', goneReason: 'expired' })
      .where(eq(realEstateListings.id, c));
    const result = await regroupListings(db, { sourceId, now: '2026-10-21T00:00:00.000Z' });
    expect(result).toMatchObject({ groups: 0, groupedListings: 0 });
    expect((await keysOf([b])).get(b)).toBeNull();
    expect(await groupRow(key)).toEqual([]);
  });

  it('gives two groups that both held one key different keys', async () => {
    const sourceId = await newSource();
    const a = await listing(sourceId, { priceUsd: '100000.00' });
    const b = await listing(sourceId, { priceUsd: '102000.00' });
    const c = await listing(sourceId, { priceUsd: '104500.00' });
    const d = await listing(sourceId, { priceUsd: '106000.00' });
    // All four once shared a key (as if an earlier rule had chained them).
    await db
      .update(realEstateListings)
      .set({ groupKey: 'shared' })
      .where(inArray(realEstateListings.id, [a, b, c, d]));

    await regroupListings(db, { sourceId, now: '2026-10-19T00:00:00.000Z' });
    const keys = await keysOf([a, b, c, d]);
    expect(keys.get(a)).toBe(keys.get(b));
    expect(keys.get(c)).toBe(keys.get(d));
    expect(keys.get(a)).not.toBe(keys.get(c));
    expect([keys.get(a), keys.get(c)]).toContain('shared');
  });

  it('leaves another source’s listings alone', async () => {
    const mine = await newSource();
    const theirs = await newSource();
    const x = await listing(theirs, { groupKey: 'theirs' });
    await listing(mine);
    await listing(mine);
    await regroupListings(db, { sourceId: mine, now: '2026-10-19T00:00:00.000Z' });
    expect((await keysOf([x])).get(x)).toBe('theirs');
  });
});
