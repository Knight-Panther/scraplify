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

/** Thousands separators, so a five-figure corpus stays readable. */
const NUMBER = new Intl.NumberFormat('en-GB');

export function count(value: number): string {
  return NUMBER.format(value);
}
