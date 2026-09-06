import type { ComponentScore, HardFilterReason } from '../domain/candidate.js';
import { normalizeTitle, trigramSimilarity } from '../normalize/text.js';

/**
 * Deterministic, explainable ranking of one opportunity against one candidate
 * profile — the first two stages of §17.2's funnel:
 *
 *     hard eligibility and user constraints
 *       -> deterministic skill/title/experience scoring
 *       -> [embedding similarity]        (not implemented; §25 defers pgvector)
 *       -> [small-model assessment]      (not implemented)
 *       -> [premium reasoning]           (not implemented)
 *
 * Nothing here calls a model or an embedding service. That is deliberate and
 * matches §25's ordering: embeddings arrive "only after a retrieval evaluation
 * set exists", and there is no such set yet. A deterministic scorer is also
 * the only kind that can satisfy this phase's exit gate on its own terms —
 * reproducible and evidence-backed — because the same inputs always produce
 * the same score and every point of it is attributable to a named match.
 */

/** Bump whenever scoring logic changes; stored on every ranking so old ones stay identifiable. */
export const RANKING_EVALUATION_VERSION = 'deterministic-v1';

export interface ProfileClaimForScoring {
  kind: string;
  value: string;
  valueNormalized: string;
  years: number | null;
}

export interface OpportunityForScoring {
  opportunityId: string;
  title: string;
  /** Concatenated description text from every contributing source listing. */
  description: string;
  /** Absolute instant, or null when no source stated one. */
  deadlineAt: string | null;
  /** Locations any contributing source stated; empty when none did. */
  locations: readonly string[];
}

export interface ScoreOpportunityResult {
  eligible: boolean;
  /** Null when a hard filter rejected it — there is no meaningful score to give. */
  score: number | null;
  hardFilterReasons: HardFilterReason[];
  componentScores: ComponentScore[];
  evaluationVersion: string;
}

/**
 * Component weights. Skills and role dominate because they are the two signals
 * both boards actually carry for every listing; language and profession
 * preference are corroborating rather than decisive.
 */
const WEIGHTS = {
  skills: 0.45,
  role: 0.35,
  language: 0.05,
  professionPreference: 0.15,
} as const;

/** Work-mode vocabulary a listing might state. Matched as whole words. */
const WORK_MODE_TERMS = [
  'remote',
  'hybrid',
  'onsite',
  'on site',
  'დისტანციური',
  'ჰიბრიდული',
] as const;

/** A role title at or above this counts as matching the listing's title. */
const ROLE_TITLE_SIMILARITY = 0.55;

function claimsOfKind(
  claims: readonly ProfileClaimForScoring[],
  kind: string,
): ProfileClaimForScoring[] {
  return claims.filter((claim) => claim.kind === kind);
}

/**
 * Whether a normalized needle occurs as a whole word inside normalized text.
 *
 * Whole-word rather than substring, because a bare substring test makes short
 * skill tokens catastrophically noisy — "r" or "go" or "c" would match inside
 * ordinary words in every description and hand every listing a perfect skills
 * score. The haystack is pre-normalized to space-separated tokens by
 * normalizeTitle, so a padded-space search is an exact word-boundary test.
 */
function containsTerm(normalizedHaystack: string, normalizedNeedle: string): boolean {
  if (normalizedNeedle.length === 0) return false;
  return ` ${normalizedHaystack} `.includes(` ${normalizedNeedle} `);
}

