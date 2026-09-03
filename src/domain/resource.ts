import { z } from 'zod';
import { HttpUrl, IsoDateTime, ResourceId, Sha256Hex, SourceId } from './ids.js';

/** Request roles from §11 — every queued request/fetched artifact gets exactly one. */
export const ResourceRole = z.enum([
  'INDEX',
  'OPPORTUNITY',
  'ORGANIZATION',
  'APPLICATION',
  'ATTACHMENT',
]);
export type ResourceRole = z.infer<typeof ResourceRole>;

export const ResourceStatus = z.enum(['pending', 'fetched', 'quarantined', 'failed']);
export type ResourceStatus = z.infer<typeof ResourceStatus>;

/**
 * Identity of one fetched (or to-be-fetched) resource (§11, §16). Three URL
 * forms are kept deliberately distinct: what the parent page contained,
 * what it normalizes to, and where it actually resolved after redirects.
 * originalUrl is exactly what was found — often relative (e.g. jobs.ge's
 * `?view=jobs&id=123` or hr.ge's `/announcement/123/slug`) — so it's not
 * required to be an absolute URL. canonicalUrl and finalUrl are always
 * resolved/absolute *and* restricted to http(s): a `file:`, `javascript:`,
 * or `data:` URL passing this contract could later reach fetch/browser
 * code as if it were a legitimate remote target (§23.1: restrict URL
 * schemes by request role).
 */
export const ResourceSchema = z.object({
  id: ResourceId,
  sourceId: SourceId,
  role: ResourceRole,
  originalUrl: z.string().min(1),
  canonicalUrl: HttpUrl,
  finalUrl: HttpUrl.nullable(),
  status: ResourceStatus,
  fetchedAt: IsoDateTime.nullable(),
  contentHash: Sha256Hex.nullable(),
  byteSize: z.int().nonnegative().nullable(),
  mimeType: z.string().nullable(),
});
export type Resource = z.infer<typeof ResourceSchema>;

/** Relationship types between two resources (§12.6, §16). */
export const ResourceRelationship = z.enum([
  'attachment',
  'application_link',
  'organization_link',
  'pagination',
]);
export type ResourceRelationship = z.infer<typeof ResourceRelationship>;

/** A relationship between two resources (e.g. a detail page linking an attachment), §12.6. */
export const ResourceLinkSchema = z.object({
  id: z.string().uuid(),
  parentResourceId: ResourceId,
  childResourceId: ResourceId,
  relationship: ResourceRelationship,
});
export type ResourceLink = z.infer<typeof ResourceLinkSchema>;
