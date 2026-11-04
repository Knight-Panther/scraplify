import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import { type NewRealEstateListingRow, realEstateListings } from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import {
  type ListingDetails,
  loadListingsWantingDetails,
  recordListingDetails,
} from './details.js';

const NOW = Date.parse('2026-11-04T22:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (daysFromNow: number) => new Date(NOW + daysFromNow * DAY_MS).toISOString();

/** Timestamps come back in Postgres's own text form; compare the instants. */
const instant = (value: string | null | undefined) => new Date(value ?? Number.NaN).getTime();

const DETAILS: ListingDetails = {
  buildingStatus: 'under-construction',
  condition: 'black-frame',
  project: 'non-standard',
  floorType: 'duplex',
  bathrooms: 2,
  balconies: 0,
  kitchenAreaM2: 12.5,
  houseAreaM2: 240,
  yardAreaM2: 600,
  posterEntity: 'developer',
  amenities: ['central-heating', 'natural-gas', 'pool'],
  latitude: 41.716537,
  longitude: 44.783333,
  municipalityRef: 1,
  municipalityName: 'თბილისის შემოგარენი',
};

describe('listing details', () => {
  const sourceIds: string[] = [];
  let nextKey = 1;

  async function newSource(): Promise<string> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    return sourceId;
  }

  async function listing(
    sourceId: string,
    overrides: Partial<NewRealEstateListingRow> = {},
  ): Promise<{ id: string; key: string }> {
    const key = String(nextKey++);
    const [row] = await db
      .insert(realEstateListings)
      .values({
        sourceId,
        sourceListingKey: key,
        canonicalUrl: `https://example.invalid/${key}`,
        dealType: 'sale',
        propertyType: 'flat',
        sourceUpdatedAt: at(-1),
        expectedEndAt: at(29),
        firstSeenAt: at(-1),
        lastSeenAt: at(-1),
        contentHash: 'h',
        ...overrides,
      })
      .returning({ id: realEstateListings.id });
    if (row === undefined) throw new Error('listing was not inserted');
    return { id: row.id, key };
  }

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  it('records every detail and clears the want', async () => {
    const sourceId = await newSource();
    const { id } = await listing(sourceId, { detailsWantedAt: at(-1) });

    await recordListingDetails(db, { listingId: id, details: DETAILS, readAt: at(0) });

    const [row] = await db.select().from(realEstateListings).where(eq(realEstateListings.id, id));
    expect(row).toMatchObject({
      buildingStatus: 'under-construction',
      condition: 'black-frame',
      project: 'non-standard',
      floorType: 'duplex',
      bathrooms: 2,
      balconies: 0,
      posterEntity: 'developer',
      amenities: ['central-heating', 'natural-gas', 'pool'],
      municipalityRef: 1,
      municipalityName: 'თბილისის შემოგარენი',
      detailsWantedAt: null,
    });
    expect(Number(row?.kitchenArea)).toBe(12.5);
    expect(Number(row?.houseArea)).toBe(240);
    expect(Number(row?.yardArea)).toBe(600);
    expect(Number(row?.latitude)).toBe(41.716537);
    expect(Number(row?.longitude)).toBe(44.783333);
    expect(instant(row?.detailsReadAt)).toBe(NOW);
  });

  it('writes unknown over a value a later page no longer gives', async () => {
    const sourceId = await newSource();
    const { id } = await listing(sourceId);
    await recordListingDetails(db, { listingId: id, details: DETAILS, readAt: at(-1) });

    await recordListingDetails(db, {
      listingId: id,
      details: { ...DETAILS, condition: null, amenities: [] },
      readAt: at(0),
    });

    const [row] = await db.select().from(realEstateListings).where(eq(realEstateListings.id, id));
    expect(row).toMatchObject({ condition: null, amenities: [] });
  });

  it('queues the listings that want their page read, the newest listing first, and no others', async () => {
    const sourceId = await newSource();
    // A price changed last night on a listing ordered five days ago: read after a newer one.
    const older = await listing(sourceId, { sourceUpdatedAt: at(-5), detailsWantedAt: at(-1) });
    const newer = await listing(sourceId, { sourceUpdatedAt: at(-1), detailsWantedAt: at(-3) });
    await listing(sourceId); // never wanted: stored before 12B
    await listing(sourceId, { detailsWantedAt: at(-2), detailsReadAt: at(-2) });
    await listing(sourceId, { detailsWantedAt: at(-2), status: 'gone', goneAt: at(-1) });
    const other = await newSource();
    await listing(other, { detailsWantedAt: at(-1) });

    const wanted = await loadListingsWantingDetails(db, { sourceId, limit: 10 });

    expect(wanted).toEqual([
      { id: newer.id, sourceListingKey: newer.key },
      { id: older.id, sourceListingKey: older.key },
    ]);
    expect(await loadListingsWantingDetails(db, { sourceId, limit: 1 })).toHaveLength(1);
  });
});
