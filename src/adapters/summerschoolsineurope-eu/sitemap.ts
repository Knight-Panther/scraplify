import * as cheerio from 'cheerio';

/**
 * The site's Yoast sitemaps: `sitemap_index.xml` names ten
 * `course-sitemap<n>.xml` files of up to 1,000 course pages each, every page
 * with a `lastmod`. Entries are ordered by modification date, so a course
 * changed recently sits in the last file; the index's own date for the first
 * file is the whole type's newest change (2026-11-13), not that file's. The
 * crawl reads the files the index dates as changed, to learn which course
 * pages changed without their card changing.
 */

export class SummerSchoolsSitemapParseError extends Error {
  constructor(message: string) {
    super(`summerschoolsineurope.eu sitemap: ${message}`);
    this.name = 'SummerSchoolsSitemapParseError';
  }
}

export interface SitemapEntry {
  url: string;
  /** ISO instant, or null when the entry has none or it does not parse. */
  lastmod: string | null;
}

const COURSE_SITEMAP_RE =
  /^https:\/\/www\.summerschoolsineurope\.eu\/course-sitemap(?:[1-9][0-9]?)?\.xml$/;
const COURSE_PAGE_RE =
  /^https:\/\/www\.summerschoolsineurope\.eu\/course\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;

function instant(text: string): string | null {
  const ms = Date.parse(text.trim());
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function entries(xml: string, element: 'sitemap' | 'url', pattern: RegExp): SitemapEntry[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const result: SitemapEntry[] = [];
  $(element).each((_, node) => {
    const url = $(node).children('loc').first().text().trim();
    if (!pattern.test(url)) return;
    const lastmod = $(node).children('lastmod').first().text();
    result.push({ url, lastmod: lastmod === '' ? null : instant(lastmod) });
  });
  return result;
}

/** The course sitemaps the index names, in its order. */
export function parseSitemapIndex(xml: string): SitemapEntry[] {
  const sitemaps = entries(xml, 'sitemap', COURSE_SITEMAP_RE);
  if (sitemaps.length === 0) throw new SummerSchoolsSitemapParseError('no course sitemap');
  return sitemaps;
}

/** The course pages one course sitemap lists; any other location is skipped. */
export function parseCourseSitemap(xml: string): SitemapEntry[] {
  const pages = entries(xml, 'url', COURSE_PAGE_RE);
  if (pages.length === 0) throw new SummerSchoolsSitemapParseError('no course page');
  return pages;
}

/** Sitemaps whose index date is after `since`; every one when there is no `since` or no date. */
export function sitemapsChangedSince(
  sitemaps: readonly SitemapEntry[],
  since: string | null,
): SitemapEntry[] {
  if (since === null) return [...sitemaps];
  const sinceMs = Date.parse(since);
  return sitemaps.filter(
    (sitemap) => sitemap.lastmod === null || Date.parse(sitemap.lastmod) > sinceMs,
  );
}
