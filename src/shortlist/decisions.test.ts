import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import { opportunities, opportunityDecisions } from '../db/schema/index.js';
import {
  clearDecision,
  countDecisions,
  decisionsByOpportunity,
  dismissedOpportunityIds,
  listDecisions,
  recordDecision,
} from './decisions.js';

/**
 * The first writes the web app performs, so these tests care most about the
 * things a form does that a well-behaved caller does not: submitting twice,
 * changing its mind, and clearing a note versus leaving it alone.
 */

describe('shortlist decisions', () => {
  const opportunityIds: string[] = [];

  async function opportunity(title: string): Promise<string> {
    const id = randomUUID();
    opportunityIds.push(id);
    await db.insert(opportunities).values({
      id,
      type: 'job',
      canonicalTitle: title,
      organizationId: null,
      canonicalStatus: 'active',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-08T00:00:00Z',
      updatedAt: '2026-09-08T00:00:00Z',
    });
    return id;
  }

  afterEach(async () => {
    if (opportunityIds.length === 0) return;
    await db
      .delete(opportunityDecisions)
      .where(inArray(opportunityDecisions.opportunityId, opportunityIds));
    await db.delete(opportunities).where(inArray(opportunities.id, opportunityIds));
    opportunityIds.length = 0;
  });

  it('saves an opportunity and reads it back', async () => {
    const id = await opportunity('Saved role');
    const row = await recordDecision(db, {
      opportunityId: id,
      decision: 'saved',
      note: 'looks promising',
      now: '2026-09-08T10:00:00Z',
    });

    expect(row.decision).toBe('saved');
    expect(row.note).toBe('looks promising');

    const saved = await listDecisions(db, 'saved');
    expect(saved.find((entry) => entry.opportunityId === id)?.canonicalTitle).toBe('Saved role');
  });

  /**
   * A form and an impatient second click. Without the unique index this
   * inserts twice and the screen then shows one opportunity as both saved and
   * dismissed, depending which row it happens to read.
   */
  it('treats a repeated submit as one decision, not two rows', async () => {
    const id = await opportunity('Double submit');

    await recordDecision(db, { opportunityId: id, decision: 'saved', now: '2026-09-08T10:00:00Z' });
    await recordDecision(db, { opportunityId: id, decision: 'saved', now: '2026-09-08T10:00:01Z' });

    const rows = await db
      .select({ id: opportunityDecisions.id })
      .from(opportunityDecisions)
      .where(inArray(opportunityDecisions.opportunityId, [id]));
    expect(rows).toHaveLength(1);
  });

  /** Two concurrent submits race between any read and write; one statement cannot. */
  it('survives two concurrent submits', async () => {
    const id = await opportunity('Concurrent');

    await Promise.all([
      recordDecision(db, { opportunityId: id, decision: 'saved', now: '2026-09-08T10:00:00Z' }),
      recordDecision(db, { opportunityId: id, decision: 'dismissed', now: '2026-09-08T10:00:00Z' }),
    ]);

    const rows = await db
      .select({ id: opportunityDecisions.id })
      .from(opportunityDecisions)
      .where(inArray(opportunityDecisions.opportunityId, [id]));
    expect(rows).toHaveLength(1);
  });

  /**
   * The one piece of history a mutable row cannot otherwise answer: "I
   * dismissed this weeks ago and it keeps surfacing" is a complaint about the
   * corpus, and it needs the original date to be true.
   */
  it('keeps the first decision date when the decision changes', async () => {
    const id = await opportunity('Changed mind');

    await recordDecision(db, {
      opportunityId: id,
      decision: 'dismissed',
      now: '2026-08-01T10:00:00Z',
    });
    const changed = await recordDecision(db, {
      opportunityId: id,
      decision: 'saved',
      now: '2026-09-08T10:00:00Z',
    });

    expect(changed.decision).toBe('saved');
    expect(changed.firstDecidedAt).toContain('2026-08-01');
    expect(changed.decidedAt).toContain('2026-09-08');
  });

  /**
   * Leaving a note alone and clearing it are different intentions, and a
   * caller that omits the field almost always means the first.
   */
  it('distinguishes “no note supplied” from “clear the note”', async () => {
    const id = await opportunity('Notes');

    await recordDecision(db, {
      opportunityId: id,
      decision: 'saved',
      note: 'wrong city',
      now: '2026-09-08T10:00:00Z',
    });

    const untouched = await recordDecision(db, {
      opportunityId: id,
      decision: 'dismissed',
      now: '2026-09-08T11:00:00Z',
    });
    expect(untouched.note).toBe('wrong city');

    const cleared = await recordDecision(db, {
      opportunityId: id,
      decision: 'dismissed',
      note: null,
      now: '2026-09-08T12:00:00Z',
    });
    expect(cleared.note).toBeNull();
  });

  it('treats a blank note as no note rather than an empty string', async () => {
    const id = await opportunity('Blank note');
    const row = await recordDecision(db, {
      opportunityId: id,
      decision: 'saved',
      note: '   ',
      now: '2026-09-08T10:00:00Z',
    });

    expect(row.note).toBeNull();
  });

  /** Undecided is the absence of a row, not a third state. */
  it('clears a decision back to undecided', async () => {
    const id = await opportunity('Cleared');
    await recordDecision(db, { opportunityId: id, decision: 'saved', now: '2026-09-08T10:00:00Z' });

    expect(await clearDecision(db, id)).toBe(true);
    expect((await decisionsByOpportunity(db, [id])).has(id)).toBe(false);
    // Clearing something already undecided is not an error; the end state is
    // what the caller asked for either way.
    expect(await clearDecision(db, id)).toBe(false);
  });

  it('separates saved from dismissed everywhere it reports them', async () => {
    const savedId = await opportunity('Keep');
    const dismissedId = await opportunity('Drop');

    await recordDecision(db, {
      opportunityId: savedId,
      decision: 'saved',
      now: '2026-09-08T10:00:00Z',
    });
    await recordDecision(db, {
      opportunityId: dismissedId,
      decision: 'dismissed',
      now: '2026-09-08T10:00:00Z',
    });

    const saved = await listDecisions(db, 'saved');
    const dismissed = await listDecisions(db, 'dismissed');
    expect(saved.map((entry) => entry.opportunityId)).toContain(savedId);
    expect(saved.map((entry) => entry.opportunityId)).not.toContain(dismissedId);
    expect(dismissed.map((entry) => entry.opportunityId)).toContain(dismissedId);

    const hidden = await dismissedOpportunityIds(db);
    expect(hidden.has(dismissedId)).toBe(true);
    expect(hidden.has(savedId)).toBe(false);

    const counts = await countDecisions(db);
    expect(counts.saved).toBeGreaterThanOrEqual(1);
    expect(counts.dismissed).toBeGreaterThanOrEqual(1);
  });

  it('looks up decisions for a set of opportunities in one query', async () => {
    const first = await opportunity('First');
    const second = await opportunity('Second');
    const undecided = await opportunity('Undecided');

    await recordDecision(db, {
      opportunityId: first,
      decision: 'saved',
      now: '2026-09-08T10:00:00Z',
    });
    await recordDecision(db, {
      opportunityId: second,
      decision: 'dismissed',
      now: '2026-09-08T10:00:00Z',
    });

    const map = await decisionsByOpportunity(db, [first, second, undecided]);
    expect(map.get(first)?.decision).toBe('saved');
    expect(map.get(second)?.decision).toBe('dismissed');
    expect(map.has(undecided)).toBe(false);
  });

  it('asks the database for nothing when given no ids', async () => {
    expect((await decisionsByOpportunity(db, [])).size).toBe(0);
  });
});