export function scoreOpportunity(
  opportunity: OpportunityForScoring,
  claims: readonly ProfileClaimForScoring[],
  options: { now: string },
): ScoreOpportunityResult {
  const hardFilterReasons: HardFilterReason[] = [];
  /** Constraints the profile states that this scorer cannot yet check. */
  const unenforcedConstraints: HardFilterReason[] = [];

  const normalizedTitle = normalizeTitle(opportunity.title) ?? '';
  const normalizedDescription = normalizeTitle(opportunity.description) ?? '';
  const searchable = `${normalizedTitle} ${normalizedDescription}`.trim();

  // --- Stage 1: hard eligibility and user constraints ---------------------
  //
  // The governing rule, and the one most likely to be got wrong here: MISSING
  // DATA IS NEVER A CONSTRAINT VIOLATION. jobs.ge publishes no locations, no
  // salary and no categories at all (310 of the 410 listings in the corpus),
  // so any filter that rejected an opportunity for failing to state something
  // would silently discard three quarters of the corpus and look like a
  // working filter while doing it. Every check below therefore fires only on
  // data that is actually present.

  if (
    opportunity.deadlineAt !== null &&
    Date.parse(opportunity.deadlineAt) < Date.parse(options.now)
  ) {
    hardFilterReasons.push({
      filter: 'deadline_passed',
      detail: `deadline ${opportunity.deadlineAt} is before ${options.now}`,
    });
  }

  for (const excluded of claimsOfKind(claims, 'excluded_profession')) {
    if (containsTerm(searchable, excluded.valueNormalized)) {
      hardFilterReasons.push({
        filter: 'excluded_profession',
        detail: `listing mentions excluded profession "${excluded.value}"`,
      });
    }
  }

  // Location preference applies ONLY when the opportunity states a location.
  // A listing that says nothing about where the work is cannot contradict a
  // preference, and must not be filtered out for staying silent.
  const locationPreferences = claimsOfKind(claims, 'location_preference');
  if (locationPreferences.length > 0 && opportunity.locations.length > 0) {
    const normalizedLocations = opportunity.locations
      .map((location) => normalizeTitle(location) ?? '')
      .filter((location) => location.length > 0);
    const anyPreferred = locationPreferences.some((preference) =>
      normalizedLocations.some(
        (location) =>
          containsTerm(location, preference.valueNormalized) ||
          containsTerm(preference.valueNormalized, location),
      ),
    );
    if (!anyPreferred) {
      hardFilterReasons.push({
        filter: 'location_preference',
        detail: `listing locations [${opportunity.locations.join(', ')}] match no stated preference`,
      });
    }
  }

  // Work-mode preference, like location, applies only where the listing
  // actually says something. "remote"/"hybrid"/"on-site" appear in the
  // description when they apply at all; silence is not a contradiction.
  const workModePreferences = claimsOfKind(claims, 'work_mode_preference');
  if (workModePreferences.length > 0) {
    const statedModes = WORK_MODE_TERMS.filter((mode) => containsTerm(searchable, mode));
    if (statedModes.length > 0) {
      const anyPreferred = workModePreferences.some((preference) =>
        statedModes.some((mode) => containsTerm(preference.valueNormalized, mode)),
      );
      if (!anyPreferred) {
        hardFilterReasons.push({
          filter: 'work_mode_preference',
          detail: `listing states work mode [${statedModes.join(', ')}], which matches no stated preference`,
        });
      }
    }
  }

  // Salary and schedule constraints are ACCEPTED by the profile schema but
  // cannot be enforced yet, and saying so explicitly beats silently ignoring
  // them: a user who states "minimum 3000 GEL" would otherwise be shown
  // opportunities violating it, marked eligible, with nothing indicating the
  // constraint was never applied (adversarial review, 2026-09-06).
  //
  // They are not enforced because the data to enforce them against does not
  // exist in a comparable form: `salaryRaw` is free text present on only 36 of
  // 410 listings, and no schedule field is extracted at all. Parsing free-text
  // Georgian salary ranges into comparable numbers is real work that belongs
  // with the structured-attribute extraction it depends on, not guessed at
  // here — and a filter that silently mis-parsed salary would exclude real
  // opportunities, which is worse than not filtering.
  for (const kind of ['salary_constraint', 'schedule_constraint'] as const) {
    for (const constraint of claimsOfKind(claims, kind)) {
      unenforcedConstraints.push({
        filter: `${kind}_not_enforced`,
        detail: `"${constraint.value}" was NOT applied — this source data is not extracted in a comparable form yet`,
      });
    }
  }

  if (hardFilterReasons.length > 0) {
    return {
      eligible: false,
      score: null,
      // Unenforced constraints are reported alongside the filters that did
      // fire, so the explanation never overstates what was checked.
      hardFilterReasons: [...hardFilterReasons, ...unenforcedConstraints],
      componentScores: [],
      evaluationVersion: RANKING_EVALUATION_VERSION,
    };
  }

  // --- Stage 2: deterministic skill / title / experience scoring -----------

  const componentScores: ComponentScore[] = [];

  const skills = claimsOfKind(claims, 'skill');
  const matchedSkills = skills.filter((skill) => containsTerm(searchable, skill.valueNormalized));
  componentScores.push({
    component: 'skills',
    // A profile with no skill claims scores 0 here rather than 1: an absent
    // claim is not evidence of a match, and defaulting to a full score would
    // let an empty profile outrank a real one.
    score: skills.length === 0 ? 0 : matchedSkills.length / skills.length,
    weight: WEIGHTS.skills,
    matched: matchedSkills.map((skill) => skill.value),
    missing: skills.filter((skill) => !matchedSkills.includes(skill)).map((skill) => skill.value),
  });

  const roles = claimsOfKind(claims, 'role');
  let bestRoleSimilarity = 0;
  let bestRole: string | null = null;
  for (const role of roles) {
    // Trigram similarity alone badly under-rates a short role against a long
    // title: measured on the real corpus, the role "ანალიტიკოსი" scores only
    // 0.23 against "ბიუჯეტირებისა და რეპორტინგის უფროსი ანალიტიკოსი" purely
    // because Jaccard penalises the length difference — even though the title
    // literally contains the role. Containment covers exactly that case, so
    // the component takes whichever signal is stronger.
    const similarity = Math.max(
      trigramSimilarity(role.valueNormalized, normalizedTitle),
      containsTerm(normalizedTitle, role.valueNormalized) ? 1 : 0,
    );
    if (similarity > bestRoleSimilarity) {
      bestRoleSimilarity = similarity;
      bestRole = role.value;
    }
  }
  componentScores.push({
    component: 'role',
    score: bestRoleSimilarity,
    weight: WEIGHTS.role,
    matched:
      bestRole !== null && bestRoleSimilarity >= ROLE_TITLE_SIMILARITY
        ? [`${bestRole} ~ ${opportunity.title} (${bestRoleSimilarity.toFixed(2)})`]
        : [],
    missing:
      bestRoleSimilarity < ROLE_TITLE_SIMILARITY
        ? [`no profile role resembles "${opportunity.title}"`]
        : [],
  });

  const languages = claimsOfKind(claims, 'language');
  const matchedLanguages = languages.filter((language) =>
    containsTerm(searchable, language.valueNormalized),
  );
  componentScores.push({
    component: 'language',
    // Unlike skills, an unmentioned language is not evidence AGAINST a match —
    // most listings never name a language requirement at all. Scoring 1 when
    // the profile states none keeps this component from penalising the common
    // case; it carries the smallest weight precisely because it is weak.
    score: languages.length === 0 ? 1 : matchedLanguages.length / languages.length,
    weight: WEIGHTS.language,
    matched: matchedLanguages.map((language) => language.value),
    missing: languages
      .filter((language) => !matchedLanguages.includes(language))
      .map((language) => language.value),
  });

  const preferred = claimsOfKind(claims, 'preferred_profession');
  const matchedPreferred = preferred.filter((profession) =>
    containsTerm(searchable, profession.valueNormalized),
  );
  componentScores.push({
    component: 'professionPreference',
    score: preferred.length === 0 ? 0 : matchedPreferred.length > 0 ? 1 : 0,
    weight: WEIGHTS.professionPreference,
    matched: matchedPreferred.map((profession) => profession.value),
    missing:
      preferred.length > 0 && matchedPreferred.length === 0
        ? preferred.map((profession) => profession.value)
        : [],
  });

  const totalWeight = componentScores.reduce((sum, component) => sum + component.weight, 0);
  const weighted = componentScores.reduce(
    (sum, component) => sum + component.score * component.weight,
    0,
  );

  return {
    eligible: true,
    score: totalWeight === 0 ? 0 : weighted / totalWeight,
    hardFilterReasons: unenforcedConstraints,
    componentScores,
    evaluationVersion: RANKING_EVALUATION_VERSION,
  };
}
