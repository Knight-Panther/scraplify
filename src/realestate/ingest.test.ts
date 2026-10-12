import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import { realEstateListings, realEstatePriceChanges } from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import { type ListingCard, upsertListing } from './ingest.js';

const FIRST_SEEN = '2026-10-12T02:00:00.000Z';
const SEEN_AGAIN = '2026-10-13T02:00:00.000Z';

/** A three-room flat for sale, as the ss.ge parser would hand it over. */
function card(overrides: Partial<ListingCard> = {}): ListingCard {
  return {
    sourceListingKey: '35653707',
    canonicalUrl: 'https://home.ss.ge/ka/udzravi-qoneba/35653707',
    dealType: 'sale',
    propertyType: 'flat',
    rooms: 3,
    bedrooms: 2,
    areaM2: 80,
    floor: 6,
    totalFloors: 14,
    priceGel: 270000,
    priceUsd: 100000,
    pricePerM2Usd: 1250,
    currencyPosted: 'usd',
    cityRef: 95,
    cityName: 'თბილისი',
    districtRef: 3,
    districtName: 'ვაკე-საბურთალო',
    subdistrictRef: 3,
    subdistrictName: 'საბურთალო',
    streetName: 'უნივერსიტეტის ქ.',
    streetNumber: '2',
    posterType: 'agent',
    promoted: false,
    description: 'ახალი რემონტით',
    similarityGroup: null,
    sourceUpdatedAt: '2026-10-11T12:00:00.000Z',
    sourceCreatedAt: '2026-10-01T09:00:00.000Z',
    expectedEndAt: '2026-11-10T12:00:00.000Z',
    ...overrides,
  };
}

/** Timestamps come back in Postgres's own text form; compare the instants. */
function instant(value: string | null | undefined): number {
  return new Date(value ?? Number.NaN).getTime();
}

