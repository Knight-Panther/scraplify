import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import type { DatabaseTransaction } from '../db/types.js';
import { COMMITTED_RATES, loadReferenceRates, toEur, toGel } from './reference-rates.js';

describe('reference rates', () => {
  it('are dated', () => {
    expect(COMMITTED_RATES.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('convert through lari, whatever the case of the code', () => {
    expect(toGel(100, 'GEL')).toBe(100);
    expect(toEur(100, 'EUR')).toBeCloseTo(100, 6);
    expect(toEur(100, 'gbp')).toBeCloseTo((100 * 3.4287) / 2.8649, 6);
    expect(toGel(10, 'NOK')).toBeCloseTo(2.7107, 6);
  });

  it('never guess a currency they do not hold', () => {
    expect(toGel(100, 'PLN')).toBeNull();
    expect(toEur(100, 'XYZ')).toBeNull();
    expect(toGel(Number.NaN, 'EUR')).toBeNull();
  });

  it('convert with the rates they are given', () => {
    const rates = { date: '2026-12-01', gelPerUnit: { GEL: 1, EUR: 3, PLN: 0.7 } };
    expect(toGel(100, 'pln', rates)).toBeCloseTo(70, 6);
    expect(toEur(90, 'GEL', rates)).toBeCloseTo(30, 6);
    expect(toGel(100, 'USD', rates)).toBeNull();
  });
});

class RolledBack extends Error {}

async function inRolledBack(work: (tx: DatabaseTransaction) => Promise<void>): Promise<void> {
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`delete from fx_rates`);
      await work(tx);
      throw new RolledBack();
    }),
  ).rejects.toBeInstanceOf(RolledBack);
}

const insertRate = (tx: DatabaseTransaction, currency: string, day: string, gelPerUnit: number) =>
  tx.execute(sql`insert into fx_rates (currency, day, valid_from, quantity, rate, gel_per_unit)
                 values (${currency}, ${day}::date, ${day}::date, 1, ${gelPerUnit}, ${gelPerUnit})`);

describe('loadReferenceRates', () => {
  it('falls back to the committed rates while fx_rates holds no day', async () => {
    await inRolledBack(async (tx) => {
      expect(await loadReferenceRates(tx)).toEqual(COMMITTED_RATES);
    });
  });

  it('reads every currency of the latest day up to today, never a stored tomorrow', async () => {
    await inRolledBack(async (tx) => {
      const { rows } = await tx.execute<{ today: string; tomorrow: string; before: string }>(sql`
        select (now() at time zone 'Asia/Tbilisi')::date::text as today,
               ((now() at time zone 'Asia/Tbilisi')::date + 1)::text as tomorrow,
               ((now() at time zone 'Asia/Tbilisi')::date - 3)::text as before`);
      const { today, tomorrow, before } = rows[0] as {
        today: string;
        tomorrow: string;
        before: string;
      };
      await insertRate(tx, 'EUR', before, 2.9);
      await insertRate(tx, 'EUR', today, 3.0);
      await insertRate(tx, 'PLN', today, 0.7);
      await insertRate(tx, 'EUR', tomorrow, 3.1);

      const rates = await loadReferenceRates(tx);
      expect(rates.date).toBe(today);
      expect(rates.gelPerUnit).toEqual({ GEL: 1, EUR: 3, PLN: 0.7 });
      expect(toEur(100, 'PLN', rates)).toBeCloseTo(70 / 3, 6);
    });
  });
});
