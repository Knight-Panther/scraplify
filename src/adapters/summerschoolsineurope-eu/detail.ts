import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { SourceListingRevisionContent } from '../../db/write-source-listing-revision.js';
import {
  deadlineInstant,
  type ParsedWhen,
  parseFullDate,
  parseWhen,
  resolveCardDeadline,
} from './dates.js';
import { type Credits, type Fee, parseCredits, parseFee } from './money.js';

export const SUMMER_SCHOOLS_DETAIL_PARSER_VERSION = 'v1';

export class SummerSchoolsDetailParseError extends Error {
  constructor(message: string) {
    super(`summerschoolsineurope.eu course page: ${message}`);
    this.name = 'SummerSchoolsDetailParseError';
  }
}

export interface FeeOption {
  amount: number | null;
  currency: string | null;
  label: string | null;
}

export interface Discipline {
  /** The listing facet's value, when the crawl knows it; null otherwise. */
  slug: string | null;
  name: string;
}

/**
 * A course's structured attributes. They are public, so every string in
 * them is bounded (300 characters at most); the full text stays in the
 * revision's description, which the public views blank.
 */
export interface CourseAttributes {
  kind: 'programme';
  opportunityKind: 'summer_school';
  audience: ['individuals'];
  callStatus: 'open';
  excerpt: string | null;
  postId: string;
  season: 'summer' | 'winter' | 'spring' | 'autumn' | null;
  startDate: string | null;
  endDate: string | null;
  whenRaw: string | null;
  durationDays: number | null;
  datesSuspect: boolean;
  school: string | null;
  schoolSlug: string | null;
  institution: string | null;
  city: string | null;
  citySlugs: string[];
  country: string | null;
  countrySlug: string | null;
  /** 'online' when the card says so; null otherwise (on site or hybrid: the site does not say which). */
  format: 'online' | null;
  language: string | null;
  credits: Credits | null;
  fee: Fee | null;
  feeOptions: FeeOption[];
  earlyBirdDeadline: string | null;
  registration: 'external' | 'on_source' | null;
  schoolUrl: string | null;
  disciplines: Discipline[];
  /** JSON-LD dateModified, else datePublished: when the source last changed the page. */
  modifiedAt: string | null;
  /** Title, school and city with accents folded, so "Krakow" finds "Kraków". */
  searchFold: string;
}

export interface ParseCoursePageInput {
  html: string;
  /** The card's post id; the page must be that post. */
  expectedPostId: string;
  /**
   * Facts only the listing card carries. `deadlineParsed` is a deadline
   * carried from an earlier read (a badge gone after its day), kept as it
   * was instead of resolved again against dates that may have moved.
   */
  card: { deadlineRaw: string | null; online: boolean; deadlineParsed?: string };
  /** Discipline name → the listing facet's value, from the walk's `course_discipline` choices. */
  disciplineSlugs?: ReadonlyMap<string, string>;
  extractionMethod: SourceListingRevisionContent['extractionMethod'];
  provenance: SourceListingRevisionContent['provenance'];
}

const ATTRIBUTE_MAX = 300;
const EXCERPT_MAX = 280;
const FEE_LABEL_MAX = 120;
/** The body sections kept as the description, in page order. "Course leader" names people and is left out. */
const DESCRIPTION_SECTIONS = new Set(['About', 'Target group', 'Course aim', 'Fee info']);
const PRETITLE_RE = /<p class="pretitle">([\s\S]*?)<\/p>/;
const SEASON_RE = /\s+(Summer|Winter|Spring|Autumn|Fall)\s+Course\s*$/i;
const EARLY_BIRD_RE = /Early Bird deadline\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });
const words = new Intl.Segmenter('en', { granularity: 'word' });

function clean(text: string | undefined | null): string | null {
  const value = text?.replace(/\s+/g, ' ').trim();
  return value ? value : null;
}

/** At most `max` graphemes, cut at a word boundary, with an ellipsis when cut. Never `slice`. */
function bounded(text: string, max: number): string {
  const all = [...graphemes.segment(text)].map((part) => part.segment);
  if (all.length <= max) return text;
  const head = all.slice(0, max - 1).join('');
  let cut = 0;
  for (const word of words.segment(head)) {
    if (!word.isWordLike) continue;
    cut = word.index + word.segment.length;
  }
  return `${(cut > 0 ? head.slice(0, cut) : head).trimEnd()}…`;
}

/** At most `max` characters, or null: for public attribute strings that cannot be cut, like URLs. */
function withinLimit(text: string | null): string | null {
  return text !== null && text.length <= ATTRIBUTE_MAX ? text : null;
}

