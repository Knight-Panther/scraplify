import { boolean, jsonb, pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { crawlRuns } from './runs.js';
import { sources } from './sources.js';

export const parserIncidentKindEnum = pgEnum('parser_incident_kind', [
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
export const parserIncidentSeverityEnum = pgEnum('parser_incident_severity', [
  'info',
  'warning',
  'critical',
]);

/** Mirrors ParserIncidentSchema. */
export const parserIncidents = pgTable('parser_incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id')
    .notNull()
    .references(() => sources.id),
  crawlRunId: uuid('crawl_run_id').references(() => crawlRuns.id),
  detectedAt: timestamp('detected_at', { mode: 'string', withTimezone: true }).notNull(),
  kind: parserIncidentKindEnum('kind').notNull(),
  severity: parserIncidentSeverityEnum('severity').notNull(),
  evidence: jsonb('evidence').notNull(),
  resolved: boolean('resolved').notNull().default(false),
  resolvedAt: timestamp('resolved_at', { mode: 'string', withTimezone: true }),
});

export type ParserIncidentRow = typeof parserIncidents.$inferSelect;
export type NewParserIncidentRow = typeof parserIncidents.$inferInsert;
