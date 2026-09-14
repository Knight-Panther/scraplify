/**
 * Presentation helpers shared across screens.
 *
 * Dates go through `Intl` rather than hand-built strings — the interface
 * checklist requires it, and a hardcoded format would be wrong for anyone whose
 * locale orders a date differently.
 */

/** ISO 8601 in UTC, which is what every timestamp column stores. */
const ABSOLUTE = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/**
 * Both boards are Georgian and state their dates in Georgian local time.
 * Georgia has observed no DST since 2005, so this is always UTC+4 — the same
 * fact `src/adapters/jobs-ge/dates.ts` relies on when it parses.
 */
const SOURCE_TIME_ZONE = 'Asia/Tbilisi';

/**
 * A date a SOURCE stated, rendered in the source's own timezone.
 *
 * This is not a formatting preference, it is a correctness fix. jobs.ge
 * publishes calendar dates with no time, and the adapter stores them as local
 * midnight — `2026-09-20T00:00:00+04:00`, which Postgres returns as
 * `2026-09-19 20:00:00+00`. Formatted in UTC, as this file used to do
 * everywhere, a deadline the board printed as **20 September** appeared on
 * screen as **19 Sept, 20:00 UTC**: the wrong day, on the field a person uses
 * to decide whether it is too late to apply.
 *
 * Only the DATE is shown. jobs.ge states no time at all, so a rendered
 * "00:00" would assert a precision the board never gave, and hr.ge's 19:59 is
 * its own end-of-day convention rather than a meaningful deadline minute. The
 * exact stored instant stays reachable through `absoluteTime` in a tooltip.
 */
const SOURCE_DATE = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeZone: SOURCE_TIME_ZONE,
});

const SOURCE_DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: SOURCE_TIME_ZONE,
});

export function sourceDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return SOURCE_DATE.format(parsed);
}

/** The same instant with its time, for a tooltip where the minute matters. */
export function sourceDateTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return `${SOURCE_DATE_TIME.format(parsed)} in Tbilisi`;
}

/**
 * The Tbilisi calendar day, as `YYYY-MM-DD` — what "the same date" means when
 * comparing what two boards stated.
 *
 * Comparing the raw instants instead is what made the detail screen invent
 * conflicts: hr.ge's `2026-09-20 15:59Z` and jobs.ge's `2026-09-19 20:00Z` are
 * different instants and the SAME Georgian day, 20 September, which is what
 * both boards actually printed. Measured over the four cross-posted clusters,
 * instant comparison reported twelve disagreements where six exist.
 *
 * `en-CA` because its short numeric format is ISO-ordered, which sorts and
 * compares correctly as a plain string.
 */
const SOURCE_DAY = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: SOURCE_TIME_ZONE,
});

export function sourceDayKey(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return SOURCE_DAY.format(parsed);
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "3 hours ago", with the exact instant available as a tooltip.
 *
 * Both halves matter on the health screen: relative time answers "is this
 * stale?" at a glance, which is the actual question, while the absolute value
 * is what someone correlates against a log.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';

  const delta = then - now;
  const abs = Math.abs(delta);

  if (abs < MINUTE) return 'just now';
  if (abs < HOUR) return RELATIVE.format(Math.round(delta / MINUTE), 'minute');
  if (abs < DAY) return RELATIVE.format(Math.round(delta / HOUR), 'hour');
  return RELATIVE.format(Math.round(delta / DAY), 'day');
}

export function absoluteTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return `${ABSOLUTE.format(parsed)} UTC`;
}

/**
 * A 0-1 score, fixed at two decimals.
 *
 * Through Intl like everything else here, rather than `toFixed`, which hard-codes
 * a decimal separator that is wrong for most of Europe. Deliberately NOT shown as
 * a percentage: a dedupe confidence is a weighted evidence score, not a
 * probability, and "97% sure" claims something the scorer never computed.
 */
const SCORE = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function score(value: number): string {
  return SCORE.format(value);
}

/** Thousands separators, so a five-figure corpus stays readable. */
const NUMBER = new Intl.NumberFormat('en-GB');

export function count(value: number): string {
  return NUMBER.format(value);
}