function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text with `<br>` and blocks turned into line breaks (cheerio's `.text()` drops them). */
function blockText($: cheerio.CheerioAPI, nodes: cheerio.Cheerio<never>): string {
  const copy = nodes.clone();
  copy.find('br').replaceWith('\n');
  copy.find('p, div, li, tr, h3, h4, table').each((_, node) => {
    $(node).append('\n');
  });
  return copy
    .toArray()
    .map((node) => $(node).text())
    .join('\n')
    .split('\n')
    .map((line) => line.replace(/[\s ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function slugFromQuery(href: string | undefined, param: string): string | null {
  if (href === undefined) return null;
  try {
    return clean(new URL(href, 'https://www.summerschoolsineurope.eu/').searchParams.get(param));
  } catch {
    return null;
  }
}

function readPostId($: cheerio.CheerioAPI, header: cheerio.Cheerio<never>): string {
  const shortlink = $('link[rel="shortlink"]').attr('href');
  const fromShortlink = /[?&]p=(\d+)/.exec(shortlink ?? '')?.[1];
  const fromButton = header.find('[data-post-id]').first().attr('data-post-id');
  if (fromShortlink === undefined && fromButton === undefined) {
    throw new SummerSchoolsDetailParseError('no post id');
  }
  if (fromShortlink !== undefined && fromButton !== undefined && fromShortlink !== fromButton) {
    throw new SummerSchoolsDetailParseError(
      `the shortlink names post ${fromShortlink}, the page post ${fromButton}`,
    );
  }
  return (fromShortlink ?? fromButton) as string;
}

function readJsonLdDates($: cheerio.CheerioAPI): {
  published: string | null;
  modified: string | null;
} {
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    let data: unknown;
    try {
      data = JSON.parse($(script).text());
    } catch {
      continue;
    }
    const graph = (data as { '@graph'?: unknown[] })['@graph'] ?? [data];
    for (const node of graph as Record<string, unknown>[]) {
      if (node?.['@type'] !== 'WebPage') continue;
      const published = typeof node.datePublished === 'string' ? node.datePublished : null;
      const modified = typeof node.dateModified === 'string' ? node.dateModified : null;
      return { published, modified };
    }
  }
  return { published: null, modified: null };
}

function instant(raw: string | null): string | null {
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The pretitle "Business &amp; Entrepreneurship & Psychology Summer Course": names escaped one by one, joined by a raw " & ". */
function readPretitle(
  html: string,
  slugs: ReadonlyMap<string, string>,
): { season: CourseAttributes['season']; disciplines: Discipline[] } {
  // Read from the page's own bytes: cheerio re-escapes every "&" when it
  // serializes, which would erase the difference between the two.
  const raw = PRETITLE_RE.exec(html)?.[1];
  if (raw === undefined) return { season: null, disciplines: [] };
  const seasonMatch = SEASON_RE.exec(raw);
  const seasonWord = seasonMatch?.[1]?.toLowerCase();
  const season =
    seasonWord === 'fall'
      ? 'autumn'
      : seasonWord === 'summer' ||
          seasonWord === 'winter' ||
          seasonWord === 'spring' ||
          seasonWord === 'autumn'
        ? seasonWord
        : null;
  const names = raw
    .replace(SEASON_RE, '')
    .replace(/\s+Course\s*$/i, '')
    .split(/\s+&(?![a-zA-Z#0-9]+;)\s+/)
    .map((part) => clean(cheerio.load(`<p>${part}</p>`)('p').text()))
    .filter((name): name is string => name !== null);
  return {
    season,
    disciplines: names.map((name) => ({ slug: slugs.get(name) ?? null, name })),
  };
}

/** The header grid's label → value cell. */
function readGrid(
  $: cheerio.CheerioAPI,
  header: cheerio.Cheerio<never>,
): Map<string, cheerio.Cheerio<never>> {
  const cells = header.find('div.grid').first().children('p').toArray();
  const grid = new Map<string, cheerio.Cheerio<never>>();
  for (let i = 0; i + 1 < cells.length; i += 2) {
    const label = clean($(cells[i]).text())?.replace(/:$/, '');
    if (label !== undefined && !grid.has(label)) grid.set(label, $(cells[i + 1]) as never);
  }
  return grid;
}

/** "1850 EUR, Student": the amount before the first comma, the rest as a bounded label. */
function readFeeOptions($: cheerio.CheerioAPI, section: cheerio.Cheerio<never>): FeeOption[] {
  const cells = section.find('div.grid').first().children('p').toArray();
  const options: FeeOption[] = [];
  for (let i = 0; i + 1 < cells.length; i += 2) {
    if (clean($(cells[i]).text())?.replace(/:$/, '') !== 'Fee') continue;
    const value = clean($(cells[i + 1]).text());
    if (value === null) continue;
    const comma = value.indexOf(',');
    const amountText = comma === -1 ? value : value.slice(0, comma);
    const labelText = comma === -1 ? null : clean(value.slice(comma + 1));
    const fee = parseFee(amountText);
    options.push({
      amount: fee?.amount ?? null,
      currency: fee?.currency ?? null,
      label: labelText === null ? null : bounded(labelText, FEE_LABEL_MAX),
    });
  }
  return options;
}

/** The body's sections, keyed by their `h2`, each the text up to the next `h2`. */
function readSections($: cheerio.CheerioAPI): { heading: string; nodes: cheerio.Cheerio<never> }[] {
  const content = $('section.text-only div.content').first();
  const sections: { heading: string; nodes: cheerio.Cheerio<never> }[] = [];
  let current: { heading: string; nodes: unknown[] } | null = null;
  for (const node of content.contents().toArray()) {
    if (node.type === 'tag' && node.name === 'h2') {
      current = { heading: clean($(node).text()) ?? '', nodes: [] };
      sections.push(current as never);
      continue;
    }
    current?.nodes.push(node);
  }
  return sections.map((section) => ({
    heading: section.heading,
    nodes: $(section.nodes as never) as never,
  }));
}

/** The first sentence of "About" (two when the first is short), stripped of contacts and links. */
function excerptFrom(about: string | null): string | null {
  if (about === null) return null;
  const text = about.replace(/\s+/g, ' ').trim();
  const parts = [...sentences.segment(text)].map((part) => part.segment.trim()).filter(Boolean);
  let excerpt = parts[0] ?? '';
  if (excerpt.length < 120 && parts[1] !== undefined) excerpt = `${excerpt} ${parts[1]}`;
  excerpt = excerpt
    .replace(EMAIL_RE, '')
    .replace(URL_RE, '')
    .replace(PHONE_RE, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return excerpt === '' ? null : bounded(excerpt, EXCERPT_MAX);
}

function normalizeTitle(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Parses one course page (`/course/<slug>/`) with the facts only its card
 * carries (the registration deadline badge, the Online tag) into a revision.
 * Reads the header section only: the page's foot lists other courses as
 * cards, deadline badges included.
 *
 * Throws SummerSchoolsDetailParseError, so the crawl quarantines the
 * listing, when the page is not the requested post, or has no title or no
 * facts grid. Everything else is optional and stays an explicit null.
 */
export function parseCoursePage(input: ParseCoursePageInput): SourceListingRevisionContent {
  const $ = cheerio.load(input.html);
  const header = $('section.header').first() as unknown as cheerio.Cheerio<never>;
  const postId = readPostId($, header);
  if (postId !== input.expectedPostId) {
    throw new SummerSchoolsDetailParseError(
      `page is post ${postId}, not the requested ${input.expectedPostId}`,
    );
  }
  const titleRaw = clean(header.find('h1').first().text());
  if (titleRaw === null) throw new SummerSchoolsDetailParseError('no title');
  const grid = readGrid($, header);
  if (!grid.has('When')) throw new SummerSchoolsDetailParseError('no facts grid');

  const text = (label: string): string | null => clean(grid.get(label)?.text());
  const when: ParsedWhen = parseWhen(text('When'));
  const school = text('School');
  const schoolSlug =
    /\/destination\/([a-z0-9-]+)\/?$/.exec(grid.get('School')?.find('a').attr('href') ?? '')?.[1] ??
    null;
  const institutionText = text('Institution');
  const institution =
    institutionText === null || /^n\/?a$/i.test(institutionText) ? null : institutionText;
  const cityLinks = (grid.get('City')?.find('a').toArray() ?? []).map((link) => ({
    name: clean($(link).text()),
    slug: slugFromQuery($(link).attr('href'), '_course_city'),
  }));
  const cityNames = cityLinks
    .map((link) => link.name)
    .filter((name): name is string => name !== null);
  const city = cityNames.length > 0 ? cityNames.join(' and ') : text('City');
  const country = text('Country');
  const countrySlug = slugFromQuery(grid.get('Country')?.find('a').attr('href'), '_course_country');

  const { season, disciplines } = readPretitle(input.html, input.disciplineSlugs ?? new Map());
  const earlyBird = parseFullDate(EARLY_BIRD_RE.exec(header.text())?.[1] ?? null);

  const canonicalUrl = $('link[rel="canonical"]').attr('href') ?? null;
  const headerButton = header.find('.button-group a.btn').first();
  const headerHref = headerButton.attr('href') ?? null;
  const onSource = headerHref?.startsWith('#') === true;
  const registerUrl = headerHref !== null && !onSource ? headerHref : null;
  const schoolButton = $('section.course-information a.btn')
    .filter((_, link) => /visit school/i.test($(link).text()))
    .first();
  const schoolUrl = onSource ? withinLimit(schoolButton.attr('href') ?? null) : null;
  const registration: CourseAttributes['registration'] =
    registerUrl !== null ? 'external' : onSource ? 'on_source' : null;
  const applicationMethod: SourceListingRevisionContent['applicationMethod'] =
    registerUrl !== null
      ? { type: 'url', value: registerUrl }
      : onSource && canonicalUrl !== null
        ? { type: 'form', value: canonicalUrl }
        : { type: 'unspecified', value: null };

  const sections = readSections($);
  const description = sections
    .filter((section) => DESCRIPTION_SECTIONS.has(section.heading))
    .map((section) => `${section.heading}\n${blockText($, section.nodes)}`.trim())
    .join('\n\n');
  const about = sections.find((section) => section.heading === 'About');
  const feeInfo = sections.find((section) => section.heading === 'Fee info');
  const feeOptions =
    feeInfo === undefined
      ? []
      : readFeeOptions($, $('<div>').append(feeInfo.nodes.clone()) as never);

  const dates = readJsonLdDates($);
  const online = input.card.online;
  const place = city !== null && country !== null ? `${city}, ${country}` : (city ?? country);
  const resolvedDeadline = resolveCardDeadline(
    input.card.deadlineRaw,
    when.startDate,
    when.endDate,
  );

  const attributes: CourseAttributes = {
    kind: 'programme',
    opportunityKind: 'summer_school',
    audience: ['individuals'],
    callStatus: 'open',
    excerpt: excerptFrom(about === undefined ? null : blockText($, about.nodes)),
    postId,
    season,
    startDate: when.startDate,
    endDate: when.endDate,
    whenRaw: when.raw,
    durationDays: when.durationDays,
    datesSuspect: when.suspect,
    school,
    schoolSlug,
    institution,
    city,
    citySlugs: cityLinks.map((link) => link.slug).filter((slug): slug is string => slug !== null),
    country,
    countrySlug,
    format: online ? 'online' : null,
    language: text('Language'),
    credits: parseCredits(text('Credits')),
    fee: parseFee(text('Fee')),
    feeOptions,
    earlyBirdDeadline: earlyBird,
    registration,
    schoolUrl,
    disciplines,
    modifiedAt: instant(dates.modified ?? dates.published),
    searchFold: fold([titleRaw, school, city].filter(Boolean).join(' ')).slice(0, ATTRIBUTE_MAX),
  };

  const titleNormalized = normalizeTitle(titleRaw);
  const locations = online || place === null ? [] : [place];
  const sourceCategories = disciplines.map((discipline) => discipline.name);
  const deadlineDate = {
    raw: input.card.deadlineRaw,
    parsed:
      input.card.deadlineParsed ??
      (resolvedDeadline === null ? null : deadlineInstant(resolvedDeadline)),
  };
  const publishedDate = { raw: dates.published, parsed: instant(dates.published) };
  const { modifiedAt: _modifiedAt, ...meaningfulAttributes } = attributes;
  const meaningfulContentHash = createHash('sha256')
    .update(
      JSON.stringify({
        titleNormalized,
        organizationRaw: school,
        description,
        locations,
        publishedRaw: publishedDate.raw,
        deadlineRaw: deadlineDate.raw,
        applicationMethod,
        sourceCategories,
        attributes: meaningfulAttributes,
      }),
    )
    .digest('hex');

  return {
    parserVersion: SUMMER_SCHOOLS_DETAIL_PARSER_VERSION,
    extractionMethod: input.extractionMethod,
    rawResourceHash: createHash('sha256').update(input.html).digest('hex'),
    meaningfulContentHash,
    titleRaw,
    titleNormalized,
    organizationRaw: school,
    description,
    locations,
    salaryRaw: null,
    publishedDate,
    deadlineDate,
    applicationMethod,
    sourceCategories,
    structuredAttributes: attributes as unknown as Record<string, unknown>,
    provenance: input.provenance,
  };
}
