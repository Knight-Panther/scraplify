import { afterEach, describe, expect, it } from 'vitest';
import { upsertListing } from '../realestate/ingest.js';
import { db, pool } from './client.js';
import { realEstateFingerprint } from './real-data-guard.js';
import { cleanupTestSource, createTestSource } from './test-support.js';

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
    currencyPosted: 'usd' as const,
    cityRef: 95,
    cityName: 'თბილისი',
    districtRef: null,
    districtName: null,
    subdistrictRef: null,
    subdistrictName: null,
    streetName: null,
    streetNumber: null,
    posterType: 'unknown' as const,
    promoted: false,
    description: null,
    similarityGroup: null,
    sourceUpdatedAt: '2026-10-11T12:00:00.000Z',
    sourceCreatedAt: null,
    expectedEndAt: null,
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
