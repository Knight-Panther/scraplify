import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseCourseSitemap,
  parseSitemapIndex,
  SummerSchoolsSitemapParseError,
  sitemapsChangedSince,
} from './sitemap.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');
}

describe('parseSitemapIndex', () => {
  it('reads every course sitemap from the index with its lastmod, and no other kind', () => {
    const sitemaps = parseSitemapIndex(fixture('sitemap_index.xml'));
    expect(sitemaps).toHaveLength(10);
    expect(sitemaps[0]).toEqual({
      url: 'https://www.summerschoolsineurope.eu/course-sitemap.xml',
      lastmod: '2026-11-13T09:19:52.000Z',
    });
    expect(sitemaps[9]?.url).toBe('https://www.summerschoolsineurope.eu/course-sitemap10.xml');
    expect(sitemaps.every((sitemap) => /\/course-sitemap\d*\.xml$/.test(sitemap.url))).toBe(true);
  });

  it('picks the sitemaps changed since a moment, and every one when there is none', () => {
    const sitemaps = parseSitemapIndex(fixture('sitemap_index.xml'));
    expect(sitemapsChangedSince(sitemaps, '2026-11-11T00:00:00.000Z').map((s) => s.url)).toEqual([
      'https://www.summerschoolsineurope.eu/course-sitemap.xml',
      'https://www.summerschoolsineurope.eu/course-sitemap10.xml',
    ]);
    expect(sitemapsChangedSince(sitemaps, null)).toHaveLength(10);
  });

  it('refuses a document with no course sitemap', () => {
    expect(() => parseSitemapIndex('<sitemapindex></sitemapindex>')).toThrow(
      SummerSchoolsSitemapParseError,
    );
  });
});

describe('parseCourseSitemap', () => {
  it('reads course URLs with their lastmod', () => {
    const entries = parseCourseSitemap(fixture('course-sitemap.xml'));
    expect(entries).toHaveLength(1000);
    expect(entries[0]).toEqual({
      url: 'https://www.summerschoolsineurope.eu/course/science-summer-school/',
      lastmod: '2024-07-18T08:54:12.000Z',
    });
  });

  it('skips a location that is not a course page, and refuses an empty urlset', () => {
    const xml =
      '<urlset><url><loc>https://www.summerschoolsineurope.eu/about/</loc></url>' +
      '<url><loc>https://www.summerschoolsineurope.eu/course/a-b/</loc></url></urlset>';
    expect(parseCourseSitemap(xml)).toEqual([
      { url: 'https://www.summerschoolsineurope.eu/course/a-b/', lastmod: null },
    ]);
    expect(() => parseCourseSitemap('<urlset></urlset>')).toThrow(SummerSchoolsSitemapParseError);
  });

  it('reads a course page whose slug has underscores or percent-encoded letters, as the crawler may fetch it', () => {
    const urls = [
      'https://www.summerschoolsineurope.eu/course/summer_school-2027/',
      'https://www.summerschoolsineurope.eu/course/%d0%bb%d0%b5%d1%82%d0%be/',
      'https://www.summerschoolsineurope.eu/course/odd.slug/',
      'https://www.summerschoolsineurope.eu/course/a-b/?p=1',
    ];
    const xml = `<urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;
    expect(parseCourseSitemap(xml).map((entry) => entry.url)).toEqual(urls.slice(0, 2));
  });
});
