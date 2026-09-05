import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseHrGeSitemap, SitemapParseError } from './sitemap.js';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8');
}

describe('parseHrGeSitemap', () => {
  it('extracts only announcement URLs, filtering out customer/jobs/jobs-in/search-posting and the third-host entry', () => {
    const candidates = parseHrGeSitemap(loadFixture('sitemap-synthetic.xml'));
    expect(candidates).toEqual([
      {
        sourceRecordId: '491744',
        url: 'https://www.hr.ge/announcement/491744/inglisurenovani-gayidvebis-agenti',
      },
      {
        sourceRecordId: '491887',
        url: 'https://www.hr.ge/announcement/491887/eqspert-konsultanti',
      },
    ]);
  });

  it('deduplicates by announcement id', () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://www.hr.ge/announcement/1/a</loc></url>
      <url><loc>https://www.hr.ge/announcement/1/a</loc></url>
    </urlset>`;
    expect(parseHrGeSitemap(xml)).toHaveLength(1);
  });

  it('throws SitemapParseError when no <url> entries are found at all — including on garbled/compressed content', () => {
    // Stands in for the documented gap: if the fetcher ever received
    // still-compressed bytes decoded as if utf-8, the result reads as
    // structurally empty rather than as any real sitemap content, and this
    // module fails loudly rather than accepting it.
    expect(() => parseHrGeSitemap('not xml at all, or garbled binary \x00\x01\x02')).toThrow(
      SitemapParseError,
    );
    expect(() => parseHrGeSitemap('<urlset></urlset>')).toThrow(SitemapParseError);
  });

  it('rejects a candidate URL that would fail isHrGeUrlAllowed (defense in depth)', () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://evil.example/announcement/1/a</loc></url>
      <url><loc>https://www.hr.ge/announcement/2/b</loc></url>
    </urlset>`;
    const candidates = parseHrGeSitemap(xml);
    expect(candidates).toEqual([{ sourceRecordId: '2', url: 'https://www.hr.ge/announcement/2/b' }]);
  });
});
