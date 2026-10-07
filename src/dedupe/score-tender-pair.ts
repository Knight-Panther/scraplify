import { normalizeTitle, trigramSimilarity, trigrams } from '../normalize/text.js';
import type { ListingForScoring, PairScore } from './score-pair.js';
import { buyersMatch } from './tender-buyer.js';

/**
 * Scoring for a pair of TENDERS from different sources: an etenders.ge
 * procurement and a buyer's own post about it on jobs.ge or hr.ge, or the
 * same post on both boards (docs/addEtender.md §11, §14.6).
 *
 * The vacancy scorer cannot do this job. Its only automatic merge needs a
 * per-vacancy application link both sides share, and a tender has none: the
 * etenders.ge copy links to etenders.ge, the board copy to an inbox. What a
 * tender does have is a buyer-set bid deadline, which both copies repeat, and
 * which separates one buyer's procurements far better than a vacancy's
 * closing date separates its jobs. So the evidence here is the buyer, the
 * deadline's calendar day, the publication date and the subject of the title,
 * and §14.2's rule still holds: no single one of them merges anything.
 *
 * Measured on the study's golden pairs (2026-10-07): 7 of 9 have deadlines on
 * the same Tbilisi day, the other two are 3 and 7 days apart because the
 * board post's own expiry was used. Same-day deadline AND agreeing subject
 * merges; a near miss goes to a human. The hard negatives are one buyer's
 * different procurements sharing a deadline (Aversi Clinic's carts and its
 * gynecological chairs, both due 2026-10-15; UNICEF's printing and stationery
 * agreements, both due 2026-09-30): the subject separates the first, and the
 * second, being in two languages, never merges automatically.
 */

/** Bump when a rule or threshold below changes; recorded on every decision. */
export const TENDER_DEDUPE_RULESET_VERSION = 'tender-v1';

/** Subject agreement at or above this, with a same-day deadline, merges. */
const SUBJECT_STRONG_AGREEMENT = 0.5;
/** Below this the subjects describe different purchases. */
const SUBJECT_WEAK_AGREEMENT = 0.3;
/** Publication dates further apart than this are a different procedure. */
const PUBLISHED_WINDOW_DAYS = 7;
/** A deadline this close, though not the same day, is worth a human's look. */
const DEADLINE_REVIEW_DAYS = 3;

/** Georgia is UTC+4 all year; deadlines are compared as Tbilisi calendar days. */
const TBILISI_OFFSET_MS = 4 * 3_600_000;
const MS_PER_DAY = 86_400_000;

export interface TenderSignalBreakdown {
  sameBuyer: boolean;
  /** Trigram Jaccard similarity of the two subjects. */
  titleSimilarity: number;
  /** Shared subject trigrams over the smaller subject's: one subject inside the other scores high. */
  titleContainment: number;
  /** One subject is written in Georgian and the other in Latin script. */
  crossLanguageTitles: boolean;
  /** Whole Tbilisi calendar days between the deadlines; null when either is missing. */
  deadlineDayGap: number | null;
  publishedDayGap: number | null;
  /** Reference codes both titles carry (`DR0018/09/26`, `№597`): equal, different, or not on both. */
  referenceCodes: 'same' | 'different' | null;
}

/**
 * Words every tender title carries, stripped so the subject (what is being
 * bought) is what gets compared. "აცხადებს ტენდერს" ("announces a tender")
 * and everything before it is dropped first: etenders.ge titles often open
 * with the buyer's full legal name.
 */
const BOILERPLATE_WORDS = new Set([
  'ტენდერი',
  'ტენ',
  'tender',
  'rfq',
  'rfp',
  'itb',
  'eoi',
  'თაობაზე',
  'შესახებ',
  'დაკავშირებით',
  'შესყიდვა',
  'შესყიდვის',
  'შესყიდვაზე',
  'შესყიდვასთან',
  'შეძენა',
  'შეძენის',
  'შეძენაზე',
  'procurement',
  'for',
  'the',
  'of',
]);

const ANNOUNCES_TENDER = /^.*?აცხადებს ტენდერს\s*/u;
const REFERENCE_CODE =
  /№\s*[\p{L}\p{N}/-]+|(?<![\p{L}\p{N}])[A-Za-z]{1,5}\d{3,}(?:[/-]\d+)*|(?<![\p{L}\p{N}/])\d{5,}(?![\p{L}\p{N}])/gu;

export function tenderSubject(title: string): string | null {
  const normalized = normalizeTitle(title.normalize('NFKC').replace(ANNOUNCES_TENDER, ''));
  if (normalized === null) return null;
  const words = normalized.split(' ').filter((word) => !BOILERPLATE_WORDS.has(word));
  return words.length === 0 ? null : words.join(' ');
}

function referenceCodes(title: string): Set<string> {
  return new Set(
    [...title.normalize('NFKC').matchAll(REFERENCE_CODE)].map((match) =>
      match[0].replace(/\s+/g, '').toLowerCase(),
    ),
  );
}

function containment(a: string, b: string): number {
  const gramsA = trigrams(a);
  const gramsB = trigrams(b);
  const smaller = Math.min(gramsA.size, gramsB.size);
  if (smaller === 0) return 0;
  let shared = 0;
  for (const gram of gramsA) if (gramsB.has(gram)) shared++;
  return shared / smaller;
}

function dominantScript(text: string): 'georgian' | 'latin' | null {
  const georgian = text.match(/[Ⴀ-ჿᲐ-Ჿ]/gu)?.length ?? 0;
  const latin = text.match(/[a-z]/gi)?.length ?? 0;
  if (georgian === 0 && latin === 0) return null;
  return georgian >= latin ? 'georgian' : 'latin';
}

