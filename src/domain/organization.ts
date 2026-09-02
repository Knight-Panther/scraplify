import { z } from 'zod';
import { IsoDateTime, OrganizationId, SourceListingId } from './ids.js';

/** §15.3: keep staffing agencies and the employer they represent separately identifiable. */
export const OrganizationKind = z.enum(['employer', 'staffing_agency']);
export type OrganizationKind = z.infer<typeof OrganizationKind>;

export const OrganizationSchema = z.object({
  id: OrganizationId,
  canonicalName: z.string().min(1),
  kind: OrganizationKind,
  /** Official domain, used as alias evidence — not necessarily where listings link to. */
  domain: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Organization = z.infer<typeof OrganizationSchema>;

/**
 * A raw name variant observed for an organization (§15.3). Aliases are
 * stored, not used to overwrite historical revision values.
 */
export const OrganizationAliasSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationId,
  rawName: z.string().min(1),
  evidenceType: z.enum(['source_display_name', 'domain_match', 'contact_match', 'reviewed']),
  sourceListingId: SourceListingId.nullable(),
  createdAt: IsoDateTime,
});
export type OrganizationAlias = z.infer<typeof OrganizationAliasSchema>;
