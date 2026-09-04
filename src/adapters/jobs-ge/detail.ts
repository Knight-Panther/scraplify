import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { SourceListingRevisionContent } from '../../db/write-source-listing-revision.js';
import { jobsGeSource } from '../../policies/jobs-ge.js';
import { parseYearlessGeorgianDate } from './dates.js';

export const JOBS_GE_DETAIL_PARSER_VERSION = 'v1';

export interface ParseJobsGeDetailPageInput {
  html: string;
  extractionMethod: SourceListingRevisionContent['extractionMethod'];
  provenance: SourceListingRevisionContent['provenance'];
}

/**
 * Every sampled detail page (RECON_NOTES.md: 18 real pages spanning ~a
 * month) shares this same `.dtable` scaffold for title/organization/dates,
 * even though the free-text description varies wildly in length and
 * content — "no single fixed template" in RECON_NOTES refers to that
 * description body, not this surrounding structure.
 */
const DTITLE_SELECTOR = 'table.dtable td.dtitle';
/** The one `.dtable` cell without the `dtitle` class — always the free-text description, confirmed across all 3 real fixtures despite their wildly different content. */
const DESCRIPTION_SELECTOR = 'table.dtable td:not(.dtitle)';

const TITLE_LABEL = 'დასახელება';
const ORGANIZATION_LABEL = 'მომწოდებელი';
const PUBLISHED_LABEL = 'გამოქვეყნდა';

const JOBS_GE_ORIGIN = new URL(jobsGeSource.baseUrl).origin;

/**
 * Finds the `.dtable` row whose label span (e.g. "დასახელება:") starts with
 * `label`. Label-text lookup rather than positional indexing (row 1, row
 * 2, ...) — more robust to markup drift, and avoids repeating the exact
 * kind of structural-position trap discovery.ts already found once (jobs.ge
 * reusing a CSS class across semantically different rows).
 */
function findLabeledRow(
  $: cheerio.CheerioAPI,
  label: string,
): ReturnType<cheerio.CheerioAPI> | null {
  for (const row of $(DTITLE_SELECTOR).toArray()) {
    const labelText = $(row).find('span.grey').first().text().trim();
    if (labelText.startsWith(label)) return $(row);
  }
  return null;
}

/** Georgian (Mkhedruli) has no case distinction, so this only meaningfully affects any Latin-script text mixed into a title (e.g. a brand name). */
function normalizeTitle(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Converts the description cell to normalized plain text, turning `<br>` into real line breaks first since cheerio's `.text()` otherwise drops them entirely. */
function extractDescription($: cheerio.CheerioAPI): string {
  const cell = $(DESCRIPTION_SELECTOR).first().clone();
  cell.find('br').replaceWith('\n');
  const raw = cell.text();
  return raw
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Application method signal, restricted to the description cell only.
 * RECON_NOTES.md's parsing gotcha: most of the page carries unrelated
 * sidebar/footer/ad links (repeated across different listings) that have
 * nothing to do with this listing's application method — the real signal
 * is specifically a `mailto:` link or a URL inside the description's own
 * text, which scoping the search to DESCRIPTION_SELECTOR already excludes
 * everything else without needing extra denylist logic.
 */
function extractApplicationMethod(
  $: cheerio.CheerioAPI,
): SourceListingRevisionContent['applicationMethod'] {
  const cell = $(DESCRIPTION_SELECTOR).first();
  const anchors = cell.find('a').toArray();

  for (const anchor of anchors) {
    const href = $(anchor).attr('href');
    if (!href?.startsWith('mailto:')) continue;
    const address = href.slice('mailto:'.length).split('?')[0]?.trim();
    if (address) return { type: 'email', value: address };
  }

  for (const anchor of anchors) {
    const href = $(anchor).attr('href');
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, jobsGeSource.baseUrl);
    } catch {
      continue;
    }
    const isExternalHttpLink =
      (resolved.protocol === 'http:' || resolved.protocol === 'https:') &&
      resolved.origin !== JOBS_GE_ORIGIN;
    if (isExternalHttpLink) return { type: 'url', value: resolved.toString() };
  }

  return { type: 'unspecified', value: null };
}

/**
 * Parses one jobs.ge detail page (`?view=jobs&id=...`) into everything
 * writeSourceListingRevision needs beyond identity (src/db/write-source-listing-revision.ts's
 * SourceListingRevisionContent — imported directly as this function's return
 * type rather than duplicated, so the two contracts can't silently drift).
 *
 * `locations` and `sourceCategories` are always empty and `salaryRaw` is
 * always null: none of the 18 real pages sampled (RECON_NOTES.md) exposed a
 * structured field for any of the three (location sometimes appears as
 * freeform text inside the description itself, e.g. "ადგილმდებარეობა:
 * თბილისი" — but only in 1 of 3 fixtures, not a confirmed stable
 * convention worth building a heuristic on yet). An explicit empty/null
 * result over a guessed one, per concept §6.2.
 *
 * Throws if the title (`დასახელება` row) can't be found — titleRaw is
 * non-nullable in the domain schema, so a page that doesn't match this
 * template at all is a genuine parse failure, not something the schema's
 * own nullability can absorb the way a missing date or organization can.
 */
export function parseJobsGeDetailPage(
  input: ParseJobsGeDetailPageInput,
): SourceListingRevisionContent {
  const $ = cheerio.load(input.html);

  const titleRow = findLabeledRow($, TITLE_LABEL);
  const titleRaw = titleRow?.find('b').first().text().trim();
  if (!titleRaw) {
    throw new Error(`parseJobsGeDetailPage: could not find listing title ("${TITLE_LABEL}" row)`);
  }

  const organizationRow = findLabeledRow($, ORGANIZATION_LABEL);
  const organizationRaw = organizationRow?.find('b').first().text().trim() || null;

  const datesRow = findLabeledRow($, PUBLISHED_LABEL);
  const dateValues = datesRow?.find('b').toArray() ?? [];
  const publishedRaw = dateValues[0] ? $(dateValues[0]).text().trim() : null;
  const deadlineRaw = dateValues[1] ? $(dateValues[1]).text().trim() : null;

  const publishedDate = publishedRaw
    ? parseYearlessGeorgianDate(publishedRaw, input.provenance.fetchedAt)
    : { raw: null, parsed: null };
  const deadlineDate = deadlineRaw
    ? parseYearlessGeorgianDate(deadlineRaw, input.provenance.fetchedAt)
    : { raw: null, parsed: null };

  const description = extractDescription($);
  const applicationMethod = extractApplicationMethod($);
  const titleNormalized = normalizeTitle(titleRaw);
  const locations: string[] = [];
  const salaryRaw: string | null = null;
  const sourceCategories: string[] = [];

  const rawResourceHash = createHash('sha256').update(input.html).digest('hex');
  const meaningfulContentHash = createHash('sha256')
    .update(
      JSON.stringify({
        titleNormalized,
        organizationRaw,
        description,
        locations,
        salaryRaw,
        publishedRaw: publishedDate.raw,
        deadlineRaw: deadlineDate.raw,
        applicationMethod,
        sourceCategories,
      }),
    )
    .digest('hex');

  return {
    parserVersion: JOBS_GE_DETAIL_PARSER_VERSION,
    extractionMethod: input.extractionMethod,
    rawResourceHash,
    meaningfulContentHash,
    titleRaw,
    titleNormalized,
    organizationRaw,
    description,
    locations,
    salaryRaw,
    publishedDate,
    deadlineDate,
    applicationMethod,
    sourceCategories,
    structuredAttributes: {},
    provenance: input.provenance,
  };
}
