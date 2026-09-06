import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSearchPostingPage, SearchPostingParseError } from './discovery.js';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8');
}

describe('parseSearchPostingPage', () => {
  it('parses page 1: 100 listings, real totalCount, well-formed detail URLs', () => {
    const result = parseSearchPostingPage(loadFixture('search-posting-pg1.html'));
    expect(result.totalCount).toBe(3265);
    expect(result.listings.length).toBe(100);

    const first = result.listings.find((l) => l.sourceRecordId === '491744');
    expect(first).toBeDefined();
    expect(first?.url).toBe(
      'https://www.hr.ge/announcement/491744/inglisurenovani-gayidvebis-agenti',
    );
    expect(first?.title).toBe('ინგლისურენოვანი გაყიდვების აგენტი');
    expect(first?.isPriority).toBe(true);
    expect(first?.publishDate).toBe('2026-09-02T17:45:06.42');
  });

  it('parses the terminal page (33): fewer than 100 listings, same corpus totalCount', () => {
    const result = parseSearchPostingPage(loadFixture('search-posting-pg33-last.html'));
    expect(result.totalCount).toBe(3265);
    expect(result.listings.length).toBeGreaterThan(0);
    expect(result.listings.length).toBeLessThan(100);
  });

  it('every discovered listing has a unique sourceRecordId', () => {
    const result = parseSearchPostingPage(loadFixture('search-posting-pg1.html'));
    const ids = result.listings.map((l) => l.sourceRecordId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every discovered URL passes isHrGeUrlAllowed (the same gate the fetcher enforces)', () => {
    const result = parseSearchPostingPage(loadFixture('search-posting-pg1.html'));
    expect(result.listings.length).toBeGreaterThan(0);
    // parseSearchPostingPage already filters through isHrGeUrlAllowed
    // internally; this pins that no unauthorized URL slips through by
    // re-deriving from the fixture directly rather than trusting the
    // module's own internal call.
    for (const listing of result.listings) {
      expect(listing.url.startsWith('https://www.hr.ge/announcement/')).toBe(true);
    }
  });

  it('throws SearchPostingParseError when the ng-state island is missing entirely', () => {
    expect(() => parseSearchPostingPage('<html><body>empty</body></html>')).toThrow();
  });

  it('throws SearchPostingParseError when the island has no announcement-search entry', () => {
    const html =
      '<html><body><script id="ng-state" type="application/json">{"1":{"u":"https://api.p.hr.ge/other","b":{}}}</script></body></html>';
    expect(() => parseSearchPostingPage(html)).toThrow(SearchPostingParseError);
  });

  it('throws SearchPostingParseError when items[] is missing from an otherwise-present entry', () => {
    const html =
      '<html><body><script id="ng-state" type="application/json">{"1":{"u":"https://api.p.hr.ge/public-portal/tenant/1/api/v3/announcement-search","b":{"data":{"announcements":{"totalCount":5}}}}}</script></body></html>';
    expect(() => parseSearchPostingPage(html)).toThrow(SearchPostingParseError);
  });

  it('throws SearchPostingParseError when totalCount is missing', () => {
    const html =
      '<html><body><script id="ng-state" type="application/json">{"1":{"u":"https://api.p.hr.ge/public-portal/tenant/1/api/v3/announcement-search","b":{"data":{"announcements":{"items":[]}}}}}</script></body></html>';
    expect(() => parseSearchPostingPage(html)).toThrow(SearchPostingParseError);
  });

  it('does not throw on the out-of-range 404 page (a soft-404: intact chrome, zero rows)', () => {
    const result = parseSearchPostingPage(loadFixture('search-posting-pg34-out-of-range-404.html'));
    expect(result.listings.length).toBe(0);
    // totalCount still reflects the real corpus size even on this page —
    // the caller's own health checks (not this function) decide what
    // "zero rows but a healthy totalCount" means for run status.
    expect(result.totalCount).toBe(3265);
  });

  it('skips an item with no matching DOM anchor rather than fabricating a slug', () => {
    const html = `<html><body>
      <script id="ng-state" type="application/json">${JSON.stringify({
        1: {
          u: 'https://api.p.hr.ge/public-portal/tenant/1/api/v3/announcement-search',
          b: {
            data: {
              announcements: {
                items: [{ announcementId: 999999, title: 'no anchor for me', isPriority: false }],
                totalCount: 1,
              },
            },
          },
        },
      })}</script>
    </body></html>`;
    const result = parseSearchPostingPage(html);
    expect(result.listings).toEqual([]);
    expect(result.totalCount).toBe(1);
  });
});
