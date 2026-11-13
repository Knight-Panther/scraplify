import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

/**
 * The course listing (`/courses/`, FacetWP over WordPress). Each page holds
 * up to 12 cards and an inline `window.FWP_JSON` whose `preload_data` carries
 * the pager and every facet's choices with their counts. The site sorts the
 * listing at random and its page cache keeps each URL up to 2 h, so pages of
 * one listing are independent samples: membership is read from result sets
 * small enough to fit on one page (crawl.ts), never by paging a large one.
 */

export class SummerSchoolsListingParseError extends Error {
  constructor(message: string) {
    super(`summerschoolsineurope.eu listing: ${message}`);
    this.name = 'SummerSchoolsListingParseError';
  }
}

export interface CourseCard {
  /** WordPress post id (the card's favourite button), the source record id. */
  postId: string;
  /** The course page, `https://www.summerschoolsineurope.eu/course/<slug>/`. */
  url: string;
  title: string;
  /** The school (the card's `data-destination`), the site's organiser facet. */
  school: string | null;
  /** "City, Country" as printed. */
  placeRaw: string | null;
  whenRaw: string | null;
  creditsRaw: string | null;
  feeRaw: string | null;
  languageRaw: string | null;
  /** The registration deadline badge without its label, e.g. "01 December" (no year). */
  deadlineRaw: string | null;
  online: boolean;
  /** Paid placement: stored, never part of the fingerprint. */
  topCourse: boolean;
  /** What a change of the card means a change of the course; see cardFingerprint. */
  fingerprint: string;
}

export interface ListingPager {
  page: number;
  perPage: number;
  totalRows: number;
  totalPages: number;
}

export interface FacetChoice {
  value: string;
  label: string;
  count: number;
}

export interface ParsedListingPage {
  cards: CourseCard[];
  pager: ListingPager;
  /** Each facet's choices, keyed by facet name (`course_country`, `course_city`, …). */
  facets: Record<string, FacetChoice[]>;
}

const DEADLINE_TAG = /^Deadline:\s*(.+)$/;

function clean(text: string | undefined | null): string | null {
  const value = text?.replace(/\s+/g, ' ').trim();
  return value ? value : null;
}

/**
 * The object assigned to `window.FWP_JSON`, read by matching braces outside
 * string literals, so a brace or quote inside a string cannot cut it short.
 */
export function extractFwpJson(html: string): unknown {
  const marker = html.indexOf('FWP_JSON');
  if (marker === -1) throw new SummerSchoolsListingParseError('no FWP_JSON');
  const start = html.indexOf('{', marker);
  if (start === -1) throw new SummerSchoolsListingParseError('no FWP_JSON object');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          throw new SummerSchoolsListingParseError('FWP_JSON is not JSON');
        }
      }
    }
  }
  throw new SummerSchoolsListingParseError('FWP_JSON never closes');
}

function readPager(fwp: unknown): ListingPager {
  const pager = (fwp as { preload_data?: { settings?: { pager?: Record<string, unknown> } } })
    ?.preload_data?.settings?.pager;
  const read = (key: string): number => {
    const value = pager?.[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new SummerSchoolsListingParseError(`pager has no ${key}`);
    }
    return value;
  };
  return {
    page: read('page'),
    perPage: read('per_page'),
    totalRows: read('total_rows'),
    totalPages: read('total_pages'),
  };
}

function readFacets(fwp: unknown): Record<string, FacetChoice[]> {
  const facets = (fwp as { preload_data?: { facets?: Record<string, unknown> } })?.preload_data
    ?.facets;
  const result: Record<string, FacetChoice[]> = {};
  if (facets === undefined || facets === null) return result;
  for (const [name, markup] of Object.entries(facets)) {
    if (typeof markup !== 'string') continue;
    const $ = cheerio.load(markup);
    const choices: FacetChoice[] = [];
    $('[data-value]').each((_, element) => {
      const node = $(element);
      const value = node.attr('data-value');
      const label = clean(node.find('.facetwp-display-value').first().text());
      const count = /\((\d+)\)/.exec(node.find('.facetwp-counter').first().text())?.[1];
      if (value === undefined || value === '' || label === null || count === undefined) return;
      choices.push({ value, label, count: Number(count) });
    });
    if (choices.length > 0) result[name] = choices;
  }
  return result;
}

/**
 * A card's fingerprint: the facts a course page would also show, so a
 * changed card means the course page is worth reading again. "Top course"
 * (paid placement), images and card order are left out.
 */
export function cardFingerprint(
  card: Pick<
    CourseCard,
    | 'title'
    | 'school'
    | 'placeRaw'
    | 'whenRaw'
    | 'creditsRaw'
    | 'feeRaw'
    | 'languageRaw'
    | 'deadlineRaw'
    | 'online'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        card.title,
        card.school,
        card.placeRaw,
        card.whenRaw,
        card.creditsRaw,
        card.feeRaw,
        card.languageRaw,
        card.deadlineRaw,
        card.online,
      ]),
    )
    .digest('hex');
}

/**
 * Parses one listing page. Throws SummerSchoolsListingParseError, so the
 * walk treats the page as failed, when the FWP_JSON pager is missing or a
 * card lacks its post id, link or title: drift, not a value to guess.
 */
export function parseListingPage(html: string): ParsedListingPage {
  const fwp = extractFwpJson(html);
  const pager = readPager(fwp);
  const facets = readFacets(fwp);
  const $ = cheerio.load(html);
  const cards: CourseCard[] = [];

  $('article.course-card').each((index, element) => {
    const article = $(element);
    const postId = article.find('[data-post-id]').first().attr('data-post-id');
    if (postId === undefined || !/^[1-9][0-9]*$/.test(postId)) {
      throw new SummerSchoolsListingParseError(`card ${index + 1} has no post id`);
    }
    const url = article.find('a.overlay-link').first().attr('href');
    if (url === undefined || url === '') {
      throw new SummerSchoolsListingParseError(`card ${postId} has no link`);
    }
    const body = article.children('div').first();
    const title = clean(body.find('h3').first().text());
    if (title === null) throw new SummerSchoolsListingParseError(`card ${postId} has no title`);

    const fields = new Map<string, string>();
    const cells = body.find('div.grid > p').toArray();
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const label = clean($(cells[i]).text())?.replace(/:$/, '');
      const value = clean($(cells[i + 1]).text());
      if (label !== undefined && value !== null) fields.set(label, value);
    }

    const tags = article
      .find('span.card-tag')
      .toArray()
      .map((tag) => clean($(tag).text()))
      .filter((tag): tag is string => tag !== null);
    const deadlineRaw =
      tags.map((tag) => DEADLINE_TAG.exec(tag)?.[1]).find((raw) => raw !== undefined) ?? null;

    const card = {
      postId,
      url: new URL(url, 'https://www.summerschoolsineurope.eu/').toString(),
      title,
      school: clean(article.attr('data-destination')),
      placeRaw: clean(body.children('p').first().text()),
      whenRaw: fields.get('When') ?? null,
      creditsRaw: fields.get('Credits') ?? null,
      feeRaw: fields.get('Fee') ?? null,
      languageRaw: fields.get('Language') ?? null,
      deadlineRaw: clean(deadlineRaw),
      online: tags.includes('Online'),
      topCourse: tags.includes('Top course'),
    };
    cards.push({ ...card, fingerprint: cardFingerprint(card) });
  });

  return { cards, pager, facets };
}
