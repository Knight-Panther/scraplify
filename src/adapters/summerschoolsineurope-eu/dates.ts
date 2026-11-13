/**
 * Course dates as summerschoolsineurope.eu prints them: "18 July - 05 August
 * 2027" (the year once, at the end), or with both years. Course dates are
 * plain calendar days, kept as `YYYY-MM-DD` strings with no time zone. A
 * registration deadline is a day too ("Deadline: 01 December" on the card,
 * with no year); it is stored as the end of that day in Tbilisi, so the site
 * shows the day the source printed (`web/lib/format.ts`).
 */

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;

/** "18 July - 05 August 2027" and "05 February 2027 - 15 April 2028". */
const RANGE_RE =
  /^(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?\s*[-–]\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/;
const DAY_MONTH_RE = /^(\d{1,2})\s+([A-Za-z]+)$/;

export interface ParsedWhen {
  raw: string | null;
  startDate: string | null;
  endDate: string | null;
  /** Calendar days the course runs, both ends included; null when the dates are suspect. */
  durationDays: number | null;
  /** The printed end is before the printed start ("28 June - 02 June 2027"): kept, not trusted. */
  suspect: boolean;
}

function monthIndex(name: string): number | null {
  const index = MONTHS.indexOf(name.toLowerCase() as (typeof MONTHS)[number]);
  return index === -1 ? null : index;
}

/** UTC midnight of a calendar day, or null when the day does not exist (31 February). */
function dayUtc(year: number, month: number, day: number): number | null {
  const ms = Date.UTC(year, month, day);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00.000Z`);
}

export function parseWhen(text: string | null | undefined): ParsedWhen {
  const raw = text?.replace(/\s+/g, ' ').trim() || null;
  const none: ParsedWhen = {
    raw,
    startDate: null,
    endDate: null,
    durationDays: null,
    suspect: false,
  };
  if (raw === null) return none;
  const match = RANGE_RE.exec(raw);
  if (match === null) return none;
  const [, startDayText, startMonthText, startYearText, endDayText, endMonthText, endYearText] =
    match;
  const startMonth = monthIndex(startMonthText ?? '');
  const endMonth = monthIndex(endMonthText ?? '');
  if (startMonth === null || endMonth === null) return none;
  const endYear = Number(endYearText);
  // With one year printed, a start month later than the end month is the
  // year before ("28 December - 08 January 2027").
  const startYear =
    startYearText !== undefined
      ? Number(startYearText)
      : startMonth > endMonth
        ? endYear - 1
        : endYear;
  const start = dayUtc(startYear, startMonth, Number(startDayText));
  const end = dayUtc(endYear, endMonth, Number(endDayText));
  if (start === null || end === null) return none;
  const suspect = end < start;
  return {
    raw,
    startDate: isoDay(start),
    endDate: isoDay(end),
    durationDays: suspect ? null : Math.round((end - start) / DAY_MS) + 1,
    suspect,
  };
}

/**
 * The year of a card's yearless deadline ("01 December"), from the course's
 * own dates and never from the day of the fetch. It is the latest such day
 * on or before the start date, within the year before it. When that day and
 * month also fall inside the course (a late deadline is possible), two years
 * fit and the answer is null rather than a guess; so is a day that does not
 * exist, or a course with no start date.
 */
export function resolveCardDeadline(
  raw: string | null,
  startDate: string | null,
  endDate: string | null,
): string | null {
  if (raw === null || startDate === null) return null;
  const match = DAY_MONTH_RE.exec(raw.replace(/\s+/g, ' ').trim());
  if (match === null) return null;
  const month = monthIndex(match[2] ?? '');
  if (month === null) return null;
  const day = Number(match[1]);
  const start = dayMs(startDate);
  const end = endDate === null ? start : Math.max(start, dayMs(endDate));
  const startYear = new Date(start).getUTCFullYear();
  const endYear = new Date(end).getUTCFullYear();
  const yearBefore = new Date(
    Date.UTC(startYear - 1, new Date(start).getUTCMonth(), new Date(start).getUTCDate()),
  ).getTime();

  const fitting = new Set<number>();
  for (let year = startYear - 1; year <= endYear; year++) {
    const candidate = dayUtc(year, month, day);
    if (candidate === null) continue;
    const beforeStart = candidate > yearBefore && candidate <= start;
    const duringCourse = candidate > start && candidate <= end;
    if (beforeStart || duringCourse) fitting.add(candidate);
  }
  if (fitting.size !== 1) return null;
  return isoDay([...fitting][0] as number);
}

/** The end of a day in Tbilisi (+04:00), as an instant. */
export function deadlineInstant(isoDate: string): string {
  return new Date(dayMs(isoDate) + DAY_MS - 1000 - TBILISI_OFFSET_MS).toISOString();
}
