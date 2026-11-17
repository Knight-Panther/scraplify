import { sql } from 'drizzle-orm';
import { fxRates } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import { tbilisiDay } from '../realestate/totals.js';
import { type FetchJson, nbgDayUrl, parseNbgAnswer } from './nbg.js';

/** The first day kept: the start of the year the history begins in (Phase 17D). */
export const FX_FIRST_DAY = '2026-01-01';

/** Requests in one sync at most: a year and a bit, so a back-fill fits and a runaway loop cannot. */
export const FX_MAX_REQUESTS = 400;

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export interface FxSyncOptions {
  fetchJson: FetchJson;
  /** Now, as an ISO instant; its Tbilisi date is "today". */
  now: string;
  /** Re-check from this day (rows already stored are kept as they are); default: the day after the last one stored. */
  from?: string | undefined;
  /** Wait between requests. */
  delayMs?: number;
  maxRequests?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FxSyncResult {
  ok: boolean;
  /** The first and last day asked, or null when nothing was due. */
  firstDay: string | null;
  lastDay: string | null;
  requests: number;
  daysStored: number;
  rowsInserted: number;
  /** Currencies an answer held in a shape not understood, by code ('?' when it had none). */
  skippedCurrencies: string[];
  /** The last day stored for USD after the sync, the one every statistic needs. */
  lastStoredDay: string | null;
  error?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function lastStoredDay(
  database: DatabaseOrTransaction,
  currency = 'USD',
): Promise<string | null> {
  const { rows } = await database.execute<{ day: string | null }>(
    sql`select max(${fxRates.day})::text as day from ${fxRates} where ${fxRates.currency} = ${currency}`,
  );
  return rows[0]?.day ?? null;
}

/**
 * Stores NBG's rates for every day from where the table ends (or `from`) up
 * to tomorrow in Tbilisi, one request a day, each day written as soon as it
 * is read so an interrupted back-fill keeps what it got.
 *
 * A day is stored only once settled: today or earlier, or a later day NBG has
 * already set its own rate for. Tomorrow is settled from about 17:00 Tbilisi
 * on a working day; asked earlier, NBG answers with today's rate, and the
 * sync stops there for the next run to finish.
 *
 * A failed request or an answer it cannot read ends the sync with `ok`
 * false and the error; what was stored before stays.
 */
export async function syncFxRates(
  database: DatabaseOrTransaction,
  options: FxSyncOptions,
): Promise<FxSyncResult> {
  const today = tbilisiDay(options.now);
  const until = addDays(today, 1);
  const stored = await lastStoredDay(database);
  const start = options.from ?? (stored ? addDays(stored, 1) : FX_FIRST_DAY);
  const maxRequests = options.maxRequests ?? FX_MAX_REQUESTS;
  const sleep = options.sleep ?? defaultSleep;

  const result: FxSyncResult = {
    ok: true,
    firstDay: null,
    lastDay: null,
    requests: 0,
    daysStored: 0,
    rowsInserted: 0,
    skippedCurrencies: [],
    lastStoredDay: stored,
  };

  for (let day = start; day <= until; day = addDays(day, 1)) {
    if (result.requests >= maxRequests) {
      result.ok = false;
      result.error = `stopped after ${maxRequests} requests, before ${day}`;
      break;
    }
    if (result.requests > 0 && options.delayMs) await sleep(options.delayMs);
    result.firstDay ??= day;
    result.lastDay = day;
    result.requests += 1;

    let rates: ReturnType<typeof parseNbgAnswer>['rates'];
    try {
      const parsed = parseNbgAnswer(await options.fetchJson(nbgDayUrl(day)));
      rates = parsed.rates;
      for (const code of parsed.skipped) {
        if (!result.skippedCurrencies.includes(code)) result.skippedCurrencies.push(code);
      }
    } catch (err) {
      result.ok = false;
      result.error = `${day}: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    if (rates.length === 0) {
      result.ok = false;
      result.error = `${day}: the answer held no rate`;
      break;
    }
    const ahead = rates.find((rate) => rate.validFrom > day);
    if (ahead) {
      result.ok = false;
      result.error = `${day}: ${ahead.currency}'s rate is valid only from ${ahead.validFrom}`;
      break;
    }
    // A day after today is settled only once its own rate is set.
    if (day > today && !rates.some((rate) => rate.validFrom === day)) break;

    const inserted = await database
      .insert(fxRates)
      .values(
        rates.map((rate) => ({
          currency: rate.currency,
          day,
          validFrom: rate.validFrom,
          quantity: rate.quantity,
          rate: String(rate.rate),
          gelPerUnit: (rate.rate / rate.quantity).toFixed(10),
          publishedAt: rate.publishedAt,
        })),
      )
      .onConflictDoNothing()
      .returning({ currency: fxRates.currency });
    result.daysStored += 1;
    result.rowsInserted += inserted.length;
  }

  result.lastStoredDay = await lastStoredDay(database);
  return result;
}

/**
 * Lari per one unit of `currency` on `day`, from the table, or null when the
 * day is not stored (a gap or the future). GEL is 1.
 */
export async function gelPerUnitOn(
  database: DatabaseOrTransaction,
  currency: string,
  day: string,
): Promise<number | null> {
  const code = currency.toUpperCase();
  if (code === 'GEL') return 1;
  const { rows } = await database.execute<{ gel_per_unit: string }>(
    sql`select ${fxRates.gelPerUnit} as gel_per_unit from ${fxRates}
         where ${fxRates.currency} = ${code} and ${fxRates.day} = ${day}`,
  );
  const value = rows[0]?.gel_per_unit;
  return value === undefined ? null : Number(value);
}
