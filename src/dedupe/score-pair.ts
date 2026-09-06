import { normalizeOrganizationName } from '../normalize/organization.js';
import { normalizeApplicationValue, normalizeTitle, trigramSimilarity } from '../normalize/text.js';

/**
 * Weighted evidence scoring for one candidate pair (§14.1 stage 4) and the
 * decision that follows (stage 5).
 *
 * The governing rule is §14.2's: **false merges are more damaging than missed
 * merges.** A missed duplicate shows the user the same job twice, which is
 * mildly annoying and self-correcting once found. A false merge silently
 * destroys a real vacancy from the user's view, attributes one employer's
 * listing to another, and is invisible precisely because the merged record
 * looks clean. So every threshold here is set to be wrong in the direction of
 * "leave them separate" and every auto-link path requires an independent
 * per-vacancy signal, never an accumulation of weak agreement.
 */

/** Bump when weights or thresholds change; recorded on every decision. */
export const DEDUPE_RULESET_VERSION = 'v1';

export type DedupeDecision = 'confirmed_same' | 'probable_same' | 'needs_review' | 'distinct';

export interface ListingForScoring {
  sourceId: string;
  sourceListingId: string;
  titleRaw: string;
  organizationRaw: string | null;
  applicationType: string | null;
  applicationValue: string | null;
  /** Absolute instants, already timezone-resolved at extraction time. */
  publishedAt: string | null;
  deadlineAt: string | null;
}

export interface ScoringContext {
  /**
   * How many DISTINCT source listings carry each normalized application
   * value, across the whole corpus. This is what separates a per-vacancy ATS
   * link from a shared company inbox, and it is measured rather than assumed:
   * in the live corpus, application URLs are never shared by more than 2
   * listings while one email is shared by 8. Without it, "same contact" would
   * merge every vacancy an employer posts from one address.
   */
  applicationValueListingCounts: ReadonlyMap<string, number>;
}

/**
 * Above this many distinct listings, a shared application value is treated as
 * an employer-level address (a careers inbox) rather than a vacancy
 * identifier. 2 is the value that matters: a genuine cross-posting appears on
 * exactly one listing per source, and the measured URL maximum in the live
 * corpus is exactly 2.
 */
const MAX_LISTINGS_FOR_VACANCY_LEVEL_VALUE = 2;

/**
 * Titles at or above this are "the same job, written slightly differently".
 *
 * Measured caution, not a guess: in the live corpus
 * `...უფროსი ანალიტიკოსი` (senior analyst) and `...უმცროსი ანალიტიკოსი`
 * (junior analyst) — two genuinely different vacancies at one employer —
 * score **0.86**, comfortably above this threshold. Georgian compound titles
 * are long and differ by a single morpheme between seniority levels, so
 * title similarity is structurally unable to separate them. That is why this
 * threshold never authorizes a merge on its own: it only ever acts as a
 * corroborating check alongside a per-vacancy application value, and those
 * two analyst postings are correctly held apart by their distinct ATS links.
 */
const TITLE_STRONG_SIMILARITY = 0.82;
/** Below this, the titles are describing different work. */
const TITLE_WEAK_SIMILARITY = 0.45;

/** Publication/deadline proximity window (§14.1 stage 3's "bounded window"). */
const DATE_PROXIMITY_DAYS = 21;
const MS_PER_DAY = 86_400_000;

export interface SignalBreakdown {
  /** Both sides normalize to the same organization key. */
  sameOrganization: boolean | null;
  titleSimilarity: number;
  /** Shared application value that is selective enough to identify a vacancy. */
  sharedVacancyLevelApplicationValue: boolean;
  /** Shared application value that is NOT selective (employer inbox). */
  sharedEmployerLevelApplicationValue: boolean;
  /** Null when either side lacks the date entirely. */
  publishedWithinWindow: boolean | null;
  deadlineWithinWindow: boolean | null;
}

export interface PairScore {
  decision: DedupeDecision;
  /** 0-1. Deliberately NOT a probability — a monotone ordering for review queues. */
  confidence: number;
  signals: SignalBreakdown;
  /** Human-readable justification; stored as evidence so a decision is explainable (§14.2). */
  reasons: string[];
  rulesetVersion: string;
}

function withinDays(a: string | null, b: string | null, days: number): boolean | null {
  if (a === null || b === null) return null;
  const parsedA = Date.parse(a);
  const parsedB = Date.parse(b);
  if (Number.isNaN(parsedA) || Number.isNaN(parsedB)) return null;
  return Math.abs(parsedA - parsedB) <= days * MS_PER_DAY;
}

