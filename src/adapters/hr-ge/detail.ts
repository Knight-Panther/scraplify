import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { SourceListingRevisionContent } from '../../db/write-source-listing-revision.js';
import { extractNgState, findNgStateEntry } from './ng-state.js';

export const HR_GE_DETAIL_PARSER_VERSION = 'v1';

export interface ParseHrGeDetailPageInput {
  html: string;
  announcementId: string;
  extractionMethod: SourceListingRevisionContent['extractionMethod'];
  provenance: SourceListingRevisionContent['provenance'];
}

export class HrGeDetailParseError extends Error {
  constructor(reason: string) {
    super(`hr.ge detail page does not match the expected structure: ${reason}`);
    this.name = 'HrGeDetailParseError';
  }
}

const ANNOUNCEMENT_ENTRY_URL_RE = /\/api\/v3\/announcement\/[0-9]+$/;

const HAS_TIMEZONE_SUFFIX_RE = /(Z|[+-][0-9]{2}:?[0-9]{2})$/;

/**
 * hr.ge's ISO timestamps (`publishDate`, `deadlineDate`) carry no offset
 * suffix and are local Asia/Tbilisi time (RECON_NOTES.md: the app config
 * declares `timeZone: "GMT+4"`) — unlike jobs.ge's yearless dates, there is
 * no year-ambiguity problem here, but there IS a timezone one: passing the
 * naive string straight through as a "parsed" instant would be silently
 * wrong by 4 hours, corrupting deadline-based expiry
 * (src/db/reconcile-source-listings.ts's expireOverdueListings compares
 * sourceDeadlineAt against a real UTC "now"). Georgia has used a fixed
 * UTC+4 offset with no DST since 2005, so appending '+04:00' and letting
 * the platform's own Date parsing compute the real instant is safe and
 * exact, not a heuristic the way jobs-ge's year-inference is. Defensive
 * against hr.ge ever adding its own offset suffix: only appended when one
 * isn't already present.
 */
function parseHrGeTimestamp(raw: string | null): string | null {
  if (raw === null) return null;
  const withOffset = HAS_TIMEZONE_SUFFIX_RE.test(raw) ? raw : `${raw}+04:00`;
  const parsed = new Date(withOffset);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Flattens hr.ge's nested specialty/industry taxonomy (each entry has a
 * `name` plus an optional `children[]` of the same shape) into a flat list
 * of names, parent and child both. A deliberate simplification, not a loss
 * of the real structure: this project's own Phase 2 taxonomy-mapping work
 * maps SOURCE categories to a canonical taxonomy from scratch regardless,
 * so a flat list of hr.ge's own labels is exactly what
 * structuredAttributes' role as a documented escape hatch calls for here —
 * preserving the parent/child tree is not needed until something actually
 * consumes it.
 */
function flattenNamedTree(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const node of value) {
    const record = asRecord(node);
    if (record === null) continue;
    if (typeof record.name === 'string') names.push(record.name);
    names.push(...flattenNamedTree(record.children));
  }
  return names;
}

