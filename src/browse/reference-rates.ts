import { sql } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../db/types.js';

/**
 * Reference exchange rates, for grouping and ordering amounts stated in
 * different currencies: a course fee in pounds against one in euros, a
 * tender's dollar estimate against lari (Phase 15, choice H).
 *
 * Never for showing a price: every row prints the amount and currency its
 * source states. A currency missing here is never guessed: its amounts stay
 * out of a range filter (counted as "doesn't state it") and sort last.
 *
 * The National Bank of Georgia's official rates, lari per one unit of each
 * currency: the latest day in `fx_rates` (Phase 17D, kept current after each
 * job pipeline), read with Browse's rows (`loadReferenceRates`). A day's move
 * is a fraction of a percent, too little to shift a filter's buckets in a way
 * a reader would notice.
 */
export interface ReferenceRates {
  /** The day these rates were in force, YYYY-MM-DD; Browse's unit note names it. */
  date: string;
  gelPerUnit: Readonly<Record<string, number>>;
}

/**
 * Committed rates (nbg.gov.ge, read 2026-11-14), used only while `fx_rates`
 * holds no day: a database before migration 0059 or its first sync.
 */
export const COMMITTED_RATES: ReferenceRates = {
  date: '2026-11-14',
  gelPerUnit: {
    GEL: 1,
    EUR: 2.8649,
    USD: 2.5934,
    GBP: 3.4287,
    CHF: 3.0962,
    SEK: 0.25813,
    NOK: 0.27107,
  },
};

/** The amount in lari at the reference rate, or null for a currency not in the table. */
export function toGel(
  amount: number,
  currency: string,
  rates: ReferenceRates = COMMITTED_RATES,
): number | null {
  const rate = rates.gelPerUnit[currency.toUpperCase()];
  return rate === undefined || !Number.isFinite(amount) ? null : amount * rate;
}

/** The amount in euros at the reference rate, or null for a currency not in the table. */
export function toEur(
  amount: number,
  currency: string,
  rates: ReferenceRates = COMMITTED_RATES,
): number | null {
  const gel = toGel(amount, currency, rates);
  const eur = rates.gelPerUnit.EUR;
  return gel === null || eur === undefined ? null : gel / eur;
}

/**
 * Every currency's rate on the latest day `fx_rates` holds up to today in
 * Tbilisi (a stored tomorrow waits for its day), or `COMMITTED_RATES` when it
 * holds none with a euro rate, or cannot be read: the table missing before
 * migration 0059 must not take Browse down with it.
 */
export async function loadReferenceRates(db: DatabaseOrTransaction): Promise<ReferenceRates> {
  let rows: Array<{ day: string; currency: string; gel_per_unit: string }>;
  try {
    ({ rows } = await db.execute<{ day: string; currency: string; gel_per_unit: string }>(sql`
      select day::text as day, currency, gel_per_unit::text as gel_per_unit
        from fx_rates
       where day = (select max(day) from fx_rates
                     where currency = 'EUR'
                       and day <= (now() at time zone 'Asia/Tbilisi')::date)`));
  } catch {
    return COMMITTED_RATES;
  }
  const first = rows[0];
  if (first === undefined) return COMMITTED_RATES;
  const gelPerUnit: Record<string, number> = { GEL: 1 };
  for (const row of rows) {
    const value = Number(row.gel_per_unit);
    if (Number.isFinite(value) && value > 0) gelPerUnit[row.currency] = value;
  }
  return { date: first.day, gelPerUnit };
}
