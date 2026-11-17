import { sql } from 'drizzle-orm';
import {
  check,
  date,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * The National Bank of Georgia's official exchange rates: one row per
 * currency and calendar day, with the rate in force on that day (Phase 17D,
 * docs/PHASE_17_PLAN.md). Fetched from NBG's public API by `src/fx/sync.ts`,
 * back-filled from 2026-01-01 once, then a request or two a night from the
 * job pipelines.
 *
 * NBG sets a rate on each working day, in force from the next day until it
 * sets another: Saturday's rate also holds on Sunday and Monday, and a
 * holiday is carried the same way. Asked for any day, NBG answers with the
 * rate in force on it, and that is what each row holds; `valid_from` is the
 * day that rate took effect. So every day is a row of its own, a missing day
 * is a gap to see rather than a carry-forward to guess, and a statistic joins
 * on the day it takes a value as of.
 *
 * Statistics convert with this table, never with a source's own conversion
 * (ss.ge's `price_usd` is kept but not mixed in); the posted amount and
 * currency stay the truth.
 *
 * - `rate` is lari for `quantity` units, as NBG states it (100 for a few
 *   currencies); `gel_per_unit` is the one to multiply by.
 * - `published_at` is when NBG set the rate, the evening before it applies.
 * - A day is stored once it is settled: today or earlier, or a later day NBG
 *   has already set a rate for. Never updated afterwards.
 */
export const fxRates = pgTable(
  'fx_rates',
  {
    currency: text('currency').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    quantity: integer('quantity').notNull(),
    rate: numeric('rate', { precision: 14, scale: 6 }).notNull(),
    gelPerUnit: numeric('gel_per_unit', { precision: 18, scale: 10 }).notNull(),
    publishedAt: timestamp('published_at', { mode: 'string', withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.currency, table.day] }),
    check('fx_rates_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check('fx_rates_positive_check', sql`${table.quantity} > 0 and ${table.rate} > 0`),
    check('fx_rates_valid_from_check', sql`${table.validFrom} <= ${table.day}`),
  ],
);

export type FxRateRow = typeof fxRates.$inferSelect;
