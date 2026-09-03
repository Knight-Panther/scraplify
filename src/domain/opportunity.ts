import { z } from 'zod';
import {
  IsoDateTime,
  OpportunityId,
  OpportunityRevisionId,
  OpportunitySourceMembershipId,
  OrganizationId,
  Sha256Hex,
  SourceListingId,
  SourceListingRevisionId,
} from './ids.js';
import { SourceListingStatus } from './source-listing.js';

/** Initial opportunity types (§12.3). */
export const OpportunityType = z.enum(['job', 'summer_school', 'scholarship', 'grant', 'event']);
export type OpportunityType = z.infer<typeof OpportunityType>;

/**
 * Canonical status mirrors the same lifecycle vocabulary as a source listing
 * (§13) — a canonical opportunity is active/closed/expired the same way a
 * source listing is, just resolved across all its contributing sources.
 */
export const OpportunityCanonicalStatus = SourceListingStatus;
export type OpportunityCanonicalStatus = z.infer<typeof OpportunityCanonicalStatus>;

/** The probable real-world opportunity, independent of any one source (§12.3). */
export const OpportunitySchema = z.object({
  id: OpportunityId,
  type: OpportunityType,
  canonicalTitle: z.string().min(1),
  organizationId: OrganizationId.nullable(),
  canonicalStatus: OpportunityCanonicalStatus,
  currentCanonicalRevisionId: OpportunityRevisionId.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Opportunity = z.infer<typeof OpportunitySchema>;

/**
 * Immutable resolved view of a canonical opportunity at a point in time
 * (§12.4). Recomputed only when source membership, a contributing source
 * revision, or the resolution ruleset changes meaningfully.
 */
export const OpportunityRevisionSchema = z.object({
  id: OpportunityRevisionId,
  opportunityId: OpportunityId,
  canonicalTitle: z.string().min(1),
  canonicalStatus: OpportunityCanonicalStatus,
  organizationId: OrganizationId.nullable(),
  /** Field-level resolved values with provenance; deliberately loose at this stage. */
  resolvedFields: z.record(z.string(), z.unknown()),
  /** Which SourceListingRevision each contributing source was at, at resolution time. */
  sourceMembershipVersions: z.record(SourceListingId, SourceListingRevisionId),
  resolutionRulesetVersion: z.string().min(1),
  meaningfulContentHash: Sha256Hex,
  createdAt: IsoDateTime,
});
export type OpportunityRevision = z.infer<typeof OpportunityRevisionSchema>;

/** Dedupe decision states (§14.1 stage 5). */
export const DedupeDecision = z.enum([
  'confirmed_same',
  'probable_same',
  'needs_review',
  'distinct',
]);
export type DedupeDecision = z.infer<typeof DedupeDecision>;

/**
 * Links a source listing to a canonical opportunity (§12.5). Moving a source
 * listing between clusters must be reversible and audited — this record is
 * the audit trail, not just the current pointer.
 */
export const OpportunitySourceMembershipSchema = z.object({
  id: OpportunitySourceMembershipId,
  opportunityId: OpportunityId,
  sourceListingId: SourceListingId,
  decision: DedupeDecision,
  /** 0–1 confidence score backing the decision. */
  confidence: z.number().min(0).max(1),
  /** Evidence signals that produced the decision (§14.1 stage 4), kept as a structured bag. */
  evidence: z.record(z.string(), z.unknown()),
  decidedBy: z.enum(['ruleset', 'model', 'human']),
  decidedAt: IsoDateTime,
  dedupeModelOrRulesetVersion: z.string().min(1),
});
export type OpportunitySourceMembership = z.infer<typeof OpportunitySourceMembershipSchema>;