describe('upsertListing', () => {
  const sourceIds: string[] = [];

  async function newSource(): Promise<string> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    return sourceId;
  }

  async function rowsOf(sourceId: string) {
    return db.select().from(realEstateListings).where(eq(realEstateListings.sourceId, sourceId));
  }

  async function priceChangesOf(listingId: string) {
    return db
      .select()
      .from(realEstatePriceChanges)
      .where(eq(realEstatePriceChanges.listingId, listingId));
  }

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  it('stores a listing seen for the first time as active', async () => {
    const sourceId = await newSource();

    const outcome = await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });

    expect(outcome).toBe('new');
    const [row] = await rowsOf(sourceId);
    expect(row).toMatchObject({
      sourceListingKey: '35653707',
      dealType: 'sale',
      propertyType: 'flat',
      rooms: 3,
      floor: 6,
      totalFloors: 14,
      cityRef: 95,
      subdistrictName: 'საბურთალო',
      posterType: 'agent',
      status: 'active',
      goneAt: null,
    });
    expect(Number(row?.priceUsd)).toBe(100000);
    expect(Number(row?.areaM2)).toBe(80);
    expect(instant(row?.firstSeenAt)).toBe(instant(FIRST_SEEN));
    expect(instant(row?.lastSeenAt)).toBe(instant(FIRST_SEEN));
    expect(instant(row?.expectedEndAt)).toBe(instant('2026-11-10T12:00:00.000Z'));
  });

  it('leaves an identical listing as it is, moving only when it was last seen', async () => {
    const sourceId = await newSource();
    await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });

    const outcome = await upsertListing(db, { sourceId, card: card(), seenAt: SEEN_AGAIN });

    expect(outcome).toBe('unchanged');
    const rows = await rowsOf(sourceId);
    expect(rows).toHaveLength(1);
    expect(instant(rows[0]?.firstSeenAt)).toBe(instant(FIRST_SEEN));
    expect(instant(rows[0]?.lastSeenAt)).toBe(instant(SEEN_AGAIN));
    expect(await priceChangesOf(rows[0]?.id ?? '')).toHaveLength(0);
  });

  it('records a price change with the old and the new price', async () => {
    const sourceId = await newSource();
    await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });

    const outcome = await upsertListing(db, {
      sourceId,
      card: card({ priceUsd: 95000, priceGel: 256500, pricePerM2Usd: 1187.5 }),
      seenAt: SEEN_AGAIN,
    });

    expect(outcome).toBe('changed');
    const [row] = await rowsOf(sourceId);
    expect(Number(row?.priceUsd)).toBe(95000);
    const changes = await priceChangesOf(row?.id ?? '');
    expect(changes).toHaveLength(1);
    expect(Number(changes[0]?.oldPriceUsd)).toBe(100000);
    expect(Number(changes[0]?.newPriceUsd)).toBe(95000);
    expect(Number(changes[0]?.oldPriceGel)).toBe(270000);
    expect(Number(changes[0]?.newPriceGel)).toBe(256500);
    expect(instant(changes[0]?.observedAt)).toBe(instant(SEEN_AGAIN));
  });

  it('updates a changed field without inventing a price change', async () => {
    const sourceId = await newSource();
    await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });

    const outcome = await upsertListing(db, {
      sourceId,
      card: card({ description: 'ახალი რემონტით, ავეჯით' }),
      seenAt: SEEN_AGAIN,
    });

    expect(outcome).toBe('changed');
    const [row] = await rowsOf(sourceId);
    expect(row?.description).toBe('ახალი რემონტით, ავეჯით');
    expect(await priceChangesOf(row?.id ?? '')).toHaveLength(0);
  });

  it('treats a later order time with nothing else changed as a bump', async () => {
    const sourceId = await newSource();
    await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });

    const outcome = await upsertListing(db, {
      sourceId,
      card: card({
        sourceUpdatedAt: '2026-10-12T20:00:00.000Z',
        expectedEndAt: '2026-11-11T20:00:00.000Z',
      }),
      seenAt: SEEN_AGAIN,
    });

    expect(outcome).toBe('bumped');
    const [row] = await rowsOf(sourceId);
    expect(instant(row?.sourceUpdatedAt)).toBe(instant('2026-10-12T20:00:00.000Z'));
    expect(instant(row?.expectedEndAt)).toBe(instant('2026-11-11T20:00:00.000Z'));
    expect(await priceChangesOf(row?.id ?? '')).toHaveLength(0);
  });

  it('brings a gone listing back when the source shows it again', async () => {
    const sourceId = await newSource();
    await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });
    await db
      .update(realEstateListings)
      .set({ status: 'gone', goneAt: '2026-10-12T12:00:00.000Z', goneReason: 'expired' })
      .where(eq(realEstateListings.sourceId, sourceId));

    const outcome = await upsertListing(db, { sourceId, card: card(), seenAt: SEEN_AGAIN });

    expect(outcome).toBe('reopened');
    const [row] = await rowsOf(sourceId);
    expect(row).toMatchObject({ status: 'active', goneAt: null, goneReason: null });
  });

  it('is undone by the ordinary test-source cleanup, price changes included', async () => {
    const sourceId = await createTestSource();
    await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });
    await upsertListing(db, { sourceId, card: card({ priceUsd: 95000 }), seenAt: SEEN_AGAIN });
    const [row] = await rowsOf(sourceId);

    await cleanupTestSource(sourceId);

    expect(await rowsOf(sourceId)).toHaveLength(0);
    expect(await priceChangesOf(row?.id ?? '')).toHaveLength(0);
  });

  it('keeps the same listing id from two sources apart', async () => {
    const first = await newSource();
    const second = await newSource();

    await upsertListing(db, { sourceId: first, card: card(), seenAt: FIRST_SEEN });
    const outcome = await upsertListing(db, { sourceId: second, card: card(), seenAt: FIRST_SEEN });

    expect(outcome).toBe('new');
    expect(await rowsOf(first)).toHaveLength(1);
    expect(await rowsOf(second)).toHaveLength(1);
  });
});
