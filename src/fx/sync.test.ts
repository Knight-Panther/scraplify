import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import type { DatabaseTransaction } from '../db/types.js';
import { addDays, gelPerUnitOn, syncFxRates } from './sync.js';
import { nbgAnswer } from './test-answers.js';

/**
 * The exchange-rate sync (Phase 17D) against a stand-in for NBG, each case in
 * a transaction that is rolled back, so the table is left as it was. The
 * stand-in answers as the real API does (checked 2026-11-17): with the rate in
 * force on the day asked, which for a day after the last one set is that last
 * one.
 */

class RolledBack extends Error {}

async function inRolledBack(work: (tx: DatabaseTransaction) => Promise<void>): Promise<void> {
  await expect(
    db.transaction(async (tx) => {
      // Start from an empty table, whatever this database holds.
      await tx.execute(sql`delete from fx_rates`);
      await work(tx);
      throw new RolledBack();
    }),
  ).rejects.toBeInstanceOf(RolledBack);
}

/** NBG as a list of days a rate took effect; only those already published are answered. */
function fakeNbg(published: string[], options: { failOn?: string; aheadOn?: string } = {}) {
  const asked: string[] = [];
  const fetchJson = async (url: string) => {
    const day = new URL(url).searchParams.get('date') as string;
    asked.push(day);
    if (day === options.failOn) throw new Error('NBG answered 503');
    const validFrom =
      day === options.aheadOn
        ? addDays(day, 1)
        : published
            .filter((set) => set <= day)
            .sort()
            .at(-1);
    if (!validFrom) throw new Error(`no rate before ${day}`);
    // Distinct, plausible rates per day, so a wrong day shows.
    const usd = 2.6 + Number(validFrom.slice(8, 10)) / 1000;
    return nbgAnswer(validFrom, [
      { code: 'USD', rate: usd },
      { code: 'JPY', rate: 1.75, quantity: 100 },
    ]);
  };
  return { fetchJson, asked };
}

async function storedDays(tx: DatabaseTransaction, currency = 'USD') {
  const { rows } = await tx.execute<{ day: string; valid_from: string; gel_per_unit: string }>(
    sql`select day::text, valid_from::text, gel_per_unit::text from fx_rates
         where currency = ${currency} order by day`,
  );
  return rows;
}

// 2026-01-01 is a Thursday. Rates set for Thu 1st, Fri 2nd, Sat 3rd (held to
// Monday the 5th), then Tue 6th, which is published on Monday evening.
const SET_DAYS = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-06'];
const SUNDAY_NOON = '2026-01-04T08:00:00.000Z'; // 12:00 Tbilisi
const MONDAY_EVENING = '2026-01-05T15:00:00.000Z'; // 19:00 Tbilisi

