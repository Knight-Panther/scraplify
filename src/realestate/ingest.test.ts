import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import { realEstateListings, realEstatePriceChanges } from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import { type ListingDetails, recordListingDetails } from './details.js';
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
    pricePerM2Gel: 3375,
    currencyPosted: 'usd',
    cityRef: 95,
    cityName: 'თბილისი',
    districtRef: 3,
    districtName: 'ვაკე-საბურთალო',
    subdistrictRef: 3,
    subdistrictName: 'საბურთალო',
    streetRef: 101,
    streetName: 'უნივერსიტეტის ქ.',
    streetNumber: '2',
    ssMetro: null,
    floorLow: 6,
    floorHigh: 6,
    posterType: 'agent',
    promoted: false,
    commercialType: null,
    landType: null,
    imageCount: 8,
    hasFurniture: true,
    hasBuiltInKitchen: null,
    exclusive: false,
    videoViewing: false,
    description: 'ახალი რემონტით',
    similarityGroup: null,
    sourceUpdatedAt: '2026-10-11T12:00:00.000Z',
    sourceCreatedAt: '2026-10-01T09:00:00.000Z',
    expectedEndAt: '2026-11-10T12:00:00.000Z',
    ...overrides,
  };
}

const NO_DETAILS: ListingDetails = {
  buildingStatus: null,
  condition: null,
  project: null,
  floorType: null,
  bathrooms: null,
  balconies: null,
  kitchenAreaM2: null,
  houseAreaM2: null,
  yardAreaM2: null,
  posterEntity: null,
  amenities: [],
  latitude: null,
  longitude: null,
  municipalityRef: null,
  municipalityName: null,
  pinManual: null,
  cadastralCode: null,
  complexRef: null,
  complexName: null,
  developerRef: null,
  developerName: null,
  streetRef: null,
  ssMetro: null,
  floorLow: null,
  floorHigh: null,
  street: { point: null, name: null, subdistrictRef: null, cityRef: null },
};

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

  it("stores a commercial listing's space type and a land listing's land type", async () => {
    const sourceId = await newSource();
    await upsertListing(db, {
      sourceId,
      card: card({
        sourceListingKey: '1',
        propertyType: 'commercial',
        dealType: 'rent',
        rooms: null,
        commercialType: 7,
        imageCount: 0,
        hasFurniture: null,
        exclusive: true,
        videoViewing: true,
        pricePerM2Gel: 35,
      }),
      seenAt: FIRST_SEEN,
    });
    await upsertListing(db, {
      sourceId,
      card: card({ sourceListingKey: '2', propertyType: 'land', rooms: null, landType: 2 }),
      seenAt: FIRST_SEEN,
    });

    const rows = await rowsOf(sourceId);
    const byKey = new Map(rows.map((row) => [row.sourceListingKey, row]));
    expect(byKey.get('1')).toMatchObject({
      propertyType: 'commercial',
      dealType: 'rent',
      commercialType: 7,
      landType: null,
      imageCount: 0,
      hasFurniture: null,
      hasBuiltInKitchen: null,
      exclusive: true,
      videoViewing: true,
    });
    expect(Number(byKey.get('1')?.pricePerM2Gel)).toBe(35);
    expect(byKey.get('2')).toMatchObject({
      propertyType: 'land',
      landType: 2,
      commercialType: null,
      imageCount: 8,
      hasFurniture: true,
      exclusive: false,
    });
  });

  it('refreshes photo count, furniture and exclusive on an unchanged sighting without calling it a change', async () => {
    const sourceId = await newSource();
    await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });

    const outcome = await upsertListing(db, {
      sourceId,
      card: card({
        imageCount: 12,
        hasFurniture: false,
        hasBuiltInKitchen: true,
        exclusive: true,
        videoViewing: true,
        pricePerM2Gel: 3400,
      }),
      seenAt: SEEN_AGAIN,
    });

    expect(outcome).toBe('unchanged');
    const [row] = await rowsOf(sourceId);
    expect(row).toMatchObject({
      imageCount: 12,
      hasFurniture: false,
      hasBuiltInKitchen: true,
      exclusive: true,
      videoViewing: true,
    });
    expect(Number(row?.pricePerM2Gel)).toBe(3400);
    expect(await priceChangesOf(row?.id ?? '')).toHaveLength(0);
  });

  describe('which listings want their own page read (Phase 12B)', () => {
    const RENEWED = '2026-10-12T12:00:00.000Z';

    it('wants details for a new listing, and for a renewed one never read', async () => {
      const sourceId = await newSource();
      await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });
      const [fresh] = await rowsOf(sourceId);
      expect(instant(fresh?.detailsWantedAt)).toBe(instant(FIRST_SEEN));

      // Stored before 12B: never wanted, never read.
      await db
        .update(realEstateListings)
        .set({ detailsWantedAt: null })
        .where(eq(realEstateListings.sourceId, sourceId));
      const outcome = await upsertListing(db, {
        sourceId,
        card: card({ sourceUpdatedAt: RENEWED }),
        seenAt: SEEN_AGAIN,
      });

      expect(outcome).toBe('bumped');
      const [renewed] = await rowsOf(sourceId);
      expect(instant(renewed?.detailsWantedAt)).toBe(instant(SEEN_AGAIN));
    });

    it('does not want them again for a renewed listing already read', async () => {
      const sourceId = await newSource();
      await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });
      const [stored] = await rowsOf(sourceId);
      await recordListingDetails(db, {
        listingId: stored?.id ?? '',
        details: { ...NO_DETAILS, condition: 'renovated' },
        readAt: FIRST_SEEN,
      });

      const outcome = await upsertListing(db, {
        sourceId,
        card: card({ sourceUpdatedAt: RENEWED, priceUsd: 95000 }),
        seenAt: SEEN_AGAIN,
      });

      expect(outcome).toBe('changed');
      const [row] = await rowsOf(sourceId);
      expect(row?.detailsWantedAt).toBeNull();
      expect(row?.condition).toBe('renovated');
    });

    it('leaves a listing stored before this release unwanted while it is only seen unchanged', async () => {
      const sourceId = await newSource();
      await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });
      await db
        .update(realEstateListings)
        .set({ detailsWantedAt: null })
        .where(eq(realEstateListings.sourceId, sourceId));

      const outcome = await upsertListing(db, { sourceId, card: card(), seenAt: SEEN_AGAIN });

      expect(outcome).toBe('unchanged');
      const [row] = await rowsOf(sourceId);
      expect(row?.detailsWantedAt).toBeNull();
      expect(row?.detailsReadAt).toBeNull();
    });
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

  it('keeps a converted price current without calling it a change', async () => {
    // ss.ge converts a dollar price to lari at each day's rate: 2.6000 became
    // about 2.597 in October 2026, and 73% of the price changes recorded by
    // then were only that.
    const sourceId = await newSource();
    await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });

    const outcome = await upsertListing(db, {
      sourceId,
      card: card({ priceGel: 259700 }),
      seenAt: SEEN_AGAIN,
    });

    expect(outcome).toBe('unchanged');
    const [row] = await rowsOf(sourceId);
    expect(Number(row?.priceGel)).toBe(259700);
    expect(instant(row?.lastSeenAt)).toBe(instant(SEEN_AGAIN));
    expect(await priceChangesOf(row?.id ?? '')).toHaveLength(0);
  });

  it('does the same for a listing posted in lari, whose dollar price moves', async () => {
    const sourceId = await newSource();
    const inLari = {
      currencyPosted: 'gel',
      priceGel: 2000,
      priceUsd: 769,
      pricePerM2Usd: 9.6,
    } as const;
    await upsertListing(db, { sourceId, card: card(inLari), seenAt: FIRST_SEEN });

    const outcome = await upsertListing(db, {
      sourceId,
      card: card({ ...inLari, priceUsd: 770, pricePerM2Usd: 9.63 }),
      seenAt: SEEN_AGAIN,
    });

    expect(outcome).toBe('unchanged');
    const [row] = await rowsOf(sourceId);
    expect(Number(row?.priceUsd)).toBe(770);
    expect(Number(row?.pricePerM2Usd)).toBe(9.63);
    expect(await priceChangesOf(row?.id ?? '')).toHaveLength(0);
  });

  it('records a new price in lari for a listing posted in lari', async () => {
    const sourceId = await newSource();
    const inLari = {
      currencyPosted: 'gel',
      priceGel: 2000,
      priceUsd: 769,
      pricePerM2Usd: 9.6,
    } as const;
    await upsertListing(db, { sourceId, card: card(inLari), seenAt: FIRST_SEEN });

    const outcome = await upsertListing(db, {
      sourceId,
      card: card({ ...inLari, priceGel: 1800, priceUsd: 692 }),
      seenAt: SEEN_AGAIN,
    });

    expect(outcome).toBe('changed');
    const changes = await priceChangesOf((await rowsOf(sourceId))[0]?.id ?? '');
    expect(changes).toHaveLength(1);
    expect(Number(changes[0]?.oldPriceGel)).toBe(2000);
    expect(Number(changes[0]?.newPriceGel)).toBe(1800);
  });

  it('records a switch of the posted currency as a price change', async () => {
    const sourceId = await newSource();
    await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });

    const outcome = await upsertListing(db, {
      sourceId,
      card: card({ currencyPosted: 'gel', priceGel: 270000 }),
      seenAt: SEEN_AGAIN,
    });

    expect(outcome).toBe('changed');
    expect(await priceChangesOf((await rowsOf(sourceId))[0]?.id ?? '')).toHaveLength(1);
  });

  it('judges a change by the stored fields, whatever fingerprint the row was stored with', async () => {
    // Rows written before the fingerprint left out converted prices carry the
    // old one; comparing fingerprints would call every one of them changed.
    const sourceId = await newSource();
    await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });
    await db
      .update(realEstateListings)
      .set({ contentHash: 'written-by-an-older-release' })
      .where(eq(realEstateListings.sourceId, sourceId));

    const outcome = await upsertListing(db, { sourceId, card: card(), seenAt: SEEN_AGAIN });

    expect(outcome).toBe('unchanged');
  });

  it('clears the missed mark of a listing seen again', async () => {
    const sourceId = await newSource();
    await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });
    await db
      .update(realEstateListings)
      .set({ missedAt: FIRST_SEEN })
      .where(eq(realEstateListings.sourceId, sourceId));

    await upsertListing(db, { sourceId, card: card(), seenAt: SEEN_AGAIN });

    expect((await rowsOf(sourceId))[0]?.missedAt).toBeNull();
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

  describe('places (Phase 14A)', () => {
    /** As a parser before 14A handed it over: no street id, metro or floor range. */
    const before14A = (overrides: Partial<ListingCard> = {}) =>
      card({ streetRef: null, ssMetro: null, floorLow: null, floorHigh: null, ...overrides });
    const legacy = { districtRef: null, districtName: null } as const;
    const vakeSaburtalo = new Map([[3, { ref: 3, name: 'ვაკე-საბურთალო' }]]);

    /** A row as the code before 14A left it, its page never wanted. */
    async function storedBefore14A(sourceId: string, overrides: Partial<ListingCard> = {}) {
      await upsertListing(db, { sourceId, card: before14A(overrides), seenAt: FIRST_SEEN });
      await db
        .update(realEstateListings)
        .set({ houseNumber: null, houseSuffix: null, detailsWantedAt: null })
        .where(eq(realEstateListings.sourceId, sourceId));
    }

    it('gives a row stored before it its street id, metro, floors and house number, unchanged', async () => {
      const sourceId = await newSource();
      await storedBefore14A(sourceId, { streetNumber: '117დ' });

      const outcome = await upsertListing(db, {
        sourceId,
        card: card({ streetNumber: '117დ', ssMetro: { medical_uni: 15 } }),
        seenAt: SEEN_AGAIN,
        parents: vakeSaburtalo,
      });

      expect(outcome).toBe('unchanged');
      const [row] = await rowsOf(sourceId);
      expect(row).toMatchObject({
        streetRef: 101,
        ssMetro: { medical_uni: 15 },
        floorLow: 6,
        floorHigh: 6,
        houseNumber: 117,
        houseSuffix: 'დ',
        districtInferred: false,
        detailsWantedAt: null,
      });
    });

    it('fills a district the row leaves out from its sub-district, and marks it', async () => {
      const sourceId = await newSource();

      await upsertListing(db, {
        sourceId,
        card: card(legacy),
        seenAt: FIRST_SEEN,
        parents: vakeSaburtalo,
      });

      const [row] = await rowsOf(sourceId);
      expect(row).toMatchObject({
        districtRef: 3,
        districtName: 'ვაკე-საბურთალო',
        districtInferred: true,
      });
    });

    it('fills a legacy row stored without the fill on its next sighting, unchanged', async () => {
      const sourceId = await newSource();
      await storedBefore14A(sourceId, legacy);

      const outcome = await upsertListing(db, {
        sourceId,
        card: card(legacy),
        seenAt: SEEN_AGAIN,
        parents: vakeSaburtalo,
      });

      expect(outcome).toBe('unchanged');
      const [row] = await rowsOf(sourceId);
      expect(row).toMatchObject({ districtRef: 3, districtInferred: true, detailsWantedAt: null });
    });

    it('takes the source stating the district itself for no change, and drops the mark', async () => {
      const sourceId = await newSource();
      await upsertListing(db, {
        sourceId,
        card: card(legacy),
        seenAt: FIRST_SEEN,
        parents: vakeSaburtalo,
      });

      const outcome = await upsertListing(db, {
        sourceId,
        card: card(),
        seenAt: SEEN_AGAIN,
        parents: vakeSaburtalo,
      });

      expect(outcome).toBe('unchanged');
      const [row] = await rowsOf(sourceId);
      expect(row).toMatchObject({ districtRef: 3, districtInferred: false });
    });

    it('takes a sub-district moved to another district for no change, and follows it', async () => {
      const sourceId = await newSource();
      await upsertListing(db, {
        sourceId,
        card: card(legacy),
        seenAt: FIRST_SEEN,
        parents: vakeSaburtalo,
      });
      await db
        .update(realEstateListings)
        .set({ detailsWantedAt: null })
        .where(eq(realEstateListings.sourceId, sourceId));

      const outcome = await upsertListing(db, {
        sourceId,
        card: card(legacy),
        seenAt: SEEN_AGAIN,
        parents: new Map([[3, { ref: 5, name: 'ძველი თბილისი' }]]),
      });

      expect(outcome).toBe('unchanged');
      const [row] = await rowsOf(sourceId);
      expect(row).toMatchObject({
        districtRef: 5,
        districtName: 'ძველი თბილისი',
        districtInferred: true,
        detailsWantedAt: null,
      });
    });

    it('fills nothing without the tree, and nothing the tree does not hold', async () => {
      const sourceId = await newSource();
      await upsertListing(db, { sourceId, card: card(legacy), seenAt: FIRST_SEEN });
      await upsertListing(db, {
        sourceId,
        card: card({ ...legacy, sourceListingKey: '2', subdistrictRef: 44 }),
        seenAt: FIRST_SEEN,
        parents: vakeSaburtalo,
      });

      for (const row of await rowsOf(sourceId)) {
        expect(row).toMatchObject({ districtRef: null, districtInferred: false });
      }
    });

    it('never takes a change of street id or metro for a change of the listing', async () => {
      const sourceId = await newSource();
      await upsertListing(db, { sourceId, card: card(), seenAt: FIRST_SEEN });

      const outcome = await upsertListing(db, {
        sourceId,
        card: card({ streetRef: 202, ssMetro: { delisi: 5 }, floorLow: 5, floorHigh: 7 }),
        seenAt: SEEN_AGAIN,
      });

      expect(outcome).toBe('unchanged');
      expect((await rowsOf(sourceId))[0]).toMatchObject({ streetRef: 202, ssMetro: { delisi: 5 } });
    });
  });
});
