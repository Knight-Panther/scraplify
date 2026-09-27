/** jobs.ge date field: `{ raw, parsed }`, both nullable — mirrors domain/source-listing.ts's DateFieldSchema. */
export interface ParsedDateField {
  raw: string | null;
  parsed: string | null;
}

/**
 * Standard modern Georgian (Mkhedruli) calendar month names, nominative
 * form — exactly how jobs.ge renders them in "DD <month>" dates (e.g. "02
 * სექტემბერი"), confirmed across every sampled detail page
 * (RECON_NOTES.md).
 */
const GEORGIAN_MONTHS: Record<string, number> = {
  იანვარი: 1,
  თებერვალი: 2,
  მარტი: 3,
  აპრილი: 4,
  მაისი: 5,
  ივნისი: 6,
  ივლისი: 7,
  აგვისტო: 8,
  სექტემბერი: 9,
  ოქტომბერი: 10,
  ნოემბერი: 11,
  დეკემბერი: 12,
};

/** Georgia has observed no DST since 2005 — Asia/Tbilisi is always UTC+4, no tz database lookup needed. */
const TBILISI_OFFSET = '+04:00';
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;
const MS_PER_DAY = 86_400_000;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * True only if year/month/day survive a UTC round-trip unchanged — Date.UTC
 * silently rolls an invalid calendar date into the next month (e.g. "31
 * February" becomes March 2/3) rather than rejecting it, which would
 * otherwise let a bad candidate year through unnoticed (most likely to bite
 * on 29 February against a non-leap candidate year).
 */
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const ms = Date.UTC(year, month - 1, day);
  const roundTripped = new Date(ms);
  return (
    roundTripped.getUTCFullYear() === year &&
    roundTripped.getUTCMonth() === month - 1 &&
    roundTripped.getUTCDate() === day
  );
}

/**
 * Parses jobs.ge's yearless "DD <Georgian month name>" date format,
 * inferring the year by choosing whichever of {referenceYear - 1,
 * referenceYear, referenceYear + 1} places the resulting calendar date
 * closest to referenceInstant's own Asia/Tbilisi calendar date. This is the
 * standard technique for yearless dates (concept §24.1's explicit "yearless
 * dates across year boundaries" requirement) and the only one that
 * correctly handles both a recent-past date (publishedDate) and a
 * near-future one (deadlineDate, typically ~1 month out) without a
 * hardcoded "always past" or "always future" assumption — either can
 * legitimately be on either side of referenceInstant.
 *
 * Returns `{ raw, parsed: null }` (never throws) when `raw` doesn't match
 * the expected shape or names an unrecognized/invalid calendar date —
 * matches DateFieldSchema's own nullable `parsed`, since a field this
 * schema already models as "may be absent" shouldn't fail the whole parse.
 */
export function parseYearlessGeorgianDate(raw: string, referenceInstant: string): ParsedDateField {
  const candidates = yearCandidates(raw, referenceInstant);
  if (candidates === null) return { raw, parsed: null };
  let best: Candidate | null = null;
  for (const candidate of candidates.list) {
    const distance = Math.abs(candidate.dayNumber - candidates.referenceDayNumber);
    if (best === null || distance < Math.abs(best.dayNumber - candidates.referenceDayNumber)) {
      best = candidate;
    }
  }
  return { raw, parsed: best?.iso ?? null };
}

/**
 * A listing's publication date: the latest candidate year that does not put
 * it after the day it was fetched (one day of slack for clocks). "Closest"
 * alone is wrong here: a listing still up months after publication, e.g. "03
 * November" fetched on 26 September, came out as next November, a
 * publication date in the future (found live, 2026-09-27). A page cannot have
 * been published after it was fetched, so the past year is the only answer.
 */
export function parseYearlessPublishedDate(raw: string, referenceInstant: string): ParsedDateField {
  const candidates = yearCandidates(raw, referenceInstant);
  if (candidates === null) return { raw, parsed: null };
  let best: Candidate | null = null;
  for (const candidate of candidates.list) {
    if (candidate.dayNumber > candidates.referenceDayNumber + 1) continue;
    if (best === null || candidate.dayNumber > best.dayNumber) best = candidate;
  }
  return { raw, parsed: best?.iso ?? null };
}

/**
 * A listing's deadline, given its already-parsed publication date: the
 * earliest candidate on or after publication. A deadline is set when the
 * listing is posted and falls weeks or months after it, so "closest to the
 * fetch" would move a long-past deadline ("07 November", published 3 November
 * last year) into the coming November and keep an expired listing looking
 * open. Without a publication date, falls back to the closest candidate.
 */
export function parseYearlessDeadlineDate(
  raw: string,
  referenceInstant: string,
  publishedParsed: string | null,
): ParsedDateField {
  const publishedMs = publishedParsed === null ? Number.NaN : new Date(publishedParsed).getTime();
  if (Number.isNaN(publishedMs)) return parseYearlessGeorgianDate(raw, referenceInstant);
  const candidates = yearCandidates(raw, referenceInstant);
  if (candidates === null) return { raw, parsed: null };
  const publishedDayNumber = Math.floor((publishedMs + TBILISI_OFFSET_MS) / MS_PER_DAY);
  let best: Candidate | null = null;
  for (const candidate of candidates.list) {
    if (candidate.dayNumber < publishedDayNumber) continue;
    if (best === null || candidate.dayNumber < best.dayNumber) best = candidate;
  }
  return { raw, parsed: best?.iso ?? null };
}

interface Candidate {
  dayNumber: number;
  iso: string;
}

/**
 * The valid calendar dates `raw` can name in the years around
 * referenceInstant's Asia/Tbilisi year, or null when `raw` is not a
 * recognizable "DD <month>" date (never throws).
 */
function yearCandidates(
  raw: string,
  referenceInstant: string,
): { list: Candidate[]; referenceDayNumber: number } | null {
  const normalized = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const match = normalized.match(/^(\d{1,2})\s+(\S+)$/u);
  if (!match?.[1] || !match[2]) return null;

  const day = Number(match[1]);
  const month = GEORGIAN_MONTHS[match[2]];
  if (month === undefined || day < 1 || day > 31) return null;

  const referenceMs = new Date(referenceInstant).getTime();
  if (Number.isNaN(referenceMs)) return null;
  const tbilisiReferenceMs = referenceMs + TBILISI_OFFSET_MS;
  const referenceDayNumber = Math.floor(tbilisiReferenceMs / MS_PER_DAY);
  const referenceYear = new Date(tbilisiReferenceMs).getUTCFullYear();

  const list: Candidate[] = [];
  for (const candidateYear of [referenceYear - 1, referenceYear, referenceYear + 1]) {
    if (!isValidCalendarDate(candidateYear, month, day)) continue;
    list.push({
      dayNumber: Math.floor(Date.UTC(candidateYear, month - 1, day) / MS_PER_DAY),
      iso: `${candidateYear}-${pad2(month)}-${pad2(day)}T00:00:00${TBILISI_OFFSET}`,
    });
  }
  if (list.length === 0) return null;
  return { list, referenceDayNumber };
}