describe('syncFxRates', () => {
  it('back-fills from the first day to today, one row per day, carrying the weekend', async () => {
    await inRolledBack(async (tx) => {
      const nbg = fakeNbg(SET_DAYS.slice(0, 3));
      const result = await syncFxRates(tx, { fetchJson: nbg.fetchJson, now: SUNDAY_NOON });

      expect(result).toMatchObject({
        ok: true,
        firstDay: '2026-01-01',
        lastDay: '2026-01-05',
        requests: 5,
        daysStored: 4,
        rowsInserted: 8,
        lastStoredDay: '2026-01-04',
      });
      // Monday (tomorrow) answers with Saturday's rate: not settled, not stored.
      expect(nbg.asked).toEqual([
        '2026-01-01',
        '2026-01-02',
        '2026-01-03',
        '2026-01-04',
        '2026-01-05',
      ]);
      expect((await storedDays(tx)).map((row) => [row.day, row.valid_from])).toEqual([
        ['2026-01-01', '2026-01-01'],
        ['2026-01-02', '2026-01-02'],
        ['2026-01-03', '2026-01-03'],
        ['2026-01-04', '2026-01-03'],
      ]);
    });
  });

  it('carries on from the last stored day and stores tomorrow once NBG has set it', async () => {
    await inRolledBack(async (tx) => {
      await syncFxRates(tx, {
        fetchJson: fakeNbg(SET_DAYS.slice(0, 3)).fetchJson,
        now: SUNDAY_NOON,
      });

      const nbg = fakeNbg(SET_DAYS);
      const result = await syncFxRates(tx, { fetchJson: nbg.fetchJson, now: MONDAY_EVENING });
      expect(nbg.asked).toEqual(['2026-01-05', '2026-01-06']);
      expect(result).toMatchObject({ ok: true, daysStored: 2, lastStoredDay: '2026-01-06' });
      expect((await storedDays(tx)).slice(-2).map((row) => [row.day, row.valid_from])).toEqual([
        ['2026-01-05', '2026-01-03'],
        ['2026-01-06', '2026-01-06'],
      ]);

      // Nothing is due any more until the day after tomorrow: no request at all.
      const again = fakeNbg(SET_DAYS);
      const idle = await syncFxRates(tx, { fetchJson: again.fetchJson, now: MONDAY_EVENING });
      expect(again.asked).toEqual([]);
      expect(idle).toMatchObject({ ok: true, requests: 0, firstDay: null, daysStored: 0 });
    });
  });

  it('keeps stored days as they are when asked to re-check from an earlier day', async () => {
    await inRolledBack(async (tx) => {
      await syncFxRates(tx, { fetchJson: fakeNbg(SET_DAYS).fetchJson, now: MONDAY_EVENING });
      const before = await storedDays(tx);
      const result = await syncFxRates(tx, {
        fetchJson: fakeNbg(SET_DAYS).fetchJson,
        now: MONDAY_EVENING,
        from: '2026-01-02',
      });
      expect(result).toMatchObject({ ok: true, requests: 5, daysStored: 5, rowsInserted: 0 });
      expect(await storedDays(tx)).toEqual(before);
    });
  });

  it('stops at a failed request, an answer from a later day, or the request cap, keeping what it stored', async () => {
    await inRolledBack(async (tx) => {
      const failed = await syncFxRates(tx, {
        fetchJson: fakeNbg(SET_DAYS, { failOn: '2026-01-03' }).fetchJson,
        now: MONDAY_EVENING,
      });
      expect(failed).toMatchObject({ ok: false, daysStored: 2, lastStoredDay: '2026-01-02' });
      expect(failed.error).toBe('2026-01-03: NBG answered 503');

      const ahead = await syncFxRates(tx, {
        fetchJson: fakeNbg(SET_DAYS, { aheadOn: '2026-01-04' }).fetchJson,
        now: MONDAY_EVENING,
      });
      expect(ahead).toMatchObject({ ok: false, daysStored: 1, lastStoredDay: '2026-01-03' });
      expect(ahead.error).toBe("2026-01-04: USD's rate is valid only from 2026-01-05");

      const capped = await syncFxRates(tx, {
        fetchJson: fakeNbg(SET_DAYS).fetchJson,
        now: MONDAY_EVENING,
        maxRequests: 1,
      });
      expect(capped).toMatchObject({ ok: false, requests: 1, lastStoredDay: '2026-01-04' });
      expect(capped.error).toBe('stopped after 1 requests, before 2026-01-05');
    });
  });

  it('waits between requests', async () => {
    await inRolledBack(async (tx) => {
      const waits: number[] = [];
      await syncFxRates(tx, {
        fetchJson: fakeNbg(SET_DAYS).fetchJson,
        now: SUNDAY_NOON,
        delayMs: 1000,
        sleep: async (ms) => {
          waits.push(ms);
        },
      });
      expect(waits).toEqual([1000, 1000, 1000, 1000]);
    });
  });
});

describe('gelPerUnitOn', () => {
  it('reads the day’s rate per one unit, 1 for lari, null for a day not stored', async () => {
    await inRolledBack(async (tx) => {
      await syncFxRates(tx, { fetchJson: fakeNbg(SET_DAYS).fetchJson, now: MONDAY_EVENING });
      expect(await gelPerUnitOn(tx, 'usd', '2026-01-05')).toBeCloseTo(2.603, 10);
      expect(await gelPerUnitOn(tx, 'JPY', '2026-01-05')).toBeCloseTo(0.0175, 10);
      expect(await gelPerUnitOn(tx, 'GEL', '2030-01-01')).toBe(1);
      expect(await gelPerUnitOn(tx, 'USD', '2026-01-07')).toBeNull();
    });
  });
});
