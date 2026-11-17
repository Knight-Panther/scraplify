import { afterEach, describe, expect, it } from 'vitest';
import { upsertListing } from '../realestate/ingest.js';
import { db, pool } from './client.js';
import { realEstateFingerprint, statusEventsFingerprint } from './real-data-guard.js';
import { expireOverdueListings } from './reconcile-source-listings.js';
import { cleanupTestSource, createTestSource, createTestSourceListing } from './test-support.js';

const SEEN = '2026-10-12T02:00:00.000Z';

function card(priceUsd: number) {
  return {
    sourceListingKey: '35653707',
    canonicalUrl: 'https://home.ss.ge/ka/udzravi-qoneba/35653707',
    dealType: 'sale' as const,
    propertyType: 'flat' as const,
    rooms: 3,
    bedrooms: 2,
    areaM2: 80,
    floor: 6,
    totalFloors: 14,
    priceGel: null,
    priceUsd,
    pricePerM2Usd: null,
    pricePerM2Gel: null,
    currencyPosted: 'usd' as const,
    cityRef: 95,
    cityName: 'თბილისი',
    districtRef: null,
    districtName: null,
    subdistrictRef: null,
    subdistrictName: null,
    streetRef: null,
    streetName: null,
    streetNumber: null,
    ssMetro: null,
    floorLow: null,
    floorHigh: null,
    posterType: 'unknown' as const,
    promoted: false,
    commercialType: null,
    landType: null,
    imageCount: null,
    hasFurniture: null,
    hasBuiltInKitchen: null,
    exclusive: false,
    videoViewing: false,
    description: null,
    similarityGroup: null,
    sourceUpdatedAt: '2026-10-11T12:00:00.000Z',
    sourceCreatedAt: null,
    expectedEndAt: null,
    latestEndAt: null,
  };
}

/**
 * The guard's own promise for the real-estate schema: any write to a guarded
 * source's rows moves the fingerprint, and another source's writes do not.
 * A disposable source stands in for the guarded one.
 */
describe('realEstateFingerprint', () => {
  const sourceIds: string[] = [];

  async function newSource(): Promise<{ id: string; slug: string }> {
    const id = await createTestSource();
    sourceIds.push(id);
    return { id, slug: `test-source-${id}` };
  }

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  it('moves when a guarded source gains a listing, and again when its price changes', async () => {
    const guarded = await newSource();
    const empty = await realEstateFingerprint(pool, [guarded.slug]);

    await upsertListing(db, { sourceId: guarded.id, card: card(100000), seenAt: SEEN });
    const withListing = await realEstateFingerprint(pool, [guarded.slug]);
    expect(withListing).not.toBe(empty);

    await upsertListing(db, { sourceId: guarded.id, card: card(95000), seenAt: SEEN });
    expect(await realEstateFingerprint(pool, [guarded.slug])).not.toBe(withListing);
  });

  it("does not move for another source's rows", async () => {
    const guarded = await newSource();
    const other = await newSource();
    const before = await realEstateFingerprint(pool, [guarded.slug]);

    await upsertListing(db, { sourceId: other.id, card: card(100000), seenAt: SEEN });

    expect(await realEstateFingerprint(pool, [guarded.slug])).toBe(before);
  });
});

describe('statusEventsFingerprint', () => {
  const sourceIds: string[] = [];

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  it("moves when a guarded source's listing changes status, and not for another source's", async () => {
    const guarded = await createTestSource();
    const other = await createTestSource();
    sourceIds.push(guarded, other);
    const slug = `test-source-${guarded}`;
    await createTestSourceListing(guarded, { sourceDeadlineAt: '2026-01-02T00:00:00Z' });
    await createTestSourceListing(other, { sourceDeadlineAt: '2026-01-02T00:00:00Z' });
    const before = await statusEventsFingerprint(pool, [slug]);

    await expireOverdueListings(db, { sourceId: other, asOf: '2026-02-01T00:00:00Z' });
    expect(await statusEventsFingerprint(pool, [slug])).toBe(before);

    await expireOverdueListings(db, { sourceId: guarded, asOf: '2026-02-01T00:00:00Z' });
    expect(await statusEventsFingerprint(pool, [slug])).not.toBe(before);
  });
});
