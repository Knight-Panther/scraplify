import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { SourceListingRevisionContent } from '../../db/write-source-listing-revision.js';
import { etendersGeSource } from '../../policies/etenders-ge.js';
import { type ParsedEtendersDate, parseEtendersDate } from './dates.js';
import { type MoneyAmount, type PriceBasis, parseMoneyAmount, parsePriceBasis } from './money.js';

export const ETENDERS_GE_DETAIL_PARSER_VERSION = 'v1';

/** Status vocabulary (docs/addEtender.md §7): the detail page prints text only, the search card a `status_N` class. */
export const STATUS_CODES: Readonly<Record<string, number>> = {
  გამოცხადებულია: 1,
  'წინადადების მიღება დაწყებულია': 2,
  'მიმდინარეობს ვაჭრობა': 3,
  შეწყვეტილი: 4,
  'ტენდერი არ შედგა': 5,
  დასრულებული: 99,
};
/** Statuses during which a tender is still open: announced, bids open, live bidding. */
export const LIVE_STATUS_CODES: ReadonlySet<number> = new Set([1, 2, 3]);

/** Procurement methods; the code itself comes from the page's `TenderTypeHelp_Type__N` help key. */
const METHOD_CODES: Readonly<Record<string, number>> = {
  განცხადება: 1,
  'რევერსული აუქციონი': 2,
  'ტენდერი ერთი კონვერტის პრინციპით': 3,
  '1 კონვერტის პრინციპი': 3,
  '2 კონვერტის პრინციპი': 4,
  პრეკვალიფიკაცია: 5,
};

const NUMBER_LABELS = ['ტენდერის ნომერი', 'განცხადების ნომერი'];
const BIDDERS_LABEL = 'პრეტენდენტების რაოდენობა';
const STATUS_LABEL = 'სტატუსი';
const SUBMISSION_LABEL = 'წინადადებების წარდგენის ფორმა';
const SUBMISSION_ON_PLATFORM = 'ელექტრონულად';
const METHOD_LABEL = 'ტენდერის ტიპი';
const ANNOUNCED_LABEL = 'გამოცხადების თარიღი';
const BID_START_LABEL = 'წინადადებების მიღების დაწყება';
const BID_END_LABEL = 'წინადადებების მიღების დასრულება';
const PRICE_BASIS_LABEL = 'პრეტენდენტებმა წინადადება უნდა წარმოადგინონ';
const MAX_VALUE_LABEL = 'მაქსიმალური ღირებულება';
const MIN_STEP_LABEL = 'ფასის კლების მინიმალური ბიჯი';
const PLACE_LABEL = 'მიწოდების / მომსახურების ადგილი';
const AUCTION_ON_TOTAL = 'ვაჭრობა იმართება ჯამურ ღირებულებაზე';
const DESCRIPTION_LABEL = 'დამატებითი ინფორმაცია:';
const DOCUMENTS_HEADING = 'დოკუმენტაცია';
const TITLE_COMMENT = 'ტენდერის სათაური';

export interface TenderDocument {
  fileId: string;
  name: string;
  description: string | null;
  date: string | null;
  /** The row's `IsObsolete1` class: a document the buyer has since replaced. */
  obsolete: boolean;
}

export interface TenderAttributes {
  kind: 'tender';
  tenderNumber: string;
  status: { code: number; text: string };
  method: { code: number; text: string | null };
  /** 'platform': bids are uploaded on etenders.ge; 'off_platform': as the description says (often email). */
  submission: 'platform' | 'off_platform' | null;
  submissionRaw: string | null;
  bidWindow: { start: ParsedEtendersDate; end: ParsedEtendersDate };
  priceBasis: PriceBasis | null;
  maxValue: MoneyAmount | null;
  minStep: MoneyAmount | null;
  auctionOnTotal: boolean;
  deliveryPlacesRaw: string | null;
  cpv: { code: string; label: string | null }[];
  buyer: { registryId: string | null; name: string | null };
  /** Shown only once bidding has closed. */
  biddersCount: number | null;
  documents: TenderDocument[];
  /** Kept out of the meaningful-content hash: a new question alone is not a new revision. */
  qa: { count: number; lastAt: string | null };
}

