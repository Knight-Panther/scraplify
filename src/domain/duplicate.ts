import { z } from 'zod';
import { DuplicateCandidateId, IsoDateTime, SourceListingId } from './ids.js';
import { DedupeDecision } from './opportunity.js';

const DuplicateCandidateSharedFields = {
  id: DuplicateCandidateId,
  sourceListingIdA: SourceListingId,
  sourceListingIdB: SourceListingId,
  generatedAt: IsoDateTime,
  generationMethod: z.enum(['pg_trgm', 'deterministic_match', 'other']),
  /** Candidate-generation similarity, not the final weighted-evidence confidence. */
  similarityScore: z.number().min(0).max(1),
};

/**
 * A candidate pair produced by index-based candidate generation (§14.1
 * stage 3, e.g. pg_trgm) — distinct from OpportunitySourceMembership, which
 * is the final resolved link. Most candidates are never evaluated further;
 * evaluation only happens when signals cross a threshold worth reviewing.
 *
 * A discriminated union on `status`, not a plain object with a nullable
 * `resultingDecision`: makes "pending with a decision already set" and
 * "evaluated with no decision" unrepresentable, instead of merely
 * discouraged.
 */
export const DuplicateCandidateSchema = z.discriminatedUnion('status', [
  z.object({
    ...DuplicateCandidateSharedFields,
    status: z.literal('pending'),
    resultingDecision: z.null(),
  }),
  z.object({
    ...DuplicateCandidateSharedFields,
    status: z.literal('evaluated'),
    /** Set once evaluated (§14.1 stage 5). */
    resultingDecision: DedupeDecision,
  }),
]);
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;
