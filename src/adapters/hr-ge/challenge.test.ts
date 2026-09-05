import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyHrGeResponse, isHrGeRateLimited } from './challenge.js';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8');
}

describe('classifyHrGeResponse', () => {
  it("classifies every real healthy fixture as 'ok' — proves the awswaf-trap doesn't misfire", () => {
    // RECON_NOTES.md's documented trap: AWS WAF's challenge.js script tag
    // is embedded in every one of these real, ordinary pages. A detector
    // that keyed on its mere presence would flag all of them.
    for (const file of [
      'search-posting-pg1.html',
      'search-posting-pg33-last.html',
      'detail-492368-email-application.html',
    ]) {
      const body = loadFixture(file);
      expect(body).toContain('awswaf'); // sanity: the trap condition is really present
      expect(classifyHrGeResponse({ status: 200, headers: {}, body })).toBe('ok');
    }
  });

  it("classifies the healthy soft-404 as 'unknown', not 'ok' — this function only judges WAF health, not page validity", () => {
    const body = loadFixture('search-posting-pg34-out-of-range-404.html');
    expect(classifyHrGeResponse({ status: 404, headers: {}, body })).toBe('unknown');
  });

  it("classifies a response carrying x-amzn-waf-action as 'challenged' regardless of status", () => {
    expect(
      classifyHrGeResponse({
        status: 200,
        headers: { 'x-amzn-waf-action': 'challenge' },
        body: 'anything',
      }),
    ).toBe('challenged');
  });

  it("classifies status 403 and 202 as 'challenged'", () => {
    expect(classifyHrGeResponse({ status: 403, headers: {}, body: 'blocked' })).toBe('challenged');
    expect(classifyHrGeResponse({ status: 202, headers: {}, body: 'js challenge' })).toBe(
      'challenged',
    );
  });

  it("classifies a 200 missing the ssr/ng-state markers as 'unknown', not 'ok'", () => {
    expect(
      classifyHrGeResponse({ status: 200, headers: {}, body: '<html><body>plain</body></html>' }),
    ).toBe('unknown');
  });

  it('header lookup handles an array-valued header the same way http-fetcher.ts represents multi-value headers', () => {
    expect(
      classifyHrGeResponse({
        status: 200,
        headers: { 'x-amzn-waf-action': ['challenge', 'other'] },
        body: 'anything',
      }),
    ).toBe('challenged');
  });
});

describe('isHrGeRateLimited', () => {
  it('treats status 429 as rate-limited regardless of headers', () => {
    expect(isHrGeRateLimited(429, {})).toBe(true);
  });

  it("treats 'Ratelimit-Remaining: 0' as rate-limited even on a 200", () => {
    expect(isHrGeRateLimited(200, { 'ratelimit-remaining': '0' })).toBe(true);
  });

  it('is not rate-limited when remaining budget is positive and status is not 429', () => {
    expect(isHrGeRateLimited(200, { 'ratelimit-remaining': '19' })).toBe(false);
    expect(isHrGeRateLimited(200, {})).toBe(false);
  });
});
