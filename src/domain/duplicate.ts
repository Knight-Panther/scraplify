import { z } from 'zod';
import { DuplicateCandidateId, IsoDateTime, SourceListingId } from './ids.js';
import { DedupeDecision } from './opportunity.js';

/**
 * A candidate pair produced by index-based candidate generation (§14.1
 * stage 3, e.g. pg_trgm) — distinct from OpportunitySourceMembership, which
 * is the final resolved link. Most candidates are never evaluated further;
 * evaluation only happens when signals cross a threshold worth reviewing.
 */
export const DuplicateCandidateSchema = z.object({
  id: DuplicateCandidateId,
  sourceListingIdA: SourceListingId,
  sourceListingIdB: SourceListingId,
  generatedAt: IsoDateTime,
  generationMethod: z.enum(['pg_trgm', 'deterministic_match', 'other']),
  /** Candidate-generation similarity, not the final weighted-evidence confidence. */
  similarityScore: z.number().min(0).max(1),
  status: z.enum(['pending', 'evaluated']),
  /** Set once evaluated (§14.1 stage 5); null while still pending. */
  resultingDecision: DedupeDecision.nullable(),
});
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;
