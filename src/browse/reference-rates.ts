/**
 * Reference exchange rates, for grouping and ordering amounts stated in
 * different currencies: a course fee in pounds against one in euros, a
 * tender's dollar estimate against lari (Phase 15, choice H).
 *
 * Never for showing a price: every row prints the amount and currency its
 * source states. A currency missing here is never guessed: its amounts stay
 * out of a range filter (counted as "doesn't state it") and sort last.
 *
 * The official rates of the National Bank of Georgia valid on RATES_DATE,
 * lari per one unit of each currency (nbg.gov.ge, read 2026-11-14). They are
 * committed, not fetched: a filter's buckets should not move under a reader
 * from one day to the next. Refresh them now and then, with the date.
 */
export const RATES_DATE = '2026-11-14';

const GEL_PER_UNIT: Readonly<Record<string, number>> = {
  GEL: 1,
  EUR: 2.8649,
  USD: 2.5934,
  GBP: 3.4287,
  CHF: 3.0962,
  SEK: 0.25813,
  NOK: 0.27107,
};

/** The amount in lari at the reference rate, or null for a currency not in the table. */
export function toGel(amount: number, currency: string): number | null {
  const rate = GEL_PER_UNIT[currency.toUpperCase()];
  return rate === undefined || !Number.isFinite(amount) ? null : amount * rate;
}

/** The amount in euros at the reference rate, or null for a currency not in the table. */
export function toEur(amount: number, currency: string): number | null {
  const gel = toGel(amount, currency);
  const eur = GEL_PER_UNIT.EUR;
  return gel === null || eur === undefined ? null : gel / eur;
}