export function scorePair(
  a: ListingForScoring,
  b: ListingForScoring,
  context: ScoringContext,
): PairScore {
  const reasons: string[] = [];

  const orgA = normalizeOrganizationName(a.organizationRaw);
  const orgB = normalizeOrganizationName(b.organizationRaw);
  const sameOrganization = orgA === null || orgB === null ? null : orgA === orgB;

  const titleA = normalizeTitle(a.titleRaw);
  const titleB = normalizeTitle(b.titleRaw);
  const titleSimilarity =
    titleA === null || titleB === null ? 0 : trigramSimilarity(titleA, titleB);

  const valueA = normalizeApplicationValue(a.applicationType, a.applicationValue);
  const valueB = normalizeApplicationValue(b.applicationType, b.applicationValue);
  const sharedValue = valueA !== null && valueB !== null && valueA === valueB ? valueA : null;
  const sharedValueListingCount =
    sharedValue === null
      ? 0
      : (context.applicationValueListingCounts.get(sharedValue) ?? Number.POSITIVE_INFINITY);
  const sharedVacancyLevelApplicationValue =
    sharedValue !== null && sharedValueListingCount <= MAX_LISTINGS_FOR_VACANCY_LEVEL_VALUE;
  const sharedEmployerLevelApplicationValue =
    sharedValue !== null && !sharedVacancyLevelApplicationValue;

  const publishedWithinWindow = withinDays(a.publishedAt, b.publishedAt, DATE_PROXIMITY_DAYS);
  const deadlineWithinWindow = withinDays(a.deadlineAt, b.deadlineAt, DATE_PROXIMITY_DAYS);

  const signals: SignalBreakdown = {
    sameOrganization,
    titleSimilarity,
    sharedVacancyLevelApplicationValue,
    sharedEmployerLevelApplicationValue,
    publishedWithinWindow,
    deadlineWithinWindow,
  };

  // Same source is never a cross-source duplicate: §12.1 already resolves
  // identity within a source by stable record id, so two rows from one board
  // are two genuinely different postings, however alike they read.
  if (a.sourceId === b.sourceId) {
    return {
      decision: 'distinct',
      confidence: 0,
      signals,
      reasons: ['same source — within-source identity is settled by source record id (§12.1)'],
      rulesetVersion: DEDUPE_RULESET_VERSION,
    };
  }

  // A title that disagrees outright vetoes every other signal. Two vacancies
  // at one employer sharing a careers inbox and a posting week is the single
  // most common false-merge shape in this corpus, and no amount of contextual
  // agreement should overcome "these describe different work".
  if (titleSimilarity < TITLE_WEAK_SIMILARITY) {
    reasons.push(
      `titles disagree (similarity ${titleSimilarity.toFixed(2)} < ${TITLE_WEAK_SIMILARITY})`,
    );
    if (sharedVacancyLevelApplicationValue) {
      // A per-vacancy link pointing at two differently-titled postings is a
      // genuine contradiction between two strong signals — exactly what a
      // human should look at, not something to resolve automatically.
      reasons.push('but a vacancy-level application value is shared — contradictory, needs review');
      return {
        decision: 'needs_review',
        confidence: 0.5,
        signals,
        reasons,
        rulesetVersion: DEDUPE_RULESET_VERSION,
      };
    }
    return {
      decision: 'distinct',
      confidence: 0,
      signals,
      reasons,
      rulesetVersion: DEDUPE_RULESET_VERSION,
    };
  }

  // The only auto-link path (§14.2: "auto-link only high-confidence
  // candidates with MULTIPLE INDEPENDENT signals"). The two signals here are
  // genuinely independent: an employer-controlled per-vacancy application
  // link, and the title text. Neither is derived from the other.
  if (sharedVacancyLevelApplicationValue && titleSimilarity >= TITLE_STRONG_SIMILARITY) {
    reasons.push(
      `shared vacancy-level application value (carried by ${sharedValueListingCount} listings)`,
      `titles agree (similarity ${titleSimilarity.toFixed(2)})`,
    );
    if (sameOrganization === true) reasons.push('same normalized organization');
    return {
      decision: 'confirmed_same',
      confidence: 0.97,
      signals,
      reasons,
      rulesetVersion: DEDUPE_RULESET_VERSION,
    };
  }

  if (sharedVacancyLevelApplicationValue) {
    reasons.push(
      `shared vacancy-level application value, but titles only partially agree (${titleSimilarity.toFixed(2)})`,
    );
    return {
      decision: 'probable_same',
      confidence: 0.75,
      signals,
      reasons,
      rulesetVersion: DEDUPE_RULESET_VERSION,
    };
  }

  // Everything below has NO per-vacancy signal. §14.2: "never auto-link
  // solely because title, employer, and location match" — so no combination
  // of the remaining evidence may reach confirmed_same, no matter how much of
  // it agrees. The best available outcome is a review queue entry.
  if (sameOrganization === true && titleSimilarity >= TITLE_STRONG_SIMILARITY) {
    reasons.push(
      'same organization and closely matching titles, but no vacancy-level application value',
      '§14.2 forbids auto-linking on employer and title agreement alone',
    );
    if (sharedEmployerLevelApplicationValue) {
      reasons.push(
        `shared application value is employer-level (carried by ${sharedValueListingCount} listings) — not a vacancy identifier`,
      );
    }
    const datesAgree = publishedWithinWindow === true || deadlineWithinWindow === true;
    if (datesAgree) reasons.push('posting dates are within the proximity window');
    return {
      decision: 'needs_review',
      confidence: datesAgree ? 0.65 : 0.55,
      signals,
      reasons,
      rulesetVersion: DEDUPE_RULESET_VERSION,
    };
  }

  reasons.push(
    `insufficient evidence (title similarity ${titleSimilarity.toFixed(2)}, organization ${
      sameOrganization === null ? 'unknown' : sameOrganization ? 'same' : 'different'
    }, no vacancy-level application value)`,
  );
  return {
    decision: 'distinct',
    confidence: 0,
    signals,
    reasons,
    rulesetVersion: DEDUPE_RULESET_VERSION,
  };
}
