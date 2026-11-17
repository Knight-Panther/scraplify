import { z } from 'zod';

/**
 * The National Bank of Georgia's public exchange-rate API (Phase 17D).
 *
 * `GET …/currencies/en/json/?date=YYYY-MM-DD` answers with the rates in force
 * on that day, one object per currency. Checked 2026-11-17: a Sunday or a
 * Monday answers with Saturday's rates (`validFromDate` the Saturday), and a
 * day after the last rate set answers with that last one, so a day later than
 * today is only settled once its own rate is out. The API takes one day per
 * request; `start` and `end` are ignored.
 */
export const NBG_RATES_URL = 'https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/';

export interface NbgRate {
  /** ISO 4217 code, upper case. */
  currency: string;
  /** The day this rate took effect, YYYY-MM-DD. */
  validFrom: string;
  quantity: number;
  /** Lari for `quantity` units. */
  rate: number;
  /** When NBG set it, ISO timestamp, or null when the answer lacks it. */
  publishedAt: string | null;
}

const isoDay = /^\d{4}-\d{2}-\d{2}/;

const currencySchema = z.object({
  code: z.string().regex(/^[A-Za-z]{3}$/),
  quantity: z.number().int().positive(),
  rate: z.number().positive(),
  validFromDate: z.string().regex(isoDay),
  date: z.string().nullish(),
});

const answerSchema = z
  .array(z.object({ currencies: z.array(z.unknown()) }))
  .length(1, 'expected one day in the answer');

/**
 * The rates in an answer. A currency entry that does not have the expected
 * shape is skipped and named in `skipped`, so one odd entry cannot hide the
 * rest; an answer whose outer shape is wrong throws.
 */
export function parseNbgAnswer(json: unknown): { rates: NbgRate[]; skipped: string[] } {
  const [day] = answerSchema.parse(json);
  const rates: NbgRate[] = [];
  const skipped: string[] = [];
  for (const entry of day?.currencies ?? []) {
    const parsed = currencySchema.safeParse(entry);
    if (!parsed.success) {
      const code = (entry as { code?: unknown } | null)?.code;
      skipped.push(typeof code === 'string' ? code : '?');
      continue;
    }
    const { code, quantity, rate, validFromDate, date } = parsed.data;
    rates.push({
      currency: code.toUpperCase(),
      validFrom: validFromDate.slice(0, 10),
      quantity,
      rate,
      publishedAt: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
    });
  }
  return { rates, skipped };
}

export type FetchJson = (url: string) => Promise<unknown>;

/** A fetcher for the API: 20 s timeout, the project's User-Agent, a non-2xx answer throws. */
export function nbgFetcher(userAgent: string, fetchImpl: typeof fetch = fetch): FetchJson {
  return async (url) => {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`NBG answered ${response.status} for ${url}`);
    return response.json();
  };
}

export function nbgDayUrl(day: string): string {
  return `${NBG_RATES_URL}?date=${day}`;
}
