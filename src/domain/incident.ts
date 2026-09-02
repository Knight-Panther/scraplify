import { z } from 'zod';
import { CrawlRunId, IsoDateTime, ParserIncidentId, SourceId } from './ids.js';

/** Semantic failure kinds from §21.3 — HTTP 200 is not sufficient evidence of success. */
export const ParserIncidentKind = z.enum([
  'field_missing',
  'count_collapse',
  'count_surge',
  'access_denied',
  'captcha',
  'duplicate_spike',
  'mass_closure_suspected',
  'encoding_error',
  'unexpected_mime',
  'other',
]);
export type ParserIncidentKind = z.infer<typeof ParserIncidentKind>;

export const ParserIncidentSeverity = z.enum(['info', 'warning', 'critical']);
export type ParserIncidentSeverity = z.infer<typeof ParserIncidentSeverity>;

/**
 * A detected source-health anomaly (§21.3, §22). An open, unresolved
 * incident is what a run being quarantined should point back to.
 */
export const ParserIncidentSchema = z.object({
  id: ParserIncidentId,
  sourceId: SourceId,
  crawlRunId: CrawlRunId.nullable(),
  detectedAt: IsoDateTime,
  kind: ParserIncidentKind,
  severity: ParserIncidentSeverity,
  evidence: z.record(z.string(), z.unknown()),
  resolved: z.boolean(),
  resolvedAt: IsoDateTime.nullable(),
});
export type ParserIncident = z.infer<typeof ParserIncidentSchema>;
