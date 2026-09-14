import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { opportunities, opportunityDecisions } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';

/**
 * The reader's own decisions about opportunities — the shortlist half of
 * "browse and shortlist".
 *
 * These are the first writes the web app performs. Everything else it does is
 * a read, which is why the write gate in `web/lib/writes.ts` was precautionary
 * until now and is load-bearing from here.
 *
 * The operations are deliberately few and total: an opportunity is saved,
 * dismissed, or undecided. There is no "unsave" separate from "clear", because
 * a shortlist with three verbs for two states is how a UI ends up with a
 * button whose effect nobody can predict.
 */

export type Decision = 'saved' | 'dismissed';

export interface DecisionRow {
  opportunityId: string;
  decision: Decision;
  note: string | null;
  decidedAt: string;
  firstDecidedAt: string;
}

/**
 * Records a decision, replacing whatever was there.
 *
 * One statement, not a read-then-write. The unique index on `opportunity_id`
 * means a concurrent double submit — a form and an impatient second click —
 * would otherwise race between the SELECT and the INSERT and fail on the
 * constraint; `on conflict` makes the second submit an update, which is also
 * what the user meant by pressing the button twice.
 *
 * `firstDecidedAt` is preserved by the update rather than restamped: it is the
 * one piece of history a mutable row cannot otherwise answer — "I dismissed
 * this weeks ago and it is still surfacing" is a complaint about the corpus,
 * and it needs the original date to be true.
 *
 * A note of `undefined` leaves the existing note alone; an explicit `null`
 * clears it. Those are different intentions and the caller usually means the
 * first, so they are not collapsed.
 */
export async function recordDecision(
  db: DatabaseOrTransaction,
  input: {
    opportunityId: string;
    decision: Decision;
    note?: string | null;
    now: string;
  },
): Promise<DecisionRow> {
  const note = normalizeNote(input.note);

  const [row] = await db
    .insert(opportunityDecisions)
    .values({
      id: randomUUID(),
      opportunityId: input.opportunityId,
      decision: input.decision,
      note: note ?? null,
      decidedAt: input.now,
      firstDecidedAt: input.now,
    })
    .onConflictDoUpdate({
      target: opportunityDecisions.opportunityId,
      set: {
        decision: input.decision,
        decidedAt: input.now,
        // `excluded` is the row that was proposed; keeping the stored
        // `first_decided_at` is the whole point of the column.
        ...(input.note === undefined ? {} : { note: note ?? null }),
      },
    })
    .returning({
      opportunityId: opportunityDecisions.opportunityId,
      decision: opportunityDecisions.decision,
      note: opportunityDecisions.note,
      decidedAt: opportunityDecisions.decidedAt,
      firstDecidedAt: opportunityDecisions.firstDecidedAt,
    });

  if (row === undefined) {
    throw new Error(`recordDecision: no row returned for opportunity ${input.opportunityId}`);
  }
  return row as DecisionRow;
}

/**
 * Removes a decision entirely, returning the opportunity to undecided.
 *
 * A delete rather than a third enum state. "Undecided" is the absence of a
 * decision, and modelling it as a value would mean every query that asks "what
 * did I decide" has to remember to exclude it.
 */
export async function clearDecision(
  db: DatabaseOrTransaction,
  opportunityId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(opportunityDecisions)
    .where(eq(opportunityDecisions.opportunityId, opportunityId))
    .returning({ id: opportunityDecisions.id });
  return deleted.length > 0;
}

/** A blank or whitespace-only note is no note, not an empty string. */
function normalizeNote(note: string | null | undefined): string | null | undefined {
  if (note === undefined) return undefined;
  if (note === null) return null;
  const trimmed = note.trim();
  return trimmed === '' ? null : trimmed;
}

export interface DecidedOpportunity extends DecisionRow {
  canonicalTitle: string;
  canonicalStatus: string;
  type: string;
}

/**
 * Everything decided one way, newest decision first.
 *
 * Joined to `opportunities` rather than returning bare ids, because a
 * shortlist of uuids is not a shortlist. The join is an inner one: a decision
 * whose opportunity has been deleted describes nothing, and the FK makes that
 * unreachable anyway.
 */
export async function listDecisions(
  db: DatabaseOrTransaction,
  decision: Decision,
): Promise<DecidedOpportunity[]> {
  return (
    db
      .select({
        opportunityId: opportunityDecisions.opportunityId,
        decision: opportunityDecisions.decision,
        note: opportunityDecisions.note,
        decidedAt: opportunityDecisions.decidedAt,
        firstDecidedAt: opportunityDecisions.firstDecidedAt,
        canonicalTitle: opportunities.canonicalTitle,
        canonicalStatus: opportunities.canonicalStatus,
        type: opportunities.type,
      })
      .from(opportunityDecisions)
      .innerJoin(opportunities, eq(opportunities.id, opportunityDecisions.opportunityId))
      .where(eq(opportunityDecisions.decision, decision))
      // Ends in the opportunity id for the reason every other ordering here
      // does: `decided_at` is not unique — saving several things in one sitting
      // produces identical timestamps — and an ORDER BY that is not total lets
      // the database return tied rows in any order.
      .orderBy(desc(opportunityDecisions.decidedAt), opportunityDecisions.opportunityId) as Promise<
      DecidedOpportunity[]
    >
  );
}

/**
 * The decisions for a set of opportunities, keyed by id.
 *
 * For the browse screens, which need to show what is already saved without
 * asking per row. Returns a map so a caller can look up without scanning.
 */
export async function decisionsByOpportunity(
  db: DatabaseOrTransaction,
  opportunityIds: readonly string[],
): Promise<Map<string, DecisionRow>> {
  const byId = new Map<string, DecisionRow>();
  if (opportunityIds.length === 0) return byId;

  const rows = await db
    .select({
      opportunityId: opportunityDecisions.opportunityId,
      decision: opportunityDecisions.decision,
      note: opportunityDecisions.note,
      decidedAt: opportunityDecisions.decidedAt,
      firstDecidedAt: opportunityDecisions.firstDecidedAt,
    })
    .from(opportunityDecisions)
    .where(inArray(opportunityDecisions.opportunityId, [...opportunityIds]));

  for (const row of rows) byId.set(row.opportunityId, row as DecisionRow);
  return byId;
}

/** How many opportunities sit in each state. */
export async function countDecisions(
  db: DatabaseOrTransaction,
): Promise<{ saved: number; dismissed: number }> {
  const [row] = await db
    .select({
      saved: sql<number>`count(*) filter (where ${opportunityDecisions.decision} = 'saved')::int`,
      dismissed: sql<number>`count(*) filter (where ${opportunityDecisions.decision} = 'dismissed')::int`,
    })
    .from(opportunityDecisions);
  return { saved: row?.saved ?? 0, dismissed: row?.dismissed ?? 0 };
}

/** Ids the reader has dismissed — what a browse screen would hide. */
export async function dismissedOpportunityIds(db: DatabaseOrTransaction): Promise<Set<string>> {
  const rows = await db
    .select({ opportunityId: opportunityDecisions.opportunityId })
    .from(opportunityDecisions)
    .where(and(eq(opportunityDecisions.decision, 'dismissed')));
  return new Set(rows.map((row) => row.opportunityId));
}
