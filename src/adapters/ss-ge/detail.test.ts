import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDetailPage } from './detail.js';
import { SsGePageShapeError } from './list.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');
}

describe('parseDetailPage', () => {
  it('reads a live listing and when the site will drop it', () => {
    expect(parseDetailPage(fixture('detail-active.html'))).toEqual({
      status: 'active',
      endAt: '2026-11-11T12:46:44.954Z',
    });
  });

  it('reads a long-running listing, whose end is years away', () => {
    expect(parseDetailPage(fixture('detail-long-running.html'))).toEqual({
      status: 'active',
      endAt: '2039-12-31T20:00:00.000Z',
    });
  });

  it('reads an expired listing as gone: the site still answers 200 for it', () => {
    expect(parseDetailPage(fixture('detail-expired.html'))).toEqual({
      status: 'gone',
      reason: 'expired',
    });
  });

  it('reads a page with no listing record as gone: the site has no 404', () => {
    expect(parseDetailPage(fixture('detail-missing.html'))).toEqual({
      status: 'gone',
      reason: 'missing',
    });
  });

  it('refuses a page that is not a listing page at all', () => {
    expect(() => parseDetailPage('<html><body>Just a moment...</body></html>')).toThrow(
      SsGePageShapeError,
    );
  });
});
