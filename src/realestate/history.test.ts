import { and, asc, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  type NewRealEstateListingRow,
  realEstateArchiveListingPrivate,
  realEstateArchiveListings,
  realEstateDailyTotals,
  realEstateHistorySteps,
  realEstateListingGroupDays,
  realEstateListings,
  realEstateListingVersions,
  realEstatePublicListings,
  realEstateShowSpells,
} from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import { deleteLongGoneListings, GONE_RETENTION_DAYS } from './expiry.js';
import { conditions, implausibleValues } from './filters.js';
import {
  COPIED_COLUMNS,
  FILLED_BY_THE_STEP,
  HASHED_COLUMNS,
  recordListingHistory,
  UNHASHED_COLUMNS,
} from './history.js';
import { takeDailyTotals, tbilisiDay } from './totals.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Each night's history step, at the hour the totals are taken (13:30 UTC). */
const NIGHT = (n: number) =>
  new Date(Date.parse('2026-12-01T13:30:00.000Z') + n * DAY_MS).toISOString();
const at = (days: number) => new Date(Date.parse(NIGHT(0)) + days * DAY_MS).toISOString();
/** Timestamps come back in Postgres's own text form; compare the instants. */
const instant = (value: string | null | undefined) =>
  value === null || value === undefined ? null : new Date(value).getTime();