export interface ParseEtendersGeDetailPageInput {
  html: string;
  /** The ID the crawl asked for; a page reporting any other number is a wrong page, not a tender. */
  expectedSourceRecordId: string;
  extractionMethod: SourceListingRevisionContent['extractionMethod'];
  provenance: SourceListingRevisionContent['provenance'];
}

export class EtendersGeDetailParseError extends Error {
  constructor(message: string) {
    super(`parseEtendersGeDetailPage: ${message}`);
    this.name = 'EtendersGeDetailParseError';
  }
}

function clean(text: string | undefined | null): string | null {
  const value = text?.replace(/\s+/g, ' ').trim();
  return value ? value : null;
}

/** Text with `<br>`, paragraphs and other blocks turned into line breaks (cheerio's `.text()` drops them). */
function blockText($: cheerio.CheerioAPI, element: ReturnType<cheerio.CheerioAPI>): string {
  const copy = element.clone();
  copy.find('br').replaceWith('\n');
  copy.find('p, div, li, tr, h1, h2, h3, h4, h5, h6, table').each((_, node) => {
    $(node).append('\n');
  });
  return copy
    .text()
    .split('\n')
    .map((line) => line.replace(/[\s ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** "label : value" lines, keyed on the label's leading text; the first match wins. */
function valueAfterLabel(lines: readonly string[], label: string): string | null | undefined {
  for (const line of lines) {
    if (!line.startsWith(label)) continue;
    const rest = line.slice(label.length);
    const colon = rest.indexOf(':');
    if (colon === -1) continue;
    return clean(rest.slice(colon + 1));
  }
  return undefined;
}

function findTitle($: cheerio.CheerioAPI): string | null {
  let title: string | null = null;
  $('*')
    .contents()
    .each((_, node) => {
      if (title !== null || node.type !== 'comment') return;
      if (!node.data.includes(TITLE_COMMENT)) return;
      title = clean($(node).nextAll('span').first().text());
    });
  return title;
}

function parseCpv($: cheerio.CheerioAPI): TenderAttributes['cpv'] {
  const cell = $('a[href^="/cpvtenders/"]').first().parent();
  const entries: { code: string; label: string }[] = [];
  let current: { code: string; label: string } | null = null;
  for (const node of cell.contents().toArray()) {
    const href = node.type === 'tag' ? $(node).attr('href') : undefined;
    if (href?.startsWith('/cpvtenders/')) {
      if (current !== null) entries.push(current);
      current = { code: $(node).text().trim(), label: '' };
      continue;
    }
    if (current !== null) current.label += $(node).text();
  }
  if (current !== null) entries.push(current);
  return entries
    .filter((entry) => /^[0-9]{8}$/.test(entry.code))
    .map((entry) => ({
      code: entry.code,
      label: clean(entry.label.replace(/^\s*:\s*/, '').replace(/,\s*$/, '')),
    }));
}

function parseDocuments($: cheerio.CheerioAPI): TenderDocument[] {
  const documents: TenderDocument[] = [];
  for (const row of $('#FilesTable tr').toArray()) {
    const tr = $(row);
    const rowClass = tr.attr('class') ?? '';
    if (!/IsObsolete[01]/.test(rowClass)) continue;
    const cells = tr.children('td');
    const nameLink = cells.eq(1).find('a').first();
    const fileId = /[?&]file=([0-9a-f-]{36})/i.exec(nameLink.attr('href') ?? '')?.[1];
    const name = clean(nameLink.text());
    if (fileId === undefined || name === null) continue;
    documents.push({
      fileId: fileId.toLowerCase(),
      name,
      description: clean(cells.eq(3).text()),
      date: clean(cells.eq(5).text()),
      obsolete: rowClass.includes('IsObsolete1'),
    });
  }
  return documents;
}

function parseQa($: cheerio.CheerioAPI): TenderAttributes['qa'] {
  let count = 0;
  let lastAt: string | null = null;
  for (const row of $('#TenderCommentsTable tr').toArray()) {
    const cells = $(row).children('td');
    if (clean(cells.eq(0).text())?.replace(/:$/, '') !== 'თარიღი') continue;
    count++;
    const at = parseEtendersDate(cells.eq(2).text()).parsed;
    if (at !== null && (lastAt === null || at > lastAt)) lastAt = at;
  }
  return { count, lastAt };
}

function applicationMethodFor(
  submission: TenderAttributes['submission'],
  url: string,
  description: string,
): SourceListingRevisionContent['applicationMethod'] {
  if (submission === 'platform') return { type: 'form', value: url };
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(description)?.[0];
  if (email !== undefined) return { type: 'email', value: email };
  return { type: 'unspecified', value: null };
}

function normalizeTitle(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Parses one public etenders.ge tender page (`/view/<id>/x`) into a revision.
 * The page has almost no field IDs, so values are read by their Georgian
 * labels inside the fields box (found through the method's help link), plus
 * a few stable anchors: the buyer's `/companytenders/<registry id>/` link, the
 * `<!-- ტენდერის სათაური -->` comment before the title, `/cpvtenders/<code>/`
 * links, `div.additional-info-text`, `#FilesTable` and `#TenderCommentsTable`
 * (docs/addEtender.md §9; fixtures/ cover all five methods and every closing
 * status).
 *
 * Throws EtendersGeDetailParseError, so the crawl quarantines the listing,
 * when anything it cannot do without is missing: the tender number (and it
 * must be the one requested), the status (an unknown status text is drift,
 * not a value to guess), the method, the title, and the announcement and
 * bid-end dates. Everything else is optional and stays an explicit null.
 */
export function parseEtendersGeDetailPage(
  input: ParseEtendersGeDetailPageInput,
): SourceListingRevisionContent {
  const $ = cheerio.load(input.html);
  const headerText = $('b')
    .toArray()
    .map((node) => clean($(node).text()) ?? '');

  let tenderNumber: string | undefined;
  for (const text of headerText) {
    for (const label of NUMBER_LABELS) {
      const match = new RegExp(`^${label}:\\s*(\\d+)$`).exec(text);
      if (match?.[1] !== undefined) tenderNumber = match[1];
    }
    if (tenderNumber !== undefined) break;
  }
  if (tenderNumber === undefined) throw new EtendersGeDetailParseError('no tender number');
  if (tenderNumber !== input.expectedSourceRecordId) {
    throw new EtendersGeDetailParseError(
      `page is tender ${tenderNumber}, not the requested ${input.expectedSourceRecordId}`,
    );
  }
  const biddersCount =
    headerText
      .map((text) => new RegExp(`^${BIDDERS_LABEL}:\\s*(\\d+)$`).exec(text)?.[1])
      .map((value) => (value === undefined ? null : Number(value)))
      .find((value) => value !== null) ?? null;

  const statusElement = $('span')
    .filter((_, span) => clean($(span).children('b').first().text()) === STATUS_LABEL)
    .first();
  const statusText = clean(statusElement.text().replace(STATUS_LABEL, '').replace(/^\s*:/, ''));
  const statusCode = statusText === null ? undefined : STATUS_CODES[statusText];
  if (statusText === null || statusCode === undefined) {
    throw new EtendersGeDetailParseError(`unknown status ${JSON.stringify(statusText)}`);
  }

  const submissionRaw = clean(
    $('#ContentPlaceHolder1_EtenderOrNot')
      .text()
      .replace(new RegExp(`^\\s*${SUBMISSION_LABEL}\\s*:`), ''),
  );
  const submission =
    submissionRaw === null
      ? null
      : submissionRaw.startsWith(SUBMISSION_ON_PLATFORM)
        ? 'platform'
        : 'off_platform';

  const methodHelp = $('a[href*="TenderTypeHelp_Type__"]').first();
  const fieldsBox = methodHelp.closest('font').length
    ? methodHelp.closest('font')
    : methodHelp.closest('div');
  if (methodHelp.length === 0 || fieldsBox.length === 0) {
    throw new EtendersGeDetailParseError('no fields box (method help link not found)');
  }
  const lines = blockText($, fieldsBox).split('\n');
  const methodText = valueAfterLabel(lines, METHOD_LABEL) ?? null;
  const helpCode = /TenderTypeHelp_Type__(\d+)/.exec(methodHelp.attr('href') ?? '')?.[1];
  const methodCode =
    helpCode !== undefined
      ? Number(helpCode)
      : methodText === null
        ? undefined
        : METHOD_CODES[methodText];
  if (methodCode === undefined || methodCode < 1 || methodCode > 5) {
    throw new EtendersGeDetailParseError(
      `unknown procurement method ${JSON.stringify(methodText)}`,
    );
  }

  const publishedDate = parseEtendersDate(valueAfterLabel(lines, ANNOUNCED_LABEL));
  const bidStart = parseEtendersDate(valueAfterLabel(lines, BID_START_LABEL));
  const bidEnd = parseEtendersDate(
    lines
      .map((line) =>
        line.startsWith(BID_END_LABEL)
          ? /(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/.exec(line)?.[1]
          : null,
      )
      .find((value) => value !== null && value !== undefined),
  );
  if (publishedDate.parsed === null) throw new EtendersGeDetailParseError('no announcement date');
  if (bidEnd.parsed === null) throw new EtendersGeDetailParseError('no bid-end date');

  const titleRaw = findTitle($);
  if (titleRaw === null) throw new EtendersGeDetailParseError('no title');

  const buyerLink = $('a[href^="/companytenders/"]').first();
  const registryId = /^\/companytenders\/(\d+)\//.exec(buyerLink.attr('href') ?? '')?.[1] ?? null;
  const organizationRaw = clean(buyerLink.text());

  // The box also holds the documents, invited-companies and Q&A sections,
  // all after a "დოკუმენტაცია" heading: cut everything from that heading on.
  const descriptionBox = $('div.additional-info-text').first().clone();
  descriptionBox
    .children('span')
    .filter((_, span) => clean($(span).text()) === DESCRIPTION_LABEL)
    .remove();
  const nodes = descriptionBox.contents().toArray();
  const documentsHeading = nodes.findIndex(
    (node) => node.type === 'tag' && clean($(node).text()) === DOCUMENTS_HEADING,
  );
  if (documentsHeading !== -1) {
    for (const node of nodes.slice(documentsHeading)) $(node).remove();
  }
  const description = descriptionBox.length ? blockText($, descriptionBox) : '';

  const deliveryPlacesRaw = valueAfterLabel(lines, PLACE_LABEL) ?? null;
  const locations =
    deliveryPlacesRaw === null
      ? []
      : deliveryPlacesRaw
          .split(',')
          .map((place) => place.trim())
          .filter((place) => place !== '');
  const cpv = parseCpv($);
  const url = new URL(`/view/${tenderNumber}/x`, etendersGeSource.baseUrl).toString();

  const attributes: TenderAttributes = {
    kind: 'tender',
    tenderNumber,
    status: { code: statusCode, text: statusText },
    method: { code: methodCode, text: methodText },
    submission,
    submissionRaw,
    bidWindow: { start: bidStart, end: bidEnd },
    priceBasis: parsePriceBasis(valueAfterLabel(lines, PRICE_BASIS_LABEL)),
    maxValue: parseMoneyAmount(valueAfterLabel(lines, MAX_VALUE_LABEL)),
    minStep: parseMoneyAmount(valueAfterLabel(lines, MIN_STEP_LABEL)),
    auctionOnTotal: lines.some((line) => line.startsWith(AUCTION_ON_TOTAL)),
    deliveryPlacesRaw,
    cpv,
    buyer: { registryId, name: organizationRaw },
    biddersCount,
    documents: parseDocuments($),
    qa: parseQa($),
  };

  const titleNormalized = normalizeTitle(titleRaw);
  const applicationMethod = applicationMethodFor(submission, url, description);
  const sourceCategories = cpv.map((entry) => `cpv:${entry.code}`);
  const { qa: _qa, ...meaningfulAttributes } = attributes;
  const meaningfulContentHash = createHash('sha256')
    .update(
      JSON.stringify({
        titleNormalized,
        organizationRaw,
        description,
        locations,
        publishedRaw: publishedDate.raw,
        deadlineRaw: bidEnd.raw,
        applicationMethod,
        sourceCategories,
        attributes: meaningfulAttributes,
      }),
    )
    .digest('hex');

  return {
    parserVersion: ETENDERS_GE_DETAIL_PARSER_VERSION,
    extractionMethod: input.extractionMethod,
    rawResourceHash: createHash('sha256').update(input.html).digest('hex'),
    meaningfulContentHash,
    titleRaw,
    titleNormalized,
    organizationRaw,
    description,
    locations,
    salaryRaw: null,
    publishedDate,
    deadlineDate: bidEnd,
    applicationMethod,
    sourceCategories,
    structuredAttributes: attributes as unknown as Record<string, unknown>,
    provenance: input.provenance,
  };
}
