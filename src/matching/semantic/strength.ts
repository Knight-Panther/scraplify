import type { HybridReason } from './hybrid.js';

/**
 * How strong a CV Ranked match is, from the kind of evidence behind it —
 * never from the fused score, which is only an ordering:
 * - **strong**: the title names one of the active roles;
 * - **good**: the title is close to a role — near in spelling, similar in
 *   meaning, or naming it only in its English equivalent;
 * - **partial**: no role, only a field, a skill, or a line of the CV.
 *
 * Measured against the judged grades (2 strong fit, 1 plausible, 0 not
 * relevant) of each CV's first 50 results, 32 English and Georgian suite
 * CVs and 24 held-out CVs. A title naming the role was relevant 96–99% of
 * the time and a strong fit 74–94%; a close title relevant 50–68%, a strong
 * fit 20–46%; a field or skill alone relevant 0–27%, a strong fit 0–5%.
 * Similarity to a CV line (the Russian CVs', 11 rows) was relevant 45%, a
 * strong fit never, so it stays partial. How close a similar title is
 * (its cosine) did not separate grades consistently across the two sets,
 * so it plays no part. A translated title had no judged rows; it stays
 * below a title that names the role as written.
 */
export type MatchStrength = 'strong' | 'good' | 'partial';

export const MATCH_STRENGTHS: readonly MatchStrength[] = ['strong', 'good', 'partial'];

export function matchStrength(reasons: readonly HybridReason[]): MatchStrength {
  let good = false;
  for (const reason of reasons) {
    if (reason.kind === 'role' && reason.exact) return 'strong';
    if (
      reason.kind === 'role' ||
      reason.kind === 'translated-role' ||
      (reason.kind === 'similar' && reason.from === 'role')
    ) {
      good = true;
    }
  }
  return good ? 'good' : 'partial';
}