describe('listing history (Phase 17A)', () => {
  const sourceIds: string[] = [];
  let nextKey = 1;

  async function newSource(): Promise<string> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    return sourceId;
  }

  /** A two-room flat for sale, priced in dollars, on show at night 0 and for a month after. */
  async function listing(sourceId: string, overrides: Partial<NewRealEstateListingRow> = {}) {
    const key = `h${nextKey++}`;
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
        currencyPosted: 'usd',
        priceUsd: '100000.00',
        priceGel: '270000.00',
        pricePerM2Usd: '1666.67',
        pricePerM2Gel: '4500.00',
        cityRef: 95,
        cityName: 'თბილისი',
        subdistrictRef: 3,
        subdistrictName: 'საბურთალო',
        streetName: 'უნივერსიტეტის ქ.',
        streetNumber: '12',
        sourceCreatedAt: at(-3),
        sourceUpdatedAt: at(-3),
        expectedEndAt: at(30),
        firstSeenAt: at(-3),
        lastSeenAt: at(-0.1),
        contentHash: 'h',
        ...overrides,
      })
      .returning({ id: realEstateListings.id });
    if (row === undefined) throw new Error('listing was not inserted');
    return row.id;
  }

  const update = (id: string, set: Partial<NewRealEstateListingRow>) =>
    db.update(realEstateListings).set(set).where(eq(realEstateListings.id, id));

  const step = (sourceId: string, now: string) =>
    recordListingHistory(db, { sourceId, now, crawlRunId: null });

  const versionsOf = (id: string) =>
    db
      .select()
      .from(realEstateListingVersions)
      .where(eq(realEstateListingVersions.listingId, id))
      .orderBy(asc(realEstateListingVersions.validFrom));

  const spellsOf = (id: string) =>
    db
      .select()
      .from(realEstateShowSpells)
      .where(eq(realEstateShowSpells.listingId, id))
      .orderBy(asc(realEstateShowSpells.shownFrom));

  const openSpellIds = async (sourceId: string) =>
    (
      await db
        .select({ id: realEstateShowSpells.listingId })
        .from(realEstateShowSpells)
        .where(
          and(eq(realEstateShowSpells.sourceId, sourceId), isNull(realEstateShowSpells.shownUntil)),
        )
    )
      .map((row) => row.id)
      .sort();

  afterEach(async () => {
    await db
      .delete(realEstateDailyTotals)
      .where(eq(realEstateDailyTotals.day, tbilisiDay(NIGHT(0))));
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  describe('the fields', () => {
    it('keeps every version column as hashed, deliberately unhashed, or the step’s own', () => {
      const all = Object.values(getTableColumns(realEstateListingVersions)).map((c) => c.name);
      const sorted = [...HASHED_COLUMNS, ...UNHASHED_COLUMNS, ...FILLED_BY_THE_STEP].sort();
      expect(all.sort()).toEqual(sorted);
      expect(new Set(sorted).size).toBe(sorted.length);
    });

    it('copies only columns the live table has', () => {
      const live = new Set(Object.values(getTableColumns(realEstateListings)).map((c) => c.name));
      expect(COPIED_COLUMNS.filter((name) => !live.has(name))).toEqual([]);
    });

    it('leaves the converted prices and the nightly location judgement out of the hash', () => {
      const hashed = new Set<string>(HASHED_COLUMNS);
      for (const derived of [
        'price_usd',
        'price_gel',
        'price_per_m2_usd',
        'price_per_m2_gel',
        'official_district_ref',
        'metro_station',
        'metro_nearby',
        'building_key',
        'location_precision',
        'location_rules',
        'district_inferred',
        'house_number',
      ]) {
        expect(hashed.has(derived)).toBe(false);
      }
    });
  });

  describe('versions', () => {
    it('opens an approximate first version, from when it was first seen, for every live row on the first night', async () => {
      const sourceId = await newSource();
      const usd = await listing(sourceId);
      const gel = await listing(sourceId, {
        currencyPosted: 'gel',
        priceGel: '1500.00',
        priceUsd: '555.56',
        dealType: 'rent',
        firstSeenAt: at(-40),
      });
      const gone = await listing(sourceId, {
        status: 'gone',
        goneAt: at(-2),
        goneReason: 'expired',
      });

      const result = await step(sourceId, NIGHT(0));

      expect(result).toMatchObject({ ok: true, versionsOpened: 3, versionsClosed: 0, error: null });
      const [first] = await versionsOf(usd);
      expect(first).toMatchObject({
        approximate: true,
        validTo: null,
        currencyPosted: 'usd',
        pricePosted: '100000.00',
        priceUsd: '100000.00',
        priceGel: '270000.00',
        rooms: 2,
        status: 'active',
        streetNumber: '12',
      });
      expect(instant(first?.validFrom)).toBe(instant(at(-3)));
      const [rent] = await versionsOf(gel);
      expect(rent).toMatchObject({ pricePosted: '1500.00', dealType: 'rent' });
      expect(instant(rent?.validFrom)).toBe(instant(at(-40)));
      expect((await versionsOf(gone))[0]).toMatchObject({ status: 'gone', approximate: true });
    });

    it('gives a raw-field change exactly one new version, closing the old one at the step’s instant', async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId);
      await step(sourceId, NIGHT(0));

      await update(id, { rooms: 3 });
      const result = await step(sourceId, NIGHT(1));

      expect(result).toMatchObject({ versionsOpened: 1, versionsClosed: 1 });
      const [old, current] = await versionsOf(id);
      expect(old).toMatchObject({ rooms: 2 });
      expect(instant(old?.validTo)).toBe(instant(NIGHT(1)));
      expect(current).toMatchObject({ rooms: 3, validTo: null, approximate: false });
      expect(instant(current?.validFrom)).toBe(instant(NIGHT(1)));
    });

    it('gives a new posted price one version, whichever currency it was posted in', async () => {
      const sourceId = await newSource();
      const usd = await listing(sourceId);
      const gel = await listing(sourceId, { currencyPosted: 'gel' });
      await step(sourceId, NIGHT(0));

      await update(usd, { priceUsd: '95000.00', priceGel: '256500.00' });
      await update(gel, { priceGel: '260000.00', priceUsd: '96296.30' });

      expect(await step(sourceId, NIGHT(1))).toMatchObject({
        versionsOpened: 2,
        versionsClosed: 2,
      });
      expect((await versionsOf(usd)).map((v) => v.pricePosted)).toEqual(['100000.00', '95000.00']);
      expect((await versionsOf(gel)).map((v) => v.pricePosted)).toEqual(['270000.00', '260000.00']);
    });

    it('gives a conversion-only change, or a new location judgement, no version', async () => {
      const sourceId = await newSource();
      const usd = await listing(sourceId);
      const gel = await listing(sourceId, { currencyPosted: 'gel' });
      await step(sourceId, NIGHT(0));

      // The day's rate moved the converted price and both prices per m².
      await update(usd, { priceGel: '268000.00', pricePerM2Gel: '4466.67' });
      await update(gel, { priceUsd: '101000.00', pricePerM2Usd: '1683.33' });
      // The nightly judgement placed both, under new rules.
      for (const id of [usd, gel]) {
        await update(id, {
          officialDistrictRef: 11300449,
          officialDistrictBasis: 'street',
          locationPrecision: 'house',
          metroStation: 'medical_uni',
          metroMinutes: 10,
          metroBasis: 'street',
          metroNearby: ['medical_uni'],
          metroNearbyMinutes: [10],
          buildingKey: 's1-12',
          locationRules: 2,
          districtInferred: true,
          houseNumber: 12,
        });
      }

      expect(await step(sourceId, NIGHT(1))).toMatchObject({
        ok: true,
        versionsOpened: 0,
        versionsClosed: 0,
      });
      expect(await versionsOf(usd)).toHaveLength(1);
      expect(await versionsOf(gel)).toHaveLength(1);
    });

    it('writes nothing on an unchanged night, nor when run again at the same instant', async () => {
      const sourceId = await newSource();
      await listing(sourceId);
      await listing(sourceId, { groupKey: 'h-group' });
      await listing(sourceId, { groupKey: 'h-group', expectedEndAt: at(-1), lastSeenAt: at(-2) });
      await step(sourceId, NIGHT(0));

      const nothing = {
        ok: true,
        versionsOpened: 0,
        versionsClosed: 0,
        spellsOpened: 0,
        spellsClosed: 0,
        groupDays: 0,
      };
      expect(await step(sourceId, NIGHT(0))).toMatchObject(nothing);
      const nextNight = await step(sourceId, NIGHT(1));
      expect(nextNight).toMatchObject({ ...nothing, groupDays: 2 });
      expect(await step(sourceId, NIGHT(1))).toMatchObject(nothing);
    });

    it('hashes the same in every session time zone', async () => {
      const sourceId = await newSource();
      await listing(sourceId, { sourceCreatedAt: '2026-11-20T23:30:00.000Z' });
      await step(sourceId, NIGHT(0));

      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`set local timezone = 'Asia/Tbilisi'`);
        await tx.execute(sql`set local datestyle = 'SQL, DMY'`);
        return recordListingHistory(tx, { sourceId, now: NIGHT(1), crawlRunId: null });
      });

      expect(result).toMatchObject({ ok: true, versionsOpened: 0, versionsClosed: 0 });
    });
  });

  describe('spells on show', () => {
    it('gives hide, show, hide two spells, opened and closed at the steps’ instants', async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId, { expectedEndAt: at(0.5), lastSeenAt: at(-0.1) });
      await step(sourceId, NIGHT(0));
      // Its expected end passes before the next night: off the tab.
      await step(sourceId, NIGHT(1));
      // A list shows it again, and its end moves on.
      await update(id, { lastSeenAt: at(1.9), expectedEndAt: at(4.5) });
      await step(sourceId, NIGHT(2));
      // Its page says it is gone.
      await update(id, { status: 'gone', goneAt: at(3), goneReason: 'removed' });
      await step(sourceId, NIGHT(3));

      const spells = await spellsOf(id);
      expect(spells.map((s) => [instant(s.shownFrom), instant(s.shownUntil)])).toEqual([
        [instant(NIGHT(0)), instant(NIGHT(1))],
        [instant(NIGHT(2)), instant(NIGHT(3))],
      ]);
      // Status moved, so it has a version for its time gone too.
      expect((await versionsOf(id)).map((v) => v.status)).toEqual(['active', 'gone']);
    });

    it('holds exactly the listings the night’s totals count, judged at the same instant', async () => {
      const sourceId = await newSource();
      for (const price of [100_000, 110_000, 120_000, 130_000, 140_000]) {
        await listing(sourceId, { priceUsd: String(price) });
      }
      // A poster's typo: on show, so a spell, but not in the totals.
      await listing(sourceId, { priceUsd: '462.00', pricePerM2Usd: '7.70' });
      // Past its end: not on show.
      await listing(sourceId, { expectedEndAt: at(-1), lastSeenAt: at(-2) });
      // No end, seen lately: on show by its last sighting.
      await listing(sourceId, { expectedEndAt: null, lastSeenAt: at(0.01) });
      // Gone.
      await listing(sourceId, { status: 'gone', goneAt: at(-1) });

      const now = NIGHT(0);
      await step(sourceId, now);
      await takeDailyTotals(db, { sourceId, now, crawlRunId: null });

      const onShow = (
        await db
          .select({ id: realEstatePublicListings.id })
          .from(realEstatePublicListings)
          .where(conditions({ sourceId }, now))
      )
        .map((row) => row.id)
        .sort();
      expect(await openSpellIds(sourceId)).toEqual(onShow);
      expect(onShow).toHaveLength(7);

      const typos = await db
        .select({ id: realEstatePublicListings.id })
        .from(realEstatePublicListings)
        .where(and(conditions({ sourceId }, now), implausibleValues));
      const [all] = await db
        .select()
        .from(realEstateDailyTotals)
        .where(
          and(
            eq(realEstateDailyTotals.day, tbilisiDay(now)),
            eq(realEstateDailyTotals.areaLevel, 'all'),
            eq(realEstateDailyTotals.roomsBand, 'all'),
            eq(realEstateDailyTotals.dealType, 'sale'),
            eq(realEstateDailyTotals.propertyType, 'flat'),
          ),
        );
      expect(all?.posts).toBe(onShow.length - typos.length);
    });

    it('records the group a spell opened in, and every night’s group', async () => {
      const sourceId = await newSource();
      const id = await listing(sourceId, { groupKey: 'h-g1' });
      await step(sourceId, NIGHT(0));
      await step(sourceId, NIGHT(1));
      await update(id, { groupKey: 'h-g2' });
      await step(sourceId, NIGHT(2));

      expect((await spellsOf(id)).map((s) => s.groupKey)).toEqual(['h-g1']);
      const days = await db
        .select()
        .from(realEstateListingGroupDays)
        .where(eq(realEstateListingGroupDays.listingId, id))
        .orderBy(asc(realEstateListingGroupDays.firstDay));
      expect(days.map((d) => [d.groupKey, d.firstDay, d.lastDay, d.nights])).toEqual([
        ['h-g1', tbilisiDay(NIGHT(0)), tbilisiDay(NIGHT(1)), 2],
        ['h-g2', tbilisiDay(NIGHT(2)), tbilisiDay(NIGHT(2)), 1],
      ]);
    });
  });

  describe('a night that fails or is skipped', () => {
    it('is recorded as failed, writes nothing, and the next night heals it', async () => {
      const sourceId = await newSource();
      const changed = await listing(sourceId);
      const hidden = await listing(sourceId);
      await step(sourceId, NIGHT(0));

      await update(changed, { rooms: 4 });
      await update(hidden, { expectedEndAt: at(0.5), lastSeenAt: at(0.2) });
      // First seen before the failed night's step, which never recorded it.
      const unseen = await listing(sourceId, { firstSeenAt: at(0.8), lastSeenAt: at(0.8) });

      const failing = Object.assign(Object.create(db), {
        transaction: () => Promise.reject(new Error('the database went away')),
      }) as typeof db;
      const failed = await recordListingHistory(failing, {
        sourceId,
        now: NIGHT(1),
        crawlRunId: null,
      });
      expect(failed).toMatchObject({ ok: false, versionsOpened: 0 });
      expect(failed.error).toContain('the database went away');
      const steps = await db
        .select()
        .from(realEstateHistorySteps)
        .where(eq(realEstateHistorySteps.sourceId, sourceId))
        .orderBy(asc(realEstateHistorySteps.takenAt));
      expect(steps.map((s) => s.ok)).toEqual([true, false]);
      expect(steps[1]?.error).toContain('the database went away');
      expect(await versionsOf(unseen)).toEqual([]);

      // First seen after the failed attempt: its first version is exact.
      const fresh = await listing(sourceId, { firstSeenAt: at(1.5), lastSeenAt: at(1.5) });
      const healed = await step(sourceId, NIGHT(2));

      expect(healed).toMatchObject({ ok: true, versionsOpened: 3, versionsClosed: 1 });
      expect((await versionsOf(changed)).map((v) => v.rooms)).toEqual([2, 4]);
      expect(instant((await versionsOf(changed))[1]?.validFrom)).toBe(instant(NIGHT(2)));
      const [unseenFirst] = await versionsOf(unseen);
      expect(unseenFirst?.approximate).toBe(true);
      expect(instant(unseenFirst?.validFrom)).toBe(instant(at(0.8)));
      expect((await versionsOf(fresh))[0]?.approximate).toBe(false);
      expect(instant((await spellsOf(hidden))[0]?.shownUntil)).toBe(instant(NIGHT(2)));
    });

    it('refuses an instant before the last step’s, and records why', async () => {
      const sourceId = await newSource();
      await listing(sourceId);
      await step(sourceId, NIGHT(1));

      const result = await step(sourceId, NIGHT(0));

      expect(result.ok).toBe(false);
      expect(result.error).toContain('before the last step');
    });
  });

  describe('the archive copy', () => {
    it('keeps the pin, the whole description and the cadastral code privately, the listing’s dates, and closes its history', async () => {
      const sourceId = await newSource();
      const description = 'ბინა ვაკეში. დარეკეთ 599 12 34 56 ან mail@example.invalid';
      const id = await listing(sourceId, {
        latitude: '41.709000',
        longitude: '44.766000',
        pinManual: true,
        description,
        cadastralCode: '01.14.12.005.017',
        sourceCreatedAt: at(-3),
      });
      // On show, and archived without a later step: its spell is still open then.
      const unstepped = await listing(sourceId);
      await step(sourceId, NIGHT(0));
      // A renewal moved ss.ge's own posting date; then it went.
      await update(id, {
        sourceCreatedAt: at(0.5),
        status: 'gone',
        goneAt: at(0.6),
        goneReason: 'removed',
        verifiedAt: at(0.6),
        expectedEndAt: at(20),
      });
      await step(sourceId, NIGHT(1));
      await update(unstepped, { status: 'gone', goneAt: at(1.2), goneReason: 'lapsed' });

      const asOf = at(1.2 + GONE_RETENTION_DAYS + 1);
      expect(await deleteLongGoneListings(db, { sourceId, asOf })).toBe(2);

      const [archived] = await db
        .select()
        .from(realEstateArchiveListings)
        .where(eq(realEstateArchiveListings.listingId, id));
      expect(instant(archived?.expectedEndAt)).toBe(instant(at(20)));
      expect(instant(archived?.verifiedAt)).toBe(instant(at(0.6)));
      expect(instant(archived?.sourceCreatedAt)).toBe(instant(at(0.5)));
      expect(instant(archived?.firstSourceCreatedAt)).toBe(instant(at(-3)));
      // The public archive row still holds none of it.
      const publicRow = JSON.stringify(archived);
      for (const leaked of ['599 12 34 56', '41.709000', '44.766000', '01.14.12.005.017']) {
        expect(publicRow).not.toContain(leaked);
      }

      const [kept] = await db
        .select()
        .from(realEstateArchiveListingPrivate)
        .where(eq(realEstateArchiveListingPrivate.listingId, id));
      expect(kept).toEqual({
        listingId: id,
        latitude: '41.709000',
        longitude: '44.766000',
        pinManual: true,
        description,
        cadastralCode: '01.14.12.005.017',
      });

      const versions = await versionsOf(id);
      expect(versions.map((v) => v.status)).toEqual(['active', 'gone']);
      expect(instant(versions[1]?.validTo)).toBe(instant(asOf));
      expect(instant((await versionsOf(unstepped))[0]?.validTo)).toBe(instant(asOf));
      expect(instant((await spellsOf(unstepped))[0]?.shownUntil)).toBe(instant(asOf));
      expect(instant((await spellsOf(id))[0]?.shownUntil)).toBe(instant(NIGHT(1)));

      // The next step finds nothing left open for them.
      expect(await step(sourceId, NIGHT(17))).toMatchObject({
        ok: true,
        versionsClosed: 0,
        spellsClosed: 0,
      });
    });

    it('keeps recently_gone in the archive’s columns and order, with the earliest posting time', async () => {
      const { rows } = await db.execute<{ same: boolean }>(sql`
        select (select array_agg(attname::text order by attnum) from pg_attribute
                 where attrelid = 'realestate_archive.recently_gone'::regclass and attnum > 0)
             = (select array_agg(attname::text order by attnum) from pg_attribute
                 where attrelid = 'realestate_archive.listings'::regclass and attnum > 0
                   and not attisdropped) as same`);
      expect(rows[0]?.same).toBe(true);

      const sourceId = await newSource();
      const archived = await listing(sourceId, { status: 'gone', goneAt: at(-20) });
      const recent = await listing(sourceId, { sourceCreatedAt: at(-3) });
      await step(sourceId, NIGHT(0));
      await update(recent, { sourceCreatedAt: at(0.5), status: 'gone', goneAt: at(0.6) });
      await deleteLongGoneListings(db, { sourceId, asOf: NIGHT(0) });

      const union = await db.execute<{ listing_id: string; first_source_created_at: string }>(sql`
        select * from realestate_archive.listings where source_id = ${sourceId}
        union all
        select * from realestate_archive.recently_gone where source_id = ${sourceId}`);
      const byId = new Map(union.rows.map((row) => [row.listing_id, row]));
      expect([...byId.keys()].sort()).toEqual([archived, recent].sort());
      expect(instant(byId.get(recent)?.first_source_created_at)).toBe(instant(at(-3)));
    });
  });
});