function tbilisiDay(instant: string | null): number | null {
  if (instant === null) return null;
  const parsed = Date.parse(instant);
  if (Number.isNaN(parsed)) return null;
  return Math.floor((parsed + TBILISI_OFFSET_MS) / MS_PER_DAY);
}

function dayGap(a: string | null, b: string | null): number | null {
  const dayA = tbilisiDay(a);
  const dayB = tbilisiDay(b);
  return dayA === null || dayB === null ? null : Math.abs(dayA - dayB);
}

function decision(
  result: Pick<PairScore<TenderSignalBreakdown>, 'decision' | 'confidence'>,
  signals: TenderSignalBreakdown,
  reasons: string[],
): PairScore<TenderSignalBreakdown> {
  return { ...result, signals, reasons, rulesetVersion: TENDER_DEDUPE_RULESET_VERSION };
}

export function scoreTenderPair(
  a: ListingForScoring,
  b: ListingForScoring,
): PairScore<TenderSignalBreakdown> {
  const subjectA = tenderSubject(a.titleRaw);
  const subjectB = tenderSubject(b.titleRaw);
  const codesA = referenceCodes(a.titleRaw);
  const codesB = referenceCodes(b.titleRaw);
  const scriptA = subjectA === null ? null : dominantScript(subjectA);
  const scriptB = subjectB === null ? null : dominantScript(subjectB);

  const signals: TenderSignalBreakdown = {
    sameBuyer: buyersMatch(a.organizationRaw, b.organizationRaw),
    titleSimilarity:
      subjectA === null || subjectB === null ? 0 : trigramSimilarity(subjectA, subjectB),
    titleContainment: subjectA === null || subjectB === null ? 0 : containment(subjectA, subjectB),
    crossLanguageTitles: scriptA !== null && scriptB !== null && scriptA !== scriptB,
    deadlineDayGap: dayGap(a.deadlineAt, b.deadlineAt),
    publishedDayGap: dayGap(a.publishedAt, b.publishedAt),
    referenceCodes:
      codesA.size === 0 || codesB.size === 0
        ? null
        : [...codesA].some((code) => codesB.has(code))
          ? 'same'
          : 'different',
  };
  // Containment rewards one subject sitting inside the other ("მობილური
  // კომპიუტერული ურიკების" inside "საოპერაციო ბლოკის მობილური კომპიუტერული
  // ურიკები"), but a one-word subject such as "მომსახურება" (services) sits
  // inside half of a buyer's tenders, so it only counts from two words up.
  const shorterSubjectWords = Math.min(
    subjectA?.split(' ').length ?? 0,
    subjectB?.split(' ').length ?? 0,
  );
  const subjectAgreement =
    shorterSubjectWords >= 2
      ? Math.max(signals.titleSimilarity, signals.titleContainment)
      : signals.titleSimilarity;
  const deadlineGap = signals.deadlineDayGap;
  const publishedGap = signals.publishedDayGap;

  if (a.sourceId === b.sourceId) {
    // A re-announced tender is a new procedure with a new id on its own site;
    // two posts on one board are two posts, as for vacancies (§12.1).
    return decision({ decision: 'distinct', confidence: 0 }, signals, [
      'same source — within-source identity is settled by source record id (§12.1)',
    ]);
  }
  if (!signals.sameBuyer) {
    return decision({ decision: 'distinct', confidence: 0 }, signals, [
      'different buyers — tenders are only compared within one buyer',
    ]);
  }
  if (signals.referenceCodes === 'different') {
    return decision({ decision: 'distinct', confidence: 0 }, signals, [
      'both titles carry a reference code and the codes differ',
    ]);
  }

  const reasons = ['same buyer'];
  const publishedClose = publishedGap !== null && publishedGap <= PUBLISHED_WINDOW_DAYS;

  if (
    deadlineGap === 0 &&
    publishedClose &&
    (signals.referenceCodes === 'same' ||
      (!signals.crossLanguageTitles && subjectAgreement >= SUBJECT_STRONG_AGREEMENT))
  ) {
    reasons.push(
      'deadlines fall on the same Tbilisi day',
      `published ${publishedGap} day(s) apart`,
      signals.referenceCodes === 'same'
        ? 'both titles carry the same reference code'
        : `subjects agree (${subjectAgreement.toFixed(2)})`,
    );
    return decision({ decision: 'confirmed_same', confidence: 0.95 }, signals, reasons);
  }

  const datesNear =
    (deadlineGap !== null && deadlineGap <= DEADLINE_REVIEW_DAYS) ||
    (publishedGap !== null && publishedGap <= DEADLINE_REVIEW_DAYS);
  const subjectsPlausible =
    subjectAgreement >= SUBJECT_WEAK_AGREEMENT ||
    signals.crossLanguageTitles ||
    signals.referenceCodes === 'same';
  if (datesNear && subjectsPlausible) {
    reasons.push(
      deadlineGap === null
        ? 'a deadline is missing'
        : `deadlines ${deadlineGap} day(s) apart, published ${publishedGap ?? '?'} day(s) apart`,
      signals.crossLanguageTitles
        ? 'titles are in different languages, so the subjects cannot be compared'
        : `subjects partly agree (${subjectAgreement.toFixed(2)})`,
      'not enough for an automatic merge',
    );
    return decision(
      { decision: 'needs_review', confidence: deadlineGap === 0 ? 0.65 : 0.55 },
      signals,
      reasons,
    );
  }

  reasons.push(
    `insufficient evidence (deadline gap ${deadlineGap ?? 'unknown'} days, subject agreement ${subjectAgreement.toFixed(2)})`,
  );
  return decision({ decision: 'distinct', confidence: 0 }, signals, reasons);
}
