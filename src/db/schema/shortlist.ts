import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { opportunities } from './opportunities.js';

/**
 * What the reader decided about an opportunity.
 *
 * Two states rather than two tables. "Saved" and "dismissed" are the same kind
 * of statement — a person's judgement about one opportunity — and they are
 * mutually exclusive: saving something already dismissed means changing your
 * mind about it, not holding both views at once. Two tables would let that
 * contradiction exist and would need a rule about which wins.
 */
export const opportunityDecisionEnum = pgEnum('opportunity_decision', ['saved', 'dismissed']);

/**
 * The reader's own shortlist — the "shortlist" half of "browse and shortlist".
 *
 * **Deliberately mutable, unlike `opportunity_source_memberships`.** §12.5
 * makes cluster membership append-only because a dedupe decision is evidence
 * about the data that later work depends on, and destroying it would destroy
 * the explanation of a merge. This is a different kind of record: a person
 * changing their mind about whether to apply for a job owes nobody an audit
 * trail, and keeping every toggle would turn a shortlist into a diary. One
 * row per opportunity, updated in place.
 *
 * `decidedAt` is therefore when the CURRENT decision was made, not when the
 * opportunity was first seen — and `firstDecidedAt` keeps the original, so
 * "dismissed this weeks ago and it keeps coming back" stays answerable without
 * storing every intermediate flip.
 *
 * The note is free text and is never parsed. It exists because a dismissal
 * three weeks later is unreadable without one — "wrong city", "already
 * applied", "salary too low" — and inferring the reason from the data would
 * be inventing it.
 */
export const opportunityDecisions = pgTable(
  'opportunity_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id),
    decision: opportunityDecisionEnum('decision').notNull(),
    /** The reader's own words. Never parsed, never required. */
    note: text('note'),
    /** When the CURRENT decision was made. Moves when the decision changes. */
    decidedAt: timestamp('decided_at', { mode: 'string', withTimezone: true }).notNull(),
    /**
     * When this opportunity was FIRST decided about, whatever the decision was.
     *
     * Kept because it is the one piece of history worth having and cannot be
     * recovered from a mutable row: it answers "I dismissed this ages ago and
     * it is still surfacing", which is a complaint about the corpus rather
     * than about the shortlist.
     */
    firstDecidedAt: timestamp('first_decided_at', { mode: 'string', withTimezone: true }).notNull(),
  },
  (table) => [
    // One decision per opportunity, enforced rather than assumed. Without it
    // a double submit — the ordinary consequence of a form and an impatient
    // click — silently creates a second row, and the screen then shows an
    // opportunity as both saved and dismissed depending on which it reads.
    uniqueIndex('opportunity_decisions_opportunity_id_unique').on(table.opportunityId),
  ],
);
