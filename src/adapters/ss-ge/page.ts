/**
 * What every ss.ge page has in common: its data arrives as one JSON block
 * (`__NEXT_DATA__`), and its times are Tbilisi wall-clock.
 */

/** The page is not the kind of page this adapter reads: a challenge, an error page, a changed layout. */
export class SsGePageShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsGePageShapeError';
  }
}

const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The page's `props.pageProps`. Throws rather than returning something
 * empty: a page with no data block must never read as "no listings".
 *
 * The block also carries a working access token for the site's own gateway
 * (`credentialsToken`). Nothing here reads it, and callers must not log or
 * keep the object this returns.
 */
export function readPageProps(html: string): Record<string, unknown> {
  const match = NEXT_DATA_RE.exec(html);
  if (match?.[1] === undefined) throw new SsGePageShapeError('ss.ge page has no data block');
  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new SsGePageShapeError('ss.ge page data block is not valid JSON');
  }
  const pageProps = isRecord(data) && isRecord(data.props) ? data.props.pageProps : undefined;
  if (!isRecord(pageProps)) throw new SsGePageShapeError('ss.ge page data block has no pageProps');
  return pageProps;
}

/** Georgia is UTC+4 all year. */
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/;

/**
 * Reads an ss.ge timestamp as Tbilisi wall-clock and returns the instant.
 * Whatever follows the clock is ignored on purpose: the site writes the same
 * local time sometimes with `+04:00` and sometimes with `Z`, and trusting the
 * `Z` would put those rows four hours in the future (801 of 1,328 sampled
 * rows carried it, 2026-10-12).
 */
export function tbilisiWallClockToIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = WALL_CLOCK_RE.exec(value);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const millisecond = Number(fraction.slice(0, 3).padEnd(3, '0'));
  const utc =
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      millisecond,
    ) - TBILISI_OFFSET_MS;
  return Number.isNaN(utc) ? null : new Date(utc).toISOString();
}

export { isRecord };
