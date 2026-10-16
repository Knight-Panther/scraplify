import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  type NewRealEstateListingRow,
  realEstateListings,
  realEstatePriceChanges,
} from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import {
  deleteLongGoneListings,
  loadListingsDueForCheck,
  markLapsedListingsGone,
  recordListingCheck,
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

  describe('recordListingCheck', () => {
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

  describe('deleteLongGoneListings', () => {
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

    it('leaves another source alone', async () => {
      const sourceId = await newSource();
      const elsewhere = await newSource();
      const theirs = await listing(elsewhere, { status: 'gone', goneAt: at(-30) });

      expect(await deleteLongGoneListings(db, { sourceId, asOf: NOW_ISO })).toBe(0);
      expect(await read(theirs)).toBeDefined();
    });
  });
});
