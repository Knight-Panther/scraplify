import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The admin surface's own audit trail (Phase 8B Stage 11, concept §30.2,
 * change.md §13). A separate table from `audit_events` (`schema/outreach.ts`)
 * rather than a reuse of it: that table's `audit_action` enum is closed to
 * outreach-lifecycle values (`draft_generated`, `draft_approved`, …), and it
 * has no `outcome` column at all — every row there is an implicit success.
 * Growing it with unrelated admin values, or assuming every admin action
 * here succeeds, would both be wrong.
 */

export const adminAuditOutcomeEnum = pgEnum('admin_audit_outcome', [
  'succeeded',
  'refused',
  'failed',
]);

export const adminAuditActionEnum = pgEnum('admin_audit_action', [
  'duplicate_accept',
  'duplicate_reject',
  'taxonomy_confirm',
  'taxonomy_reject',
  'taxonomy_undo',
]);

export const adminAuditEvents = pgTable(
  'admin_audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Nullable: a `refused` row for a genuinely unauthenticated attempt has
    // no actor to name at all — `null` states that honestly rather than
    // inventing a placeholder. GitHub's numeric id (immutable), not a login
    // name — the same identity `ADMIN_GITHUB_IDS` itself is keyed on.
    actorGithubId: text('actor_github_id'),
    entityType: text('entity_type').notNull(),
    // Also nullable: a `refused` row for a malformed request (an unparsable
    // form field) may have no entity to name either.
    entityId: text('entity_id'),
    action: adminAuditActionEnum('action').notNull(),
    outcome: adminAuditOutcomeEnum('outcome').notNull(),
    occurredAt: timestamp('occurred_at', { mode: 'string', withTimezone: true }).notNull(),
    // ids/hashes/recognized-category strings only, same discipline as
    // `audit_events.details` — never free-text content, since a `failed`
    // row's own conflict message is not guaranteed to stay content-free
    // forever the way this table's own writers are today.
    details: jsonb('details').notNull(),
  },
  (table) => [index('admin_audit_events_entity_idx').on(table.entityType, table.entityId)],
);

export type AdminAuditEventRow = typeof adminAuditEvents.$inferSelect;
export type NewAdminAuditEventRow = typeof adminAuditEvents.$inferInsert;
export type AdminAuditAction = (typeof adminAuditActionEnum.enumValues)[number];
export type AdminAuditOutcome = (typeof adminAuditOutcomeEnum.enumValues)[number];
