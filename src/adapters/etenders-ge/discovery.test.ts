import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSearchPage } from './discovery.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');
}

describe('parseSearchPage', () => {
  const first = parseSearchPage(fixture('search-live-p1.html'));
  const last = parseSearchPage(fixture('search-live-p2-last-restricted.html'));

  it('reads one card per tender, 20 to a full search page, with its paging', () => {
    expect(first.cards).toHaveLength(20);
    expect(new Set(first.cards.map((card) => card.sourceRecordId)).size).toBe(20);
    expect(first).toMatchObject({ activePage: 1, lastPage: 2 });
    expect(last).toMatchObject({ activePage: 2, lastPage: 2 });
    expect(last.cards).toHaveLength(18);
  });

  it('reads buyer, title, dates, status code and detail URL from a live card', () => {
    const card = first.cards.find((c) => c.sourceRecordId === '69679');
    expect(card).toMatchObject({
      url: 'https://etenders.ge/view/69679/x',
      kind: 'tender',
      buyerRaw: 'სს "თიბისი ბანკი"',
      titleRaw: '0007464 Cisco hardware',
      announcedRaw: '05/10/2026',
      endRaw: '13/10/2026',
      statusCode: 1,
      statusText: 'გამოცხადებულია',
      restricted: false,
      anonymous: false,
      amendedRaw: '05/10/2026 11:22:13',
    });
    expect(card?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('only shows live statuses on a live-set page', () => {
    for (const card of [...first.cards, ...last.cards]) {
      expect([1, 2, 3]).toContain(card.statusCode);
    }
  });

  it('marks locked invite-only cards and gives them no detail URL', () => {
    const locked = last.cards.filter((card) => card.restricted);
    expect(locked.length).toBeGreaterThan(0);
    for (const card of locked) {
      expect(card.url).toBeNull();
      expect(card.titleRaw).not.toBeNull();
    }
    for (const card of last.cards.filter((c) => !c.restricted)) {
      expect(card.url).toBe(`https://etenders.ge/view/${card.sourceRecordId}/x`);
    }
  });

  it('lists live tenders first in a date window, which spans several pages', () => {
    // The site orders every list live-first (announced, bids open, bidding),
    // then finished ones by end date; page 1 of a window is all live.
    const window = parseSearchPage(fixture('search-window-p1.html'));
    expect(window.cards).toHaveLength(20);
    expect(window.lastPage).toBeGreaterThan(1);
    for (const card of window.cards) expect([1, 2, 3]).toContain(card.statusCode);
  });

  it('tells an empty result (no cards, no active page) from a real page', () => {
    expect(parseSearchPage(fixture('search-empty.html'))).toEqual({
      cards: [],
      activePage: null,
      lastPage: 0,
    });
  });

  it('changes the fingerprint when the amendment stamp or status changes', () => {
    const card = first.cards.find((c) => c.amendedRaw !== null);
    expect(card).toBeDefined();
    if (card === undefined) return;
    const html = fixture('search-live-p1.html');
    const amended = parseSearchPage(
      html.replace(`ცვლილება: ${card.amendedRaw}`, 'ცვლილება: 01/01/2030 00:00:00'),
    );
    expect(
      amended.cards.find((c) => c.sourceRecordId === card.sourceRecordId)?.fingerprint,
    ).not.toBe(card.fingerprint);
  });
});
