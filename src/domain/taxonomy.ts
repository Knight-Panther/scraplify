import { z } from 'zod';
import { IsoDateTime, SourceId, SourceListingRevisionId, TaxonomyTermId } from './ids.js';

/** Taxonomy axes (§15.1) — never collapsed into one label. */
export const TaxonomyAxis = z.enum([
  'opportunity_type',
  'profession',
  'functional_area',
  'industry',
  'seniority',
  'employment_type',
  'schedule',
  'work_mode',
  'skill',
  'language',
  'education',
  'location',
]);
export type TaxonomyAxis = z.infer<typeof TaxonomyAxis>;

export const ClassificationMethod = z.enum([
  'deterministic_rule',
  'keyword',
  'llm_classification',
  'human_review',
]);
export type ClassificationMethod = z.infer<typeof ClassificationMethod>;

/** One versioned term in the canonical, practical, Georgian-listings-sized taxonomy (§15.2). */
export const TaxonomyTermSchema = z.object({
  id: TaxonomyTermId,
  axis: TaxonomyAxis,
  /** Stable slug, independent of label wording changes. */
  code: z.string().min(1),
  label: z.string().min(1),
  taxonomyVersion: z.string().min(1),
  parentId: TaxonomyTermId.nullable(),
});
export type TaxonomyTerm = z.infer<typeof TaxonomyTermSchema>;

/** Maps one source's raw category label to a canonical term (§15.2 steps 1–4). */
export const SourceTaxonomyMappingSchema = z.object({
  id: z.string().uuid(),
  sourceId: SourceId,
  sourceCategoryRaw: z.string().min(1),
  taxonomyTermId: TaxonomyTermId,
  method: ClassificationMethod,
  confidence: z.number().min(0).max(1).nullable(),
  taxonomyVersion: z.string().min(1),
});
export type SourceTaxonomyMapping = z.infer<typeof SourceTaxonomyMappingSchema>;

/** A classification applied to one listing revision (§15.2 steps 5–8). */
export const ListingClassificationSchema = z.object({
  id: z.string().uuid(),
  sourceListingRevisionId: SourceListingRevisionId,
  taxonomyTermId: TaxonomyTermId,
  axis: TaxonomyAxis,
  method: ClassificationMethod,
  confidence: z.number().min(0).max(1),
  evidence: z.record(z.string(), z.unknown()),
  taxonomyVersion: z.string().min(1),
  createdAt: IsoDateTime,
});
export type ListingClassification = z.infer<typeof ListingClassificationSchema>;
