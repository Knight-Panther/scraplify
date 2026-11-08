import { eq, getTableColumns, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  type NewRealEstateListingRow,
  realEstateArchiveListings,
  realEstateArchivePriceChanges,
  realEstateListings,
  realEstatePriceChanges,
  realEstateRecentlyGone,
} from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import {
  deleteLongGoneListings,
  loadListingsDueForCheck,
  markLapsedListingsGone,
  markMissedListings,
  recordListingCheck,
  UNSETTLED_RECHECK_DAYS,
} from './expiry.js';

const NOW = Date.parse('2026-10-12T22:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (daysFromNow: number) => new Date(NOW + daysFromNow * DAY_MS).toISOString();
const NOW_ISO = at(0);

/** Timestamps come back in Postgres's own text form; compare the instants. */
const instant = (value: string | null | undefined) => new Date(value ?? Number.NaN).getTime();

describe('listing expiry', () => {
  const sourceIds: string[] = [];
  let nextKey = 1;

  async function newSource(): Promise<string> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    return sourceId;
  }

  /** A listing last seen ten days ago that should end in twenty, unless told otherwise. */
  async function listing(
    sourceId: string,
    overrides: Partial<NewRealEstateListingRow> = {},
  ): Promise<string> {
    const key = String(nextKey++);
    const [row] = await db
      .insert(realEstateListings)
      .values({
        sourceId,
        sourceListingKey: key,
        canonicalUrl: `https://example.invalid/${key}`,
        dealType: 'sale',
        propertyType: 'flat',
        sourceUpdatedAt: at(-10),
        expectedEndAt: at(20),
        firstSeenAt: at(-10),
        lastSeenAt: at(-10),
        contentHash: 'h',
        ...overrides,
      })
      .returning({ id: realEstateListings.id });
    if (row === undefined) throw new Error('listing was not inserted');
    return row.id;
  }

  async function read(id: string) {
    const [row] = await db.select().from(realEstateListings).where(eq(realEstateListings.id, id));
    return row;
  }

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  describe('loadListingsDueForCheck', () => {
    it('returns active listings whose expected end has passed, and no others', async () => {
      const sourceId = await newSource();
      const due = await listing(sourceId, { expectedEndAt: at(-1), lastSeenAt: at(-5) });
      await listing(sourceId, { expectedEndAt: at(1) });
      await listing(sourceId, { expectedEndAt: null });
      await listing(sourceId, { expectedEndAt: at(-1), status: 'gone', goneAt: at(-1) });
      const elsewhere = await newSource();
      await listing(elsewhere, { expectedEndAt: at(-1) });

      const found = await loadListingsDueForCheck(db, { sourceId, asOf: NOW_ISO, limit: 10 });

      expect(found.map((row) => row.id)).toEqual([due]);
      expect(found[0]?.sourceListingKey).toEqual(expect.any(String));
    });

    it('puts first the listings the source still showed after their expected end', async () => {
      const sourceId = await newSource();
      // Expired yesterday and not seen since: probably just gone.
      const lapsedYesterday = await listing(sourceId, {
        expectedEndAt: at(-1),
        lastSeenAt: at(-3),
      });
      // Ordered two years ago and listed this morning: the thirty-day rule
      // does not hold for it, and only its own page says when it ends.
      const longRunning = await listing(sourceId, {
        sourceUpdatedAt: at(-700),
        expectedEndAt: at(-670),
        lastSeenAt: at(-0.5),
      });

      const found = await loadListingsDueForCheck(db, { sourceId, asOf: NOW_ISO, limit: 10 });

      expect(found.map((row) => row.id)).toEqual([longRunning, lapsedYesterday]);
    });

    it('asks about missed listings after the long-running ones, the longest-lived first', async () => {
      const sourceId = await newSource();
      const lapsedYesterday = await listing(sourceId, {
        expectedEndAt: at(-1),
        lastSeenAt: at(-3),
      });
      const longRunning = await listing(sourceId, {
        sourceUpdatedAt: at(-700),
        expectedEndAt: at(-670),
        lastSeenAt: at(-0.5),
      });
      // Not due by its date, but a full read of its list did not find it.
      const missedEndingSoon = await listing(sourceId, { expectedEndAt: at(5), missedAt: at(-1) });
      const missedEndingLate = await listing(sourceId, { expectedEndAt: at(30), missedAt: at(-1) });
      await listing(sourceId, { expectedEndAt: at(20) });

      const found = await loadListingsDueForCheck(db, { sourceId, asOf: NOW_ISO, limit: 10 });

      expect(found.map((row) => row.id)).toEqual([
        longRunning,
        missedEndingLate,
        missedEndingSoon,
        lapsedYesterday,
      ]);
    });

    it('then takes the most recently expired first, up to the limit', async () => {
      const sourceId = await newSource();
      const fourDays = await listing(sourceId, { expectedEndAt: at(-4), lastSeenAt: at(-9) });
      const oneDay = await listing(sourceId, { expectedEndAt: at(-1), lastSeenAt: at(-9) });
      const twoDays = await listing(sourceId, { expectedEndAt: at(-2), lastSeenAt: at(-9) });

      const found = await loadListingsDueForCheck(db, { sourceId, asOf: NOW_ISO, limit: 2 });

      // A check on the night a listing lapses keeps it on show without a
      // gap; one four days late does not, so the late ones wait.
      expect(found.map((row) => row.id)).toEqual([oneDay, twoDays]);
      expect(found.map((row) => row.id)).not.toContain(fourDays);
    });
  });

  describe('markMissedListings', () => {
    const readStartedAt = at(-0.5);

    it('marks the listings of the list that a full read did not see, nor any look-alike of them', async () => {
      const sourceId = await newSource();
      const missed = await listing(sourceId, { lastSeenAt: at(-10) });
      const seen = await listing(sourceId, {
        lastSeenAt: at(-0.2),
        groupKey: 'g1',
        similarityGroup: 's1',
      });
      // Not in the list, but a look-alike of it was: the list folds it under that one.
      const foldedByOurGroup = await listing(sourceId, { lastSeenAt: at(-10), groupKey: 'g1' });
      const foldedBySourceGroup = await listing(sourceId, {
        lastSeenAt: at(-10),
        similarityGroup: 's1',
      });
      const otherList = await listing(sourceId, { lastSeenAt: at(-10), propertyType: 'house' });
      const pastItsEnd = await listing(sourceId, { lastSeenAt: at(-10), expectedEndAt: at(-1) });
      const gone = await listing(sourceId, { lastSeenAt: at(-10), status: 'gone', goneAt: at(-2) });

      const count = await markMissedListings(db, {
        sourceId,
        dealType: 'sale',
        propertyType: 'flat',
        readStartedAt,
        at: NOW_ISO,
      });

      expect(count).toBe(1);
      expect(instant((await read(missed))?.missedAt)).toBe(NOW);
      for (const id of [seen, foldedByOurGroup, foldedBySourceGroup, otherList, pastItsEnd, gone]) {
        expect((await read(id))?.missedAt).toBeNull();
      }
    });

    it('keeps the first time a listing was missed', async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId, { lastSeenAt: at(-10), missedAt: at(-7) });

      const count = await markMissedListings(db, {
        sourceId,
        dealType: 'sale',
        propertyType: 'flat',
        readStartedAt,
        at: NOW_ISO,
      });

      expect(count).toBe(0);
      expect(instant((await read(id))?.missedAt)).toBe(instant(at(-7)));
    });
  });

  describe('recordListingCheck', () => {
    it('clears the missed mark of a listing its page shows as live', async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId, { missedAt: at(-1) });

      await recordListingCheck(db, {
        listingId: id,
        check: { status: 'active', endAt: at(12) },
        checkedAt: NOW_ISO,
      });

      expect((await read(id))?.missedAt).toBeNull();
    });

    it('extends a listing its page shows as live until a later date', async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId, { expectedEndAt: at(-1) });

      const outcome = await recordListingCheck(db, {
        listingId: id,
        check: { status: 'active', endAt: at(12) },
        checkedAt: NOW_ISO,
      });

      expect(outcome).toBe('verified');
      const row = await read(id);
      expect(row?.status).toBe('active');
      expect(instant(row?.expectedEndAt)).toBe(instant(at(12)));
      expect(instant(row?.verifiedAt)).toBe(NOW);
    });

    it('never trusts an end more than thirty days ahead, so a long-running listing is looked at monthly', async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId, { expectedEndAt: at(-600) });

      await recordListingCheck(db, {
        listingId: id,
        check: { status: 'active', endAt: '2040-01-01T00:00:00.000Z' },
        checkedAt: NOW_ISO,
      });

      expect(instant((await read(id))?.expectedEndAt)).toBe(instant(at(30)));
    });

    it('looks again in thirty days at a live listing that states no end', async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId, { expectedEndAt: at(-1) });

      await recordListingCheck(db, {
        listingId: id,
        check: { status: 'active', endAt: null },
        checkedAt: NOW_ISO,
      });

      expect(instant((await read(id))?.expectedEndAt)).toBe(instant(at(30)));
    });

    it('looks again in three days at a live listing whose stated end has passed', async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId, { expectedEndAt: at(-1) });

      const outcome = await recordListingCheck(db, {
        listingId: id,
        check: { status: 'active', endAt: at(-1) },
        checkedAt: NOW_ISO,
      });

      expect(outcome).toBe('verified');
      const row = await read(id);
      expect(row?.status).toBe('active');
      expect(instant(row?.expectedEndAt)).toBe(instant(at(3)));
    });

    describe('the price its page states', () => {
      const stored = {
        priceGel: 270000,
        priceUsd: 100000,
        pricePerM2Usd: 1250,
        pricePerM2Gel: 3375,
      } as const;
      const asText = { priceGel: '270000', priceUsd: '100000', pricePerM2Usd: '1250' };

      async function priceChangesOf(id: string) {
        return db
          .select()
          .from(realEstatePriceChanges)
          .where(eq(realEstatePriceChanges.listingId, id));
      }

      it('records a new price in the posted currency as a price change', async () => {
        // A listing nobody renewed, so no nightly run reads it again: its own
        // page is where an edited price shows (1 of 47 sampled, 2026-10-27).
        const sourceId = await newSource();
        const id = await listing(sourceId, { ...asText, currencyPosted: 'usd' });

        await recordListingCheck(db, {
          listingId: id,
          check: {
            status: 'active',
            endAt: at(12),
            price: {
              priceUsd: 92000,
              priceGel: 239000,
              pricePerM2Usd: 1150,
              pricePerM2Gel: 2988,
              currencyPosted: 'usd',
            },
          },
          checkedAt: NOW_ISO,
        });

        expect(Number((await read(id))?.priceUsd)).toBe(92000);
        const changes = await priceChangesOf(id);
        expect(changes).toHaveLength(1);
        expect(Number(changes[0]?.oldPriceUsd)).toBe(100000);
        expect(Number(changes[0]?.newPriceUsd)).toBe(92000);
        expect(instant(changes[0]?.observedAt)).toBe(NOW);
      });

      it('keeps a converted price current without recording a change', async () => {
        const sourceId = await newSource();
        const id = await listing(sourceId, { ...asText, currencyPosted: 'usd' });

        await recordListingCheck(db, {
          listingId: id,
          check: {
            status: 'active',
            endAt: at(12),
            price: { ...stored, priceGel: 259700, currencyPosted: 'usd' },
          },
          checkedAt: NOW_ISO,
        });

        expect(Number((await read(id))?.priceGel)).toBe(259700);
        expect(await priceChangesOf(id)).toHaveLength(0);
      });

      it('leaves the stored price alone when the page states none', async () => {
        const sourceId = await newSource();
        const id = await listing(sourceId, { ...asText, currencyPosted: 'usd' });

        await recordListingCheck(db, {
          listingId: id,
          check: {
            status: 'active',
            endAt: at(12),
            price: {
              priceGel: null,
              priceUsd: null,
              pricePerM2Usd: null,
              pricePerM2Gel: null,
              currencyPosted: null,
            },
          },
          checkedAt: NOW_ISO,
        });

        expect(Number((await read(id))?.priceUsd)).toBe(100000);
        expect(await priceChangesOf(id)).toHaveLength(0);
      });
    });

    it('does not drop a listing its list showed yesterday because its page once showed no listing', async () => {
      // ss.ge renders a live listing's page with no record now and then: two
      // of eight fresh ones on 2026-11-04, both live on the next request.
      const sourceId = await newSource();
      const seenYesterday = await listing(sourceId, { expectedEndAt: at(-1), lastSeenAt: at(-1) });
      const seenLongAgo = await listing(sourceId, { expectedEndAt: at(-1), lastSeenAt: at(-5) });

      const missing = { status: 'gone', reason: 'missing' } as const;
      const first = await recordListingCheck(db, {
        listingId: seenYesterday,
        check: missing,
        checkedAt: NOW_ISO,
      });
      const second = await recordListingCheck(db, {
        listingId: seenLongAgo,
        check: missing,
        checkedAt: NOW_ISO,
      });

      expect(first).toBe('unsettled');
      const kept = await read(seenYesterday);
      expect(kept).toMatchObject({ status: 'active', goneAt: null });
      expect(instant(kept?.expectedEndAt)).toBe(NOW + UNSETTLED_RECHECK_DAYS * DAY_MS);
      // Seen five days ago, its page's "no listing" is believed.
      expect(second).toBe('gone');
      expect(await read(seenLongAgo)).toMatchObject({ status: 'gone', goneReason: 'missing' });
    });

    it('believes "no listing" at once for a listing a full read of its list also missed', async () => {
      // Two signals agree: the list read to its end did not show it, and its page has no record.
      const sourceId = await newSource();
      const id = await listing(sourceId, { lastSeenAt: at(-1), missedAt: at(-0.5) });

      const outcome = await recordListingCheck(db, {
        listingId: id,
        check: { status: 'gone', reason: 'missing' },
        checkedAt: NOW_ISO,
      });

      expect(outcome).toBe('gone');
      expect(await read(id)).toMatchObject({ status: 'gone', goneReason: 'missing' });
    });

    it('believes "expired" whenever the list last showed it', async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId, { expectedEndAt: at(-1), lastSeenAt: at(-1) });

      const outcome = await recordListingCheck(db, {
        listingId: id,
        check: { status: 'gone', reason: 'expired' },
        checkedAt: NOW_ISO,
      });

      expect(outcome).toBe('gone');
    });

    it("keeps the details a live listing's page carries", async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId, { expectedEndAt: at(-1), detailsWantedAt: at(-2) });

      await recordListingCheck(db, {
        listingId: id,
        check: {
          status: 'active',
          endAt: at(12),
          details: {
            buildingStatus: 'new',
            condition: 'white-frame',
            project: null,
            floorType: null,
            bathrooms: 2,
            balconies: 1,
            kitchenAreaM2: null,
            houseAreaM2: null,
            yardAreaM2: null,
            posterEntity: 'agency',
            amenities: ['elevator'],
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
          },
        },
        checkedAt: NOW_ISO,
      });

      const row = await read(id);
      expect(row).toMatchObject({
        buildingStatus: 'new',
        condition: 'white-frame',
        bathrooms: 2,
        posterEntity: 'agency',
        amenities: ['elevator'],
        detailsWantedAt: null,
      });
      expect(instant(row?.detailsReadAt)).toBe(NOW);
    });

    it('marks gone a listing its page shows as over, with the reason', async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId, { expectedEndAt: at(-1) });

      const outcome = await recordListingCheck(db, {
        listingId: id,
        check: { status: 'gone', reason: 'expired' },
        checkedAt: NOW_ISO,
      });

      expect(outcome).toBe('gone');
      const row = await read(id);
      expect(row).toMatchObject({ status: 'gone', goneReason: 'expired' });
      expect(instant(row?.goneAt)).toBe(NOW);
      expect(instant(row?.verifiedAt)).toBe(NOW);
    });
  });

  describe('markLapsedListingsGone', () => {
    it('gives up on a listing nobody has seen or confirmed for a week past its expected end', async () => {
      const sourceId = await newSource();
      const lapsed = await listing(sourceId, { expectedEndAt: at(-8), lastSeenAt: at(-20) });
      const stillInGrace = await listing(sourceId, { expectedEndAt: at(-6), lastSeenAt: at(-20) });
      // Past its expected end for years, but the source listed it three days ago.
      const seenLately = await listing(sourceId, { expectedEndAt: at(-600), lastSeenAt: at(-3) });
      const notDue = await listing(sourceId, { expectedEndAt: at(5), lastSeenAt: at(-20) });

      const count = await markLapsedListingsGone(db, { sourceId, asOf: NOW_ISO });

      expect(count).toBe(1);
      const row = await read(lapsed);
      expect(row).toMatchObject({ status: 'gone', goneReason: 'lapsed' });
      expect(instant(row?.goneAt)).toBe(NOW);
      for (const id of [stillInGrace, seenLately, notDue]) {
        expect((await read(id))?.status).toBe('active');
      }
    });

    it('leaves another source alone', async () => {
      const sourceId = await newSource();
      const elsewhere = await newSource();
      const theirs = await listing(elsewhere, { expectedEndAt: at(-8), lastSeenAt: at(-20) });

      expect(await markLapsedListingsGone(db, { sourceId, asOf: NOW_ISO })).toBe(0);
      expect((await read(theirs))?.status).toBe('active');
    });
  });

  async function archived(sourceId: string) {
    return db
      .select()
      .from(realEstateArchiveListings)
      .where(eq(realEstateArchiveListings.sourceId, sourceId));
  }

  describe('deleteLongGoneListings', () => {
    async function archivedChanges(listingId: string) {
      return db
        .select()
        .from(realEstateArchivePriceChanges)
        .where(eq(realEstateArchivePriceChanges.listingId, listingId));
    }

    it('deletes a listing gone for fourteen days, with its price history, and nothing else', async () => {
      const sourceId = await newSource();
      const longGone = await listing(sourceId, { status: 'gone', goneAt: at(-15) });
      const goneLately = await listing(sourceId, { status: 'gone', goneAt: at(-13) });
      const active = await listing(sourceId, { firstSeenAt: at(-400), lastSeenAt: at(-1) });
      // Live again, whatever date its earlier absence left behind.
      const backAgain = await listing(sourceId, { status: 'active', goneAt: at(-30) });
      await db.insert(realEstatePriceChanges).values({
        listingId: longGone,
        observedAt: at(-40),
        oldPriceUsd: '100000.00',
        newPriceUsd: '95000.00',
      });

      const count = await deleteLongGoneListings(db, { sourceId, asOf: NOW_ISO });

      expect(count).toBe(1);
      expect(await read(longGone)).toBeUndefined();
      expect(await read(goneLately)).toBeDefined();
      expect(await read(active)).toBeDefined();
      expect(await read(backAgain)).toBeDefined();
      expect(
        await db
          .select()
          .from(realEstatePriceChanges)
          .where(eq(realEstatePriceChanges.listingId, longGone)),
      ).toEqual([]);
    });

    it('archives exactly the listings it deletes, with their price changes', async () => {
      const sourceId = await newSource();
      const longGone = await listing(sourceId, { status: 'gone', goneAt: at(-15) });
      const alsoLongGone = await listing(sourceId, { status: 'gone', goneAt: at(-20) });
      await listing(sourceId, { status: 'gone', goneAt: at(-13) });
      await listing(sourceId, { status: 'active', goneAt: at(-30) });
      const [change] = await db
        .insert(realEstatePriceChanges)
        .values([
          {
            listingId: longGone,
            observedAt: at(-40),
            oldPriceGel: '270000.00',
            newPriceGel: '256500.00',
            oldPriceUsd: '100000.00',
            newPriceUsd: '95000.00',
          },
        ])
        .returning();

      await deleteLongGoneListings(db, { sourceId, asOf: NOW_ISO });

      const rows = await archived(sourceId);
      expect(rows.map((row) => row.listingId).sort()).toEqual([longGone, alsoLongGone].sort());
      expect(await archivedChanges(longGone)).toEqual([change]);
      expect(await archivedChanges(alsoLongGone)).toEqual([]);
    });

    it('keeps the facts of a listing and leaves out its link, text and coordinates', async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId, {
        sourceListingKey: 'archive-facts-1',
        canonicalUrl: 'https://example.invalid/archive-facts-1',
        dealType: 'rent',
        propertyType: 'flat',
        rooms: 3,
        bedrooms: 2,
        areaM2: '82.50',
        floor: 4,
        totalFloors: 9,
        priceGel: '2700.00',
        priceUsd: '1000.00',
        pricePerM2Usd: '12.12',
        pricePerM2Gel: '32.73',
        currencyPosted: 'usd',
        cityRef: 95,
        cityName: 'თბილისი',
        districtRef: 4,
        districtName: 'ვაკე-საბურთალო',
        subdistrictRef: 22,
        subdistrictName: 'ვაკე',
        municipalityRef: 7,
        municipalityName: 'თბილისი',
        streetName: 'ჭავჭავაძის გამზ.',
        streetNumber: '12',
        posterType: 'agent',
        posterEntity: 'agency',
        imageCount: 14,
        hasFurniture: true,
        hasBuiltInKitchen: null,
        buildingStatus: 'old',
        condition: 'renovated',
        floorType: 'parquet',
        bathrooms: 2,
        balconies: 1,
        kitchenArea: '12.00',
        amenities: ['elevator', 'balcony'],
        detailsReadAt: at(-30),
        similarityGroup: 'sg-1',
        groupKey: 'g-should-not-matter',
        description: 'Call 599 12 34 56',
        latitude: '41.709000',
        longitude: '44.766000',
        // Phase 14A: kept, but for the private ones.
        streetRef: 19,
        houseNumber: 12,
        houseSuffix: null,
        floorLow: 4,
        floorHigh: 4,
        districtInferred: true,
        complexRef: 619,
        complexName: 'Comfort Hills',
        developerRef: 344,
        developerName: 'Comfort Hills',
        ssMetro: { zzprivatestation: 5 },
        pinManual: true,
        cadastralCode: '01.14.12.005.017',
        // Phase 14C: the public judgement is kept; the pin's, and the metro distance, are not.
        officialDistrictRef: 11300449,
        officialDistrictBasis: 'pin',
        locationPrecision: 'pin',
        locationUncertain: true,
        locationFlags: ['house_number_junk', 'district_inferred'],
        metroStation: 'medical_uni',
        metroMinutes: 15,
        metroBasis: 'pin',
        metroNearby: ['medical_uni', 'tech_uni'],
        buildingKey: 'c619',
        locationRules: 1,
        pinTrusted: true,
        pinStreetM: 86420,
        pinOfficialDistrictRef: 11300446,
        metroDistanceM: 97531,
        sourceCreatedAt: at(-90),
        sourceUpdatedAt: at(-40),
        firstSeenAt: at(-60),
        lastSeenAt: at(-16),
        status: 'gone',
        goneAt: at(-15),
        goneReason: 'page says removed',
      });

      await deleteLongGoneListings(db, { sourceId, asOf: NOW_ISO });

      const [row] = await archived(sourceId);
      expect(row).toMatchObject({
        listingId: id,
        sourceId,
        sourceListingKey: 'archive-facts-1',
        dealType: 'rent',
        propertyType: 'flat',
        rooms: 3,
        bedrooms: 2,
        areaM2: '82.50',
        floor: 4,
        totalFloors: 9,
        priceGel: '2700.00',
        priceUsd: '1000.00',
        pricePerM2Usd: '12.12',
        pricePerM2Gel: '32.73',
        currencyPosted: 'usd',
        cityRef: 95,
        cityName: 'თბილისი',
        districtRef: 4,
        districtName: 'ვაკე-საბურთალო',
        subdistrictRef: 22,
        subdistrictName: 'ვაკე',
        municipalityRef: 7,
        municipalityName: 'თბილისი',
        streetName: 'ჭავჭავაძის გამზ.',
        streetNumber: '12',
        posterType: 'agent',
        posterEntity: 'agency',
        imageCount: 14,
        hasFurniture: true,
        hasBuiltInKitchen: null,
        buildingStatus: 'old',
        condition: 'renovated',
        floorType: 'parquet',
        bathrooms: 2,
        balconies: 1,
        kitchenArea: '12.00',
        amenities: ['elevator', 'balcony'],
        similarityGroup: 'sg-1',
        goneReason: 'page says removed',
        implausible: false,
        streetRef: 19,
        houseNumber: 12,
        houseSuffix: null,
        floorLow: 4,
        floorHigh: 4,
        districtInferred: true,
        complexRef: 619,
        complexName: 'Comfort Hills',
        developerRef: 344,
        developerName: 'Comfort Hills',
        officialDistrictRef: 11300449,
        officialDistrictBasis: 'pin',
        locationPrecision: 'pin',
        locationUncertain: true,
        locationFlags: ['house_number_junk', 'district_inferred'],
        metroStation: 'medical_uni',
        metroMinutes: 15,
        metroBasis: 'pin',
        metroNearby: ['medical_uni', 'tech_uni'],
        buildingKey: 'c619',
        locationRules: 1,
      });
      expect(instant(row?.detailsReadAt)).toBe(instant(at(-30)));
      expect(instant(row?.sourceCreatedAt)).toBe(instant(at(-90)));
      expect(instant(row?.firstSeenAt)).toBe(instant(at(-60)));
      expect(instant(row?.lastSeenAt)).toBe(instant(at(-16)));
      expect(instant(row?.goneAt)).toBe(instant(at(-15)));
      // Nothing that could carry a link, a person's words or a location finer
      // than the street: not the pin, what was worked out from it (the metro
      // list), whether the poster placed it, nor a parcel's cadastral code.
      const leftOut = [
        'canonical_url',
        'description',
        'search',
        'latitude',
        'longitude',
        'ss_metro',
        'pin_manual',
        'cadastral_code',
        // Phase 14C: what the pin says, judged, and its distance to the metro.
        'pin_trusted',
        'pin_street_m',
        'pin_official_district_ref',
        'metro_distance_m',
      ];
      const columns = Object.values(getTableColumns(realEstateArchiveListings)).map((c) => c.name);
      expect(columns.filter((name) => leftOut.includes(name))).toEqual([]);
      // Whole values, not fragments: "599" alone turned up in a random source id (CI, 2026-11-06).
      const copied = JSON.stringify(row);
      for (const leaked of [
        'Call 599',
        '12 34 56',
        '41.709000',
        '44.766000',
        'example.invalid',
        'zzprivatestation',
        '01.14.12.005.017',
        '86420',
        '97531',
        '11300446',
      ]) {
        expect(copied).not.toContain(leaked);
      }
    });

    it('copies only columns the live table has, so a new archive column cannot be silently empty', () => {
      const live = new Set(Object.values(getTableColumns(realEstateListings)).map((c) => c.name));
      const filledAtCopy = ['listing_id', 'implausible', 'archived_at'];
      const copied = Object.values(getTableColumns(realEstateArchiveListings))
        .map((c) => c.name)
        .filter((name) => !filledAtCopy.includes(name));
      expect(copied.filter((name) => !live.has(name))).toEqual([]);
      const liveChanges = new Set(
        Object.values(getTableColumns(realEstatePriceChanges)).map((c) => c.name),
      );
      const copiedChanges = Object.values(getTableColumns(realEstateArchivePriceChanges)).map(
        (c) => c.name,
      );
      expect(copiedChanges.filter((name) => !liveChanges.has(name))).toEqual([]);
    });

    it("marks a poster's typo by the Real estate tab's own rule", async () => {
      const sourceId = await newSource();
      // A flat "for sale" at its monthly rent, and a real one.
      const typo = await listing(sourceId, {
        priceUsd: '462.00',
        areaM2: '60.00',
        status: 'gone',
        goneAt: at(-15),
      });
      const real = await listing(sourceId, {
        priceUsd: '95000.00',
        areaM2: '60.00',
        status: 'gone',
        goneAt: at(-15),
      });

      await deleteLongGoneListings(db, { sourceId, asOf: NOW_ISO });

      const flags = new Map(
        (await archived(sourceId)).map((row) => [row.listingId, row.implausible]),
      );
      expect(flags.get(typo)).toBe(true);
      expect(flags.get(real)).toBe(false);
    });

    it('still deletes a listing the archive already holds, and keeps the copy it had', async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId, {
        sourceListingKey: 'already-archived',
        status: 'gone',
        goneAt: at(-15),
      });
      // As after restoring a dump taken between the copy and a re-run.
      await db.insert(realEstateArchiveListings).values({
        listingId: id,
        sourceId,
        sourceListingKey: 'already-archived',
        dealType: 'sale',
        propertyType: 'flat',
        posterType: 'unknown',
        sourceUpdatedAt: at(-10),
        firstSeenAt: at(-10),
        lastSeenAt: at(-10),
        goneAt: at(-15),
        goneReason: 'the earlier copy',
        implausible: false,
      });

      expect(await deleteLongGoneListings(db, { sourceId, asOf: NOW_ISO })).toBe(1);

      expect(await read(id)).toBeUndefined();
      const rows = await archived(sourceId);
      expect(rows.map((row) => row.goneReason)).toEqual(['the earlier copy']);
    });

    it('leaves another source alone', async () => {
      const sourceId = await newSource();
      const elsewhere = await newSource();
      const theirs = await listing(elsewhere, { status: 'gone', goneAt: at(-30) });

      expect(await deleteLongGoneListings(db, { sourceId, asOf: NOW_ISO })).toBe(0);
      expect(await read(theirs)).toBeDefined();
      expect(await archived(elsewhere)).toEqual([]);
    });
  });

  describe('realestate_archive.recently_gone', () => {
    async function recentlyGone(sourceId: string) {
      return db
        .select()
        .from(realEstateRecentlyGone)
        .where(eq(realEstateRecentlyGone.sourceId, sourceId));
    }

    it('holds the gone listings the archive does not have yet, and together they hold every one', async () => {
      const sourceId = await newSource();
      const longGone = await listing(sourceId, { status: 'gone', goneAt: at(-15) });
      const goneLately = await listing(sourceId, {
        status: 'gone',
        goneAt: at(-2),
        priceUsd: '462.00',
        areaM2: '60.00',
      });
      await listing(sourceId);

      expect((await recentlyGone(sourceId)).map((row) => row.listingId).sort()).toEqual(
        [longGone, goneLately].sort(),
      );

      await deleteLongGoneListings(db, { sourceId, asOf: NOW_ISO });

      const [recent] = await recentlyGone(sourceId);
      expect(recent).toMatchObject({ listingId: goneLately, implausible: true, archivedAt: null });
      const { rows } = await db.execute<{ listing_id: string }>(sql`
        select listing_id from realestate_archive.listings where source_id = ${sourceId}
        union all
        select listing_id from realestate_archive.recently_gone where source_id = ${sourceId}
      `);
      expect(rows.map((row) => row.listing_id).sort()).toEqual([longGone, goneLately].sort());
    });

    it('marks a sale price posted as rent as the tab does, in the view and in the archive', async () => {
      const sourceId = await newSource();
      const rent = { status: 'gone' as const, dealType: 'rent' as const };
      const saleAsRent = await listing(sourceId, {
        ...rent,
        goneAt: at(-2),
        priceUsd: '43000.00',
        areaM2: '25.00',
      });
      const dearRent = await listing(sourceId, {
        ...rent,
        goneAt: at(-2),
        priceUsd: '5200.00',
        areaM2: '120.00',
      });
      const archivedSaleAsRent = await listing(sourceId, {
        ...rent,
        goneAt: at(-15),
        priceUsd: '12000.00',
        areaM2: '35.00',
      });

      await deleteLongGoneListings(db, { sourceId, asOf: NOW_ISO });

      const flags = new Map(
        (await recentlyGone(sourceId)).map((row) => [row.listingId, row.implausible]),
      );
      expect(flags).toEqual(
        new Map([
          [saleAsRent, true],
          [dearRent, false],
        ]),
      );
      expect((await archived(sourceId)).map((row) => [row.listingId, row.implausible])).toEqual([
        [archivedSaleAsRent, true],
      ]);
    });

    it('has the archive’s columns in the archive’s order, so the two can be unioned whole', async () => {
      const { rows } = await db.execute<{ name: string; type: string }>(sql`
        select table_name as name, string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position) as type
        from information_schema.columns
        where table_schema = 'realestate_archive' and table_name in ('listings', 'recently_gone')
        group by table_name
      `);
      const byName = new Map(rows.map((row) => [row.name, row.type]));
      expect(byName.get('recently_gone')).toBe(byName.get('listings'));
      await db.execute(sql`
        select * from realestate_archive.listings union all select * from realestate_archive.recently_gone limit 0
      `);
    });
  });
});