/** Converts hr.ge's entity-encoded HTML description into normalized plain text, the same treatment jobs-ge's own detail.ts applies. */
function extractDescriptionText(descriptionHtml: string): string {
  const $ = cheerio.load(`<div>${descriptionHtml}</div>`);
  const root = $('div').first();
  root.find('br').replaceWith('\n');
  root.find('li').each((_index, el) => {
    $(el).prepend('- ').append('\n');
  });
  const raw = root.text();
  return raw
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractApplicationMethod(
  method: unknown,
  details: unknown,
): SourceListingRevisionContent['applicationMethod'] {
  const detailsRecord = asRecord(details);

  // Confirmed as a clean 3-value enum against all 5 real fixtures
  // (RECON_NOTES.md): 1 = email, 2 = apply on hr.ge itself ("send CV" —
  // applicationDetails is entirely null; the method IS the absence), 3 =
  // external URL. Anything else is an honest unspecified, per §6.2, not a
  // guess.
  if (method === 1) {
    const email = detailsRecord?.email;
    return { type: 'email', value: typeof email === 'string' && email.length > 0 ? email : null };
  }
  if (method === 2) {
    return { type: 'form', value: null };
  }
  if (method === 3) {
    const url = detailsRecord?.applicationUrl;
    return { type: 'url', value: typeof url === 'string' && url.length > 0 ? url : null };
  }
  return { type: 'unspecified', value: null };
}

/**
 * Parses one hr.ge detail page (`/announcement/<id>/<slug>`) into everything
 * writeSourceListingRevision needs beyond identity — mirroring jobs-ge's
 * own parseJobsGeDetailPage contract (same return type, imported directly
 * so the two can't silently drift).
 *
 * Parses the ng-state `announcement/<id>` JSON entry as the primary source,
 * per RECON_NOTES.md's explicit recommendation: it yields typed values
 * (real ISO timestamps, numeric salaries, enum codes) where the DOM would
 * yield Georgian label text requiring a reverse mapping, and every
 * concept-listed rich field (specialty, industry, seniority, employment
 * form, schedule, work mode, experience, education, languages, location,
 * salary, application method) is present there as structured JSON.
 *
 * Structural throws (quarantine-worthy) follow jobs-ge's own precedent —
 * about a structure being ABSENT, never about a field's value being empty
 * (§6.2 explicitly permits an honest unknown): the ng-state island itself,
 * the matching announcement entry, `data.announcement`, a non-empty
 * `title`, and the announcementId actually matching what was requested
 * (catches the island answering a stale/wrong entry). Every other field —
 * `salaryFrom: null`, `education` empty, `benefits: []` — is a legitimate
 * unknown and must not throw; RECON_NOTES.md confirmed all 5 real samples
 * carry `education`/`experience`/`categories`/`targetAudience`/`duration`
 * as bare `null` at the top level while the real values live nested under
 * `announcementRequirements`/`employerRequirements`, so requiring any of
 * the top-level ones would incorrectly quarantine the entire corpus.
 */
export function parseHrGeDetailPage(input: ParseHrGeDetailPageInput): SourceListingRevisionContent {
  const $ = cheerio.load(input.html);
  const state = extractNgState($);
  const entry = findNgStateEntry(state, ANNOUNCEMENT_ENTRY_URL_RE);
  if (entry === null) {
    throw new HrGeDetailParseError('no announcement/<id> entry found in the ng-state island');
  }

  const body = asRecord(entry.b);
  const announcement = asRecord(body?.data)?.announcement;
  const a = asRecord(announcement);
  if (a === null) {
    throw new HrGeDetailParseError('announcement entry has no data.announcement object');
  }

  const titleRaw = typeof a.title === 'string' ? a.title.trim() : '';
  if (!titleRaw) {
    throw new HrGeDetailParseError('missing or empty title');
  }
  if (String(a.announcementId) !== input.announcementId) {
    throw new HrGeDetailParseError(
      `announcementId mismatch: requested ${input.announcementId}, island answered ${String(a.announcementId)}`,
    );
  }

  const isAnonymous = a.isAnonymous === true;
  const organizationRaw =
    !isAnonymous && typeof a.customerName === 'string' && a.customerName.length > 0
      ? a.customerName
      : null;

  const description =
    typeof a.description === 'string' ? extractDescriptionText(a.description) : '';

  const locations = asStringArray(a.addresses);

  // showSalary gates display on hr.ge's own rendered page (RECON_NOTES.md,
  // confirmed by direct correlation across samples: populated+shown vs.
  // null+hidden) — honored here so a suppressed salary is never persisted.
  // Deliberately NOT extending this same "honor the show* flag" treatment
  // to showEducation/showWorkExperience/showDrivingLicenses/
  // showTargetAudience/showDuration below: checked directly against all 5
  // real fixtures, showWorkExperience is `false` on every one of them
  // (including the sample RECON_NOTES itself calls out as
  // "experience-required," workExperienceType: 1, workExperienceFrom: 3),
  // which is direct evidence these flags do not gate public visibility of
  // the underlying requirement the way showSalary demonstrably does — they
  // more plausibly configure something else, such as which fields an
  // applicant's own CV form must display when applying. Gating on an
  // unverified assumption would suppress genuinely public, meaningful
  // requirement data, the wrong side of §6.2's "explicit unknown over
  // unsupported conclusion" to err on. Revisit only with real evidence a
  // `true`/`false` split for one of these actually correlates with field
  // presence the way showSalary's does.
  const showSalary = a.showSalary === true;
  const salaryFrom = typeof a.salaryFrom === 'number' ? a.salaryFrom : null;
  const salaryTo = typeof a.salaryTo === 'number' ? a.salaryTo : null;
  const salaryRaw =
    showSalary && (salaryFrom !== null || salaryTo !== null)
      ? `${salaryFrom ?? '?'}-${salaryTo ?? '?'}`
      : null;

  const publishedRaw = typeof a.publishDate === 'string' ? a.publishDate : null;
  const deadlineRaw = typeof a.deadlineDate === 'string' ? a.deadlineDate : null;

  const applicationMethod = extractApplicationMethod(a.applicationMethod, a.applicationDetails);

  const announcementRequirements = asRecord(a.announcementRequirements);
  const employerRequirements = asRecord(a.employerRequirements);

  // hideContactPerson: RECON_NOTES.md's directly-verified privacy finding
  // — when true, hr.ge's own rendered page omits the recruiter's name and
  // personal email/mobile even though the ng-state island still carries
  // them. Never persist what the source itself withholds from its users.
  const hideContactPerson = a.hideContactPerson === true;

  const structuredAttributes: Record<string, unknown> = {
    specialty: flattenNamedTree(announcementRequirements?.specializationList),
    industry: flattenNamedTree(announcementRequirements?.industryList),
    seniorityLevels: asStringArray(announcementRequirements?.seniorityLevels),
    employmentTypeName:
      typeof announcementRequirements?.employmentTypeName === 'string'
        ? announcementRequirements.employmentTypeName
        : null,
    workScheduleName:
      typeof announcementRequirements?.workScheduleName === 'string'
        ? announcementRequirements.workScheduleName
        : null,
    employmentFormTypeName:
      typeof a.employmentFormTypeName === 'string' ? a.employmentFormTypeName : null,
    isWorkFromHome: a.isWorkFromHome === true,
    workExperienceType: typeof a.workExperienceType === 'number' ? a.workExperienceType : null,
    workExperienceFrom: typeof a.workExperienceFrom === 'number' ? a.workExperienceFrom : null,
    workExperienceTo: typeof a.workExperienceTo === 'number' ? a.workExperienceTo : null,
    educationLevels: asStringArray(employerRequirements?.educationLevels),
    educationPrograms: asStringArray(employerRequirements?.educationPrograms),
    languages: asStringArray(a.languages),
    drivingLicenses: asStringArray(a.drivingLicenses),
    benefits: asStringArray(a.benefits),
    isSuitableForStudent: a.isSuitableForStudent === true,
    isAnonymous,
    listingSection: typeof a.listingSection === 'number' ? a.listingSection : null,
    isPriority: a.isPriority === true,
    hasAttachment: a.hasAttachment === true,
    attachmentUrl: typeof a.attachmentUrl === 'string' ? a.attachmentUrl : null,
    isWithBonus: a.isWithBonus === true,
    bonusFrom: typeof a.bonusFrom === 'number' ? a.bonusFrom : null,
    bonusTo: typeof a.bonusTo === 'number' ? a.bonusTo : null,
    // renewalDate: the display string's start date reflects this, not
    // publishDate, when a listing has been renewed (RECON_NOTES.md) — kept
    // here as a structured fact even though it isn't one of the two
    // dedicated date columns.
    renewalDate: typeof a.renewalDate === 'string' ? a.renewalDate : null,
    hideContactPerson,
  };

  const titleNormalized = titleRaw.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

  const rawResourceHash = createHash('sha256').update(input.html).digest('hex');
  const meaningfulContentHash = createHash('sha256')
    .update(
      JSON.stringify({
        titleNormalized,
        organizationRaw,
        description,
        locations,
        salaryRaw,
        publishedRaw,
        deadlineRaw,
        applicationMethod,
        structuredAttributes,
      }),
    )
    .digest('hex');

  return {
    parserVersion: HR_GE_DETAIL_PARSER_VERSION,
    extractionMethod: input.extractionMethod,
    rawResourceHash,
    meaningfulContentHash,
    titleRaw,
    titleNormalized,
    organizationRaw,
    description,
    locations,
    salaryRaw,
    // hr.ge supplies real ISO timestamps alongside a yearless Georgian
    // display string (RECON_NOTES.md) — unlike jobs.ge, there is no
    // year-inference problem here, and src/adapters/jobs-ge/dates.ts's
    // parseYearlessGeorgianDate must NOT be reused: the source already
    // states the year, so inferring one would be strictly worse. `raw` is
    // the untouched source string; `parsed` is the real UTC instant (see
    // parseHrGeTimestamp) — the two intentionally differ here, unlike
    // jobs-ge where raw is Georgian text and parsed is its resolved year.
    publishedDate: { raw: publishedRaw, parsed: parseHrGeTimestamp(publishedRaw) },
    deadlineDate: { raw: deadlineRaw, parsed: parseHrGeTimestamp(deadlineRaw) },
    applicationMethod,
    sourceCategories: [],
    structuredAttributes,
    provenance: input.provenance,
  };
}
