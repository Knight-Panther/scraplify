import { z } from 'zod';
import { IsoDateTime, OpportunityId, OpportunityRevisionId } from './ids.js';

/**
 * Candidate profile and ranking contracts (§17).
 *
 * Two constraints shape everything here, and both come from §17 rather than
 * from convenience:
 *
 * 1. **Every claim points back at supporting CV content** (§17.1). A profile
 *    is not a bag of assertions — it is a set of claims a human can audit
 *    against the document they came from, and correct before ranking.
 * 2. **A ranking must explain itself and be reproducible** (§17.2). That means
 *    component scores, matched evidence, missing requirements, hard-filter
 *    reasons, and the exact versions of every input are part of the result,
 *    not debug output.
 */

export const CandidateProfileId = z.string().uuid().brand<'CandidateProfileId'>();
export type CandidateProfileId = z.infer<typeof CandidateProfileId>;

export const CandidateProfileClaimId = z.string().uuid().brand<'CandidateProfileClaimId'>();
export type CandidateProfileClaimId = z.infer<typeof CandidateProfileClaimId>;

export const RankingId = z.string().uuid().brand<'RankingId'>();
export type RankingId = z.infer<typeof RankingId>;

/** The §17.1 axes. Kept as an enum so a claim can never be filed under an ad-hoc kind. */
export const CandidateClaimKind = z.enum([
  'role',
  'skill',
  'education',
  'certification',
  'language',
  'location_preference',
  'work_mode_preference',
  'salary_constraint',
  'schedule_constraint',
  'preferred_profession',
  'excluded_profession',
]);
export type CandidateClaimKind = z.infer<typeof CandidateClaimKind>;

/**
 * How a claim came to exist. `parsed` claims are machine-extracted and are
 * exactly the ones a human should check; `confirmed` and `manual` carry human
 * authority. Kept explicit so ranking can, later, weight a reviewed profile
 * differently from a raw extraction rather than treating all claims alike.
 */
export const CandidateClaimOrigin = z.enum(['parsed', 'confirmed', 'manual']);
export type CandidateClaimOrigin = z.infer<typeof CandidateClaimOrigin>;

export const CandidateProfileClaimSchema = z.object({
  id: CandidateProfileClaimId,
  profileId: CandidateProfileId,
  kind: CandidateClaimKind,
  /** The claim itself, normalized for matching by the ranking code, never for display. */
  value: z.string().min(1),
  /**
   * §17.1's "pointer to supporting CV content" — the quoted span this claim
   * was drawn from. Null only for a `manual` claim the user asserted directly,
   * which by definition has no CV passage behind it.
   */
  evidence: z.string().nullable(),
  origin: CandidateClaimOrigin,
  /** Extraction confidence for `parsed` claims; 1 for anything a human asserted. */
  confidence: z.number().min(0).max(1),
  /** Years of experience, for role claims. Null when not stated or not applicable. */
  years: z.number().nonnegative().nullable(),
});
export type CandidateProfileClaim = z.infer<typeof CandidateProfileClaimSchema>;

/**
 * A versioned candidate profile (§17.1).
 *
 * `version` increments on every accepted correction rather than editing in
 * place, because §17.2 requires a ranking to name the profile version it used
 * and forbids overwriting prior assessments when an input changes. A mutable
 * profile would silently invalidate every cached ranking that referenced it
 * while leaving those rankings claiming to be current.
 */
export const CandidateProfileSchema = z.object({
  id: CandidateProfileId,
  label: z.string().min(1),
  version: z.number().int().positive(),
  /** Set when the user deletes it; §6.2 requires CV-derived data to be deletable. */
  deletedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CandidateProfile = z.infer<typeof CandidateProfileSchema>;

/** Why a hard filter rejected an opportunity outright (§17.2's first funnel stage). */
export const HardFilterReasonSchema = z.object({
  filter: z.string().min(1),
  detail: z.string().min(1),
});
export type HardFilterReason = z.infer<typeof HardFilterReasonSchema>;

/** One scored dimension, with the evidence that produced it. */
export const ComponentScoreSchema = z.object({
  component: z.string().min(1),
  /** 0-1 within the component, before weighting. */
  score: z.number().min(0).max(1),
  weight: z.number().min(0),
  /** Claims and listing terms that actually matched — §17.2's "strong matching evidence". */
  matched: z.array(z.string()),
  /** §17.2's "missing or uncertain requirements". */
  missing: z.array(z.string()),
});
export type ComponentScore = z.infer<typeof ComponentScoreSchema>;

/**
 * A cached, explainable ranking of one opportunity for one profile (§17.2).
 *
 * The cache key is (opportunity revision, profile id, profile version,
 * evaluation version) — all four, because a ranking is only valid for the
 * exact inputs that produced it. §17.2: "Cache results by opportunity
 * revision, candidate-profile version, and evaluation version. Never
 * overwrite prior assessments when an input or model changes."
 */
export const RankingSchema = z.object({
  id: RankingId,
  opportunityId: OpportunityId,
  /** Null when the opportunity has no canonical revision yet; the ranking then pins nothing and must be recomputed. */
  opportunityRevisionId: OpportunityRevisionId.nullable(),
  profileId: CandidateProfileId,
  profileVersion: z.number().int().positive(),
  /** Bumped whenever scoring logic changes, so old rankings stay identifiable rather than silently stale. */
  evaluationVersion: z.string().min(1),
  /** Overall 0-1 score. Null when a hard filter excluded the opportunity entirely. */
  score: z.number().min(0).max(1).nullable(),
  eligible: z.boolean(),
  hardFilterReasons: z.array(HardFilterReasonSchema),
  componentScores: z.array(ComponentScoreSchema),
  createdAt: IsoDateTime,
});
export type Ranking = z.infer<typeof RankingSchema>;
