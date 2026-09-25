import { trigramSimilarity } from '../../normalize/text.js';
import type { BundleOpportunity } from '../bundle/schema.js';
import type { MatchProfile, ProfileTerm } from './profile.js';
import { findPhrase, LEXICAL_TEXT_VERSION, phraseStems } from './text.js';

/**
 * Browser-side lexical/taxonomy ranking over the `lexical-v1` bundle
 * (Phase 8D, change.md §7 "Ranking"). Deterministic and explainable: every
 * point of a score comes from a named match between a profile term and a
 * real field of the listing, and the explanation lists exactly those.
 *
 * NOT semantic matching. Phase 8A approved no embedding model, so there is
 * no vector similarity here and the UI must not call it semantic.
 *
 * What the bundle lets this check, and what it does not: a row carries a
 * title, hr.ge taxonomy labels and stated locations, but no description,
 * language or work mode. So roles meet titles, fields meet taxonomy codes,
 * and skills meet title and label words. Language and work mode are never
 * checked, because nothing in a row states them.
 */

export const LEXICAL_RANK_VERSION = `lexical-rank-v1+text-${LEXICAL_TEXT_VERSION}`;

/**
 * Component weights. Role against title is the strongest signal both boards
 * carry for every row. Fields are hr.ge's own categorization and exact when
 * present. Skills rarely appear in a title, so they corroborate rather than
 * decide.
 */
export const WEIGHTS = { role: 0.5, field: 0.3, skill: 0.2 } as const;

/**
 * A role this similar to a title counts as a match — the same threshold
 * `src/ranking/score-opportunity.ts` uses for the operator's own ranking.
 */
export const ROLE_SIMILARITY_THRESHOLD = 0.55;
/** Two matched skills saturate the skill component. */
const SKILLS_FOR_FULL_SCORE = 2;

export interface IndexedOpportunity {
  row: BundleOpportunity;
  titleStems: string[];
  titleKey: string;
  labelStems: string[][];
  locationStems: string[][];
  codes: ReadonlySet<string>;
  deadlineMs: number | null;
}

/** Per-row precomputation, done once per bundle rather than on every profile edit. */
export function indexOpportunities(rows: readonly BundleOpportunity[]): IndexedOpportunity[] {
  return rows.map((row) => {
    const titleStems = phraseStems(row.title);
    return {
      row,
      titleStems,
      titleKey: titleStems.join(' '),
      labelStems: row.taxonomy.map((term) => phraseStems(term.label)),
      locationStems: row.locations.map(phraseStems),
      codes: new Set(row.taxonomy.map((term) => term.code)),
      deadlineMs: row.deadlineAt === null ? null : Date.parse(row.deadlineAt),
    };
  });
}

export type MatchReason =
  | { kind: 'role'; term: string; exact: boolean }
  | { kind: 'field'; term: string; label: string }
  | { kind: 'skill'; term: string; where: 'title' | 'category' }
  | { kind: 'location'; term: string };

export interface RankedOpportunity {
  row: BundleOpportunity;
  /** In (0, 1]. Only rows with at least one match are returned. */
  score: number;
  reasons: MatchReason[];
  /**
   * True when the user set a location filter and this row states no
   * location at all. Silence is not a contradiction, so the row is kept;
   * the UI says so rather than implying the location was checked.
   */
  locationUnstated: boolean;
}

export interface RankingStats {
  considered: number;
  excludedDeadline: number;
  excludedLocation: number;
  matched: number;
}

export interface RankingResult {
  version: string;
  results: RankedOpportunity[];
  stats: RankingStats;
}

function active(profile: MatchProfile, kind: ProfileTerm['kind']): ProfileTerm[] {
  return profile.terms.filter((term) => term.kind === kind && term.active);
}

function anyForm(term: ProfileTerm, haystacks: readonly string[][]): boolean {
  return term.forms.some((form) => haystacks.some((stems) => findPhrase(stems, form) !== -1));
}

