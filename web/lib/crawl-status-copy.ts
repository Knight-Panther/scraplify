import type { Locale } from './locale.js';

/**
 * Text for the landing pages' "last update / next update" line
 * (`components/crawl-status.tsx`), in both locales. Times are Tbilisi's, the
 * zone the boards and the schedule are in, always with the year.
 */

const TIME_ZONE = 'Asia/Tbilisi';

/**
 * Numbers only, from a fixed locale, with month names from the tables below
 * rather than each engine's locale data: the server renders this text and the
 * browser renders it again, and a browser without Georgian locale data (or
 * with different English abbreviations) would otherwise print a different
 * string and break hydration. Found in browser QA, 2026-09-26: Chromium
 * rendered `ka-GE` as "Sep 26, 2026, 9:13 PM".
 */
const PARTS = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: TIME_ZONE,
});

const MONTHS: Record<Locale, readonly string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ka: ['იან', 'თებ', 'მარ', 'აპრ', 'მაი', 'ივნ', 'ივლ', 'აგვ', 'სექ', 'ოქტ', 'ნოე', 'დეკ'],
};

function tbilisiParts(iso: string): Record<'year' | 'month' | 'day' | 'hour' | 'minute', string> {
  const parts = Object.fromEntries(
    PARTS.formatToParts(Date.parse(iso)).map((part) => [part.type, part.value]),
  );
  return {
    year: parts.year ?? '',
    month: parts.month ?? '',
    day: parts.day ?? '',
    hour: parts.hour ?? '',
    minute: parts.minute ?? '',
  };
}

/** "26 Sep 2026, 21:13" / "26 სექ. 2026, 21:13", in Tbilisi. */
export function updateDateTime(iso: string, locale: Locale): string {
  const { year, month, day, hour, minute } = tbilisiParts(iso);
  const name = MONTHS[locale][Number(month) - 1] ?? month;
  return `${Number(day)} ${name}${locale === 'ka' ? '.' : ''} ${year}, ${hour}:${minute}`;
}

/** "20:10", in Tbilisi. */
export function updateClock(iso: string): string {
  const { hour, minute } = tbilisiParts(iso);
  return `${hour}:${minute}`;
}

/** Whole minutes until `untilMs`, rounded up so a countdown never reads 0 early. */
function minutesUntil(untilMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((untilMs - nowMs) / 60_000));
}

/** "in 5 h 12 min" / "5 სთ 12 წთ-ში"; "in under a minute" once below one. */
export function countdown(untilMs: number, nowMs: number, locale: Locale): string {
  if (untilMs - nowMs < 60_000) return CRAWL_STATUS_COPY[locale].underAMinute;
  const total = minutesUntil(untilMs, nowMs);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const parts =
    locale === 'ka'
      ? [hours > 0 ? `${hours} სთ` : null, minutes > 0 ? `${minutes} წთ` : null]
      : [hours > 0 ? `${hours} h` : null, minutes > 0 ? `${minutes} min` : null];
  const span = parts.filter((part) => part !== null).join(' ');
  return locale === 'ka' ? `${span}-ში` : `in ${span}`;
}

export interface CrawlStatusCopy {
  heading: string;
  lastUpdate: string;
  noUpdateYet: string;
  nextUpdate: string;
  updatingNow: string;
  late: (clock: string) => string;
  lastAttemptIncomplete: string;
  underAMinute: string;
}

export const CRAWL_STATUS_COPY: Record<Locale, CrawlStatusCopy> = {
  en: {
    heading: 'Board updates',
    lastUpdate: 'Last update',
    noUpdateYet: 'no complete update yet',
    nextUpdate: 'Next update',
    updatingNow: 'Updating now',
    late: (clock) => `Late: expected at ${clock}`,
    lastAttemptIncomplete: 'last attempt incomplete',
    underAMinute: 'in under a minute',
  },
  ka: {
    heading: 'განახლებები',
    lastUpdate: 'ბოლო განახლება',
    noUpdateYet: 'სრული განახლება ჯერ არ ყოფილა',
    nextUpdate: 'შემდეგი განახლება',
    updatingNow: 'ახლა ახლდება',
    late: (clock) => `იგვიანებს: მოსალოდნელი იყო ${clock}-ზე`,
    lastAttemptIncomplete: 'ბოლო მცდელობა ბოლომდე ვერ დასრულდა',
    underAMinute: 'წუთზე ნაკლებში',
  },
};
