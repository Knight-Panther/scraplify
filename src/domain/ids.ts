import { z } from 'zod';

/**
 * Branded UUID identifiers, one per entity in scraplify-concept.md §12/§12.6.
 * Branding prevents accidentally passing e.g. an OrganizationId where a
 * SourceListingId is expected — both are plain strings at runtime, but the
 * type checker treats them as distinct.
 */

export const SourceId = z.string().uuid().brand<'SourceId'>();
export type SourceId = z.infer<typeof SourceId>;

export const SourceListingId = z.string().uuid().brand<'SourceListingId'>();
export type SourceListingId = z.infer<typeof SourceListingId>;

export const SourceListingRevisionId = z.string().uuid().brand<'SourceListingRevisionId'>();
export type SourceListingRevisionId = z.infer<typeof SourceListingRevisionId>;

export const OpportunityId = z.string().uuid().brand<'OpportunityId'>();
export type OpportunityId = z.infer<typeof OpportunityId>;

export const OpportunityRevisionId = z.string().uuid().brand<'OpportunityRevisionId'>();
export type OpportunityRevisionId = z.infer<typeof OpportunityRevisionId>;

export const OpportunitySourceMembershipId = z
  .string()
  .uuid()
  .brand<'OpportunitySourceMembershipId'>();
export type OpportunitySourceMembershipId = z.infer<typeof OpportunitySourceMembershipId>;

export const OrganizationId = z.string().uuid().brand<'OrganizationId'>();
export type OrganizationId = z.infer<typeof OrganizationId>;

export const ResourceId = z.string().uuid().brand<'ResourceId'>();
export type ResourceId = z.infer<typeof ResourceId>;

export const TaxonomyTermId = z.string().uuid().brand<'TaxonomyTermId'>();
export type TaxonomyTermId = z.infer<typeof TaxonomyTermId>;

export const DuplicateCandidateId = z.string().uuid().brand<'DuplicateCandidateId'>();
export type DuplicateCandidateId = z.infer<typeof DuplicateCandidateId>;

export const CrawlRunId = z.string().uuid().brand<'CrawlRunId'>();
export type CrawlRunId = z.infer<typeof CrawlRunId>;

export const FetchAttemptId = z.string().uuid().brand<'FetchAttemptId'>();
export type FetchAttemptId = z.infer<typeof FetchAttemptId>;

export const ParserIncidentId = z.string().uuid().brand<'ParserIncidentId'>();
export type ParserIncidentId = z.infer<typeof ParserIncidentId>;

/** ISO 8601 datetime with a required timezone offset (or Z). */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/**
 * An absolute http(s) URL — protocol-restricted only. Deliberately not
 * `z.httpUrl()`, which also imposes an ASCII dotted-domain hostname regex
 * and would reject `http://localhost:8080`, IP hosts, and IDN hosts.
 * Destination restrictions (SSRF policy, allowed hosts) are a runtime
 * concern per request role, not a domain-contract concern.
 */
export const HttpUrl = z.url({ protocol: /^https?$/ });
export type HttpUrl = z.infer<typeof HttpUrl>;

/** SHA-256 digest, lowercase hex. */
export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256 digest');
export type Sha256Hex = z.infer<typeof Sha256Hex>;