export function rankOpportunities(
  profile: MatchProfile,
  opportunities: readonly IndexedOpportunity[],
  options: { now: number },
): RankingResult {
  const roles = active(profile, 'role');
  const fields = active(profile, 'field');
  const skills = active(profile, 'skill');
  const locations = active(profile, 'location');
  const stats: RankingStats = {
    considered: opportunities.length,
    excludedDeadline: 0,
    excludedLocation: 0,
    matched: 0,
  };
  const results: RankedOpportunity[] = [];

  for (const opportunity of opportunities) {
    // --- Hard filters, only on data the row actually states ---------------
    // The bundle holds only publicly eligible rows, but it is up to 72h old:
    // a deadline can pass between build and now.
    if (opportunity.deadlineMs !== null && opportunity.deadlineMs < options.now) {
      stats.excludedDeadline++;
      continue;
    }
    const reasons: MatchReason[] = [];
    let locationUnstated = false;
    if (locations.length > 0) {
      if (opportunity.locationStems.length === 0) {
        locationUnstated = true;
      } else {
        const hit = locations.find((term) => anyForm(term, opportunity.locationStems));
        if (hit === undefined) {
          stats.excludedLocation++;
          continue;
        }
        reasons.push({ kind: 'location', term: hit.label });
      }
    }

    // --- Scored components, each counted only where it can apply ----------
    let weighted = 0;
    let applicable = 0;

    if (roles.length > 0) {
      applicable += WEIGHTS.role;
      let best = 0;
      let bestTerm: ProfileTerm | null = null;
      let exact = false;
      for (const term of roles) {
        for (const form of term.forms) {
          const contained = findPhrase(opportunity.titleStems, form) !== -1;
          // Trigram alone under-rates a short role inside a long title
          // (Jaccard penalises the length gap), so containment wins outright.
          const similarity = contained
            ? 1
            : trigramSimilarity(form.join(' '), opportunity.titleKey);
          if (similarity > best) {
            best = similarity;
            bestTerm = term;
            exact = contained;
          }
        }
      }
      if (bestTerm !== null && best >= ROLE_SIMILARITY_THRESHOLD) {
        weighted += WEIGHTS.role * best;
        reasons.push({ kind: 'role', term: bestTerm.label, exact });
      }
    }

    // A row with no taxonomy (every jobs.ge row) cannot confirm or deny a
    // field, so the component does not count for or against it.
    if (fields.length > 0 && opportunity.codes.size > 0) {
      applicable += WEIGHTS.field;
      const hit = fields.find((term) => term.codes.some((code) => opportunity.codes.has(code)));
      if (hit !== undefined) {
        weighted += WEIGHTS.field;
        const label =
          opportunity.row.taxonomy.find((t) => hit.codes.includes(t.code))?.label ?? hit.label;
        reasons.push({ kind: 'field', term: hit.label, label });
      }
    }

    if (skills.length > 0) {
      applicable += WEIGHTS.skill;
      let matched = 0;
      for (const term of skills) {
        if (anyForm(term, [opportunity.titleStems])) {
          matched++;
          reasons.push({ kind: 'skill', term: term.label, where: 'title' });
        } else if (anyForm(term, opportunity.labelStems)) {
          matched++;
          reasons.push({ kind: 'skill', term: term.label, where: 'category' });
        }
      }
      weighted += WEIGHTS.skill * Math.min(1, matched / SKILLS_FOR_FULL_SCORE);
    }

    if (applicable === 0 || weighted === 0) continue;
    stats.matched++;
    results.push({
      row: opportunity.row,
      score: weighted / applicable,
      reasons,
      locationUnstated,
    });
  }

  results.sort(
    (a, b) =>
      b.score - a.score ||
      // Among equals, the sooner deadline first: it is the one that expires.
      (a.row.deadlineAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.row.deadlineAt)) -
        (b.row.deadlineAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.row.deadlineAt)) ||
      a.row.title.localeCompare(b.row.title) ||
      a.row.opportunityId.localeCompare(b.row.opportunityId),
  );
  return { version: LEXICAL_RANK_VERSION, results, stats };
}
