/**
 * etenders.ge prints every date as `DD/MM/YYYY`, with `HH:MM` (detail pages)
 * or `HH:MM:SS` (amendment and Q&A stamps) when it has a time, always in
 * Tbilisi local time. The countdown script seeds the server clock on every
 * detail page, and that seed is UTC+4 (docs/addEtender.md §4). Georgia has
 * kept UTC+4 all year since 2005, so a fixed offset is exact, not an
 * approximation that a DST rule would need.
 */
const TBILISI_OFFSET_MINUTES = 4 * 60;

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** Raw value as printed, plus the instant in UTC, or null when the text is not a valid date. */
export interface ParsedEtendersDate {
  raw: string | null;
  parsed: string | null;
}

/**
 * Parses an etenders.ge date or date-time. A date with no time resolves to
 * the start of that day in Tbilisi. Anything that does not match the format
 * exactly, or names an impossible day (31/02), yields `parsed: null` while
 * keeping `raw`, so a format change is visible instead of silently guessed.
 */
export function parseEtendersDate(text: string | null | undefined): ParsedEtendersDate {
  const raw = text?.replace(/\s+/g, ' ').trim() || null;
  if (raw === null) return { raw: null, parsed: null };
  const match = DATE_RE.exec(raw);
  if (match === null) return { raw, parsed: null };
  const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = match;
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);
  const hour = Number(hh);
  const minute = Number(mi);
  const second = Number(ss);
  if (hour > 23 || minute > 59 || second > 59) return { raw, parsed: null };
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(localAsUtc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return { raw, parsed: null };
  }
  const instant = new Date(localAsUtc - TBILISI_OFFSET_MINUTES * 60_000);
  return { raw, parsed: instant.toISOString() };
}
