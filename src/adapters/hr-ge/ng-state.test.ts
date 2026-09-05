import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { extractNgState, findNgStateEntry, NgStateMissingError } from './ng-state.js';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8');
}

describe('extractNgState', () => {
  it('parses the real ng-state island from the index page fixture', () => {
    const $ = cheerio.load(loadFixture('search-posting-pg1.html'));
    const state = extractNgState($);
    expect(Object.keys(state).length).toBeGreaterThan(0);
  });

  it('parses the real ng-state island from a detail page fixture', () => {
    const $ = cheerio.load(loadFixture('detail-492368-email-application.html'));
    const state = extractNgState($);
    expect(Object.keys(state).length).toBeGreaterThan(0);
  });

  it('parses the ng-state island even on the out-of-range 404 fixture (a healthy-looking soft-404)', () => {
    const $ = cheerio.load(loadFixture('search-posting-pg34-out-of-range-404.html'));
    expect(() => extractNgState($)).not.toThrow();
  });

  it('throws NgStateMissingError when no ng-state script tag exists', () => {
    const $ = cheerio.load('<html><body>no island here</body></html>');
    expect(() => extractNgState($)).toThrow(NgStateMissingError);
  });

  it('throws NgStateMissingError on malformed JSON', () => {
    const $ = cheerio.load(
      '<html><body><script id="ng-state" type="application/json">{not valid json</script></body></html>',
    );
    expect(() => extractNgState($)).toThrow(NgStateMissingError);
  });

  it('throws NgStateMissingError when the island parses to a non-object (fails closed, not silently)', () => {
    const $ = cheerio.load(
      '<html><body><script id="ng-state" type="application/json">[1,2,3]</script></body></html>',
    );
    expect(() => extractNgState($)).toThrow(NgStateMissingError);
  });
});

describe('findNgStateEntry', () => {
  it('finds the announcement-search entry on the index page by its URL, not by key order', () => {
    const $ = cheerio.load(loadFixture('search-posting-pg1.html'));
    const state = extractNgState($);
    const entry = findNgStateEntry(state, /\/api\/v3\/announcement-search$/);
    expect(entry).not.toBeNull();
    expect(entry?.u).toContain('announcement-search');
  });

  it('finds the announcement detail entry on a detail page by its URL', () => {
    const $ = cheerio.load(loadFixture('detail-492368-email-application.html'));
    const state = extractNgState($);
    const entry = findNgStateEntry(state, /\/api\/v3\/announcement\/[0-9]+$/);
    expect(entry).not.toBeNull();
    expect(entry?.u).toBe('https://api.p.hr.ge/public-portal/tenant/1/api/v3/announcement/492368');
  });

  it('returns null when no entry matches, rather than throwing', () => {
    const $ = cheerio.load(loadFixture('detail-492368-email-application.html'));
    const state = extractNgState($);
    expect(findNgStateEntry(state, /\/does-not-exist$/)).toBeNull();
  });

  it('the same numeric key differs per page — confirms lookup cannot go by key', () => {
    const stateA = extractNgState(cheerio.load(loadFixture('detail-492368-email-application.html')));
    const stateB = extractNgState(cheerio.load(loadFixture('detail-491887-onsite-application-salary-bonus.html')));
    const entryA = findNgStateEntry(stateA, /\/api\/v3\/announcement\/[0-9]+$/);
    const entryB = findNgStateEntry(stateB, /\/api\/v3\/announcement\/[0-9]+$/);
    expect(entryA).not.toBeNull();
    expect(entryB).not.toBeNull();
    // Not asserting the keys differ by value (that's an implementation
    // detail of hr.ge's own hashing), just that lookup-by-key would be
    // fragile: both entries are found correctly by URL regardless.
    expect(entryA?.u).not.toBe(entryB?.u);
  });
});
