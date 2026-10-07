import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { etendersGeSource } from '../../policies/etenders-ge.js';

/**
 * One tender card from an etenders.ge `/search/` page. Cards repeat their
 * markup for desktop and mobile with duplicate `id` attributes, so callers
 * get one entry per tender ID, never one per table.
 */
export interface TenderCard {
  sourceRecordId: string;
  /** `/view/<id>/x` for a public tender, or null when the card has no detail link (locked or not a tender). */
  url: string | null;
  kind: 'tender' | 'sale' | 'unknown';
  buyerRaw: string | null;
  titleRaw: string | null;
  /** Card dates, date only ("გამოცხადების თარიღი" / "დასრულების თარიღი"). */
  announcedRaw: string | null;
  endRaw: string | null;
  /** From the `status_N` class: 1 announced, 2 bids open, 3 bidding, 4 terminated, 5 failed, 99 completed. */
  statusCode: number | null;
  statusText: string | null;
  /** Lock icon: an invite-only procedure whose details are closed to the public (terms §2.7). */
  restricted: boolean;
  /** "ანონიმური ტენდერი": the buyer's identity is hidden by design (terms §2.8). */
  anonymous: boolean;
  /** The amendment stamp ("ცვლილება: DD/MM/YYYY HH:MM:SS"), present only on amended tenders. */
  amendedRaw: string | null;
  /**
   * Hash of everything on the card that a detail refetch should follow:
   * status, end date, amendment stamp, title, buyer. A change in any of
   * them means the detail page is worth fetching again (Phase 7C refetch).
   */
  fingerprint: string;
}

export interface SearchPage {
  cards: TenderCard[];
  /** The page the server marked active, or null when the page has no paging at all (an empty result). */
  activePage: number | null;
  /** The highest page number the paging links mention, at least the active page. */
  lastPage: number;
}

export const ANONYMOUS_BUYER = 'ანონიმური ტენდერი';
const AMENDED_RE = /ცვლილება:\s*(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(?::\d{2})?)/;
const ANNOUNCED_LABEL = 'გამოცხადების თარიღი';
const END_LABEL = 'დასრულების თარიღი';

function clean(text: string): string | null {
  const value = text.replace(/\s+/g, ' ').trim();
  return value === '' ? null : value;
}

function labelledDate(text: string, label: string): string | null {
  const match = new RegExp(`${label}:\\s*(\\d{2}\\/\\d{2}\\/\\d{4})`).exec(text);
  return match?.[1] ?? null;
}

function detailLink(
  card: ReturnType<cheerio.CheerioAPI>,
): { url: string | null; kind: TenderCard['kind'] } {
  // The "details" button sits outside the card's own table, in the
  // enclosing one (desktop) and a sibling table (mobile); the nearest
  // enclosing table holds the desktop copy.
  const href = card.parents('table').first().find('a.detail-btn').first().attr('href');
  if (href === undefined) return { url: null, kind: 'unknown' };
  const match = /^\/(view|viewsale)\/(\d+)(?:\/|$)/.exec(href);
  if (match === null) return { url: null, kind: 'unknown' };
  if (match[1] === 'viewsale') return { url: null, kind: 'sale' };
  return {
    url: new URL(`/view/${match[2]}/x`, etendersGeSource.baseUrl).toString(),
    kind: 'tender',
  };
}

function fingerprintOf(card: Omit<TenderCard, 'fingerprint'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        card.statusCode,
        card.endRaw,
        card.amendedRaw,
        card.titleRaw,
        card.buyerRaw,
        card.restricted,
      ]),
    )
    .digest('hex');
}

/**
 * Parses one `/search/` page. Field locations, confirmed on 2026-10-07
 * captures (fixtures/): row 1 of `table.RightNAndStarAndDetails` is the
 * buyer, row 2 the title, row 3 holds the `#<id>` number plus the lock and
 * amendment icons, row 4 the two dates and the `span.stst.status_N` status.
 * A card that does not yield a numeric ID is skipped rather than guessed;
 * the crawl's own guards notice a page whose cards stop parsing.
 */
export function parseSearchPage(html: string): SearchPage {
  const $ = cheerio.load(html);
  const cards = new Map<string, TenderCard>();

  for (const element of $('table.RightNAndStarAndDetails').toArray()) {
    const table = $(element);
    const rows = table.children('tbody').length
      ? table.children('tbody').children('tr')
      : table.children('tr');
    const idText = rows
      .eq(2)
      .find('span')
      .toArray()
      .map((span) => $(span).text().trim());
    const sourceRecordId = idText.find((text) => /^[1-9][0-9]*$/.test(text));
    if (sourceRecordId === undefined || cards.has(sourceRecordId)) continue;

    const buyerRaw = clean(rows.eq(0).text());
    const titleRaw = clean(rows.eq(1).text());
    const datesText = rows.eq(3).text().replace(/\s+/g, ' ');
    const status = table.find('span.stst').first();
    const statusClass = (status.attr('class') ?? '')
      .split(/\s+/)
      .find((name) => /^status_\d+$/.test(name));
    const statusCode =
      statusClass === undefined ? null : Number(statusClass.slice('status_'.length));
    const statusText = clean(status.text().replace(/^\s*სტატუსი:\s*/, ''));
    const restricted = table.find('img[src*="lock"]').length > 0;
    let amendedRaw: string | null = null;
    for (const anchor of table.find('a[href]').toArray()) {
      const match = AMENDED_RE.exec($(anchor).attr('href') ?? '');
      if (match?.[1] !== undefined) {
        amendedRaw = match[1].replace(/\s+/g, ' ');
        break;
      }
    }
    const { url, kind } = detailLink(table);

    const card: Omit<TenderCard, 'fingerprint'> = {
      sourceRecordId,
      url,
      kind,
      buyerRaw,
      titleRaw,
      announcedRaw: labelledDate(datesText, ANNOUNCED_LABEL),
      endRaw: labelledDate(datesText, END_LABEL),
      statusCode,
      statusText,
      restricted,
      anonymous: buyerRaw === ANONYMOUS_BUYER,
      amendedRaw,
    };
    cards.set(sourceRecordId, { ...card, fingerprint: fingerprintOf(card) });
  }

  let activePage: number | null = null;
  let lastPage = 0;
  for (const cell of $('table.paging-tbl td.page-numbers').toArray()) {
    const td = $(cell);
    if (td.hasClass('active')) {
      const value = Number(td.text().trim());
      if (Number.isInteger(value) && value > 0) activePage = value;
    }
    const href = td.find('a').attr('href');
    const pg = href === undefined ? null : /[?&]pg=(\d+)/.exec(href)?.[1];
    if (pg !== undefined && pg !== null) lastPage = Math.max(lastPage, Number(pg));
  }
  if (activePage !== null) lastPage = Math.max(lastPage, activePage);

  return { cards: [...cards.values()], activePage, lastPage };
}
