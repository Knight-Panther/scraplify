import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  candidateProfiles,
  opportunities,
  opportunityRevisions,
  rankings,
} from '../db/schema/index.js';
import { RANKING_EVALUATION_VERSION } from './score-opportunity.js';
import { countRankedOpportunities, listRankedOpportunities } from './run-ranking.js';

/**
 * The ranked view had no tests at all, and the behaviour it gets wrong is
 * silent: it returns FEWER rows than expected, or none, rather than failing.
 *
 * That is not hypothetical. On 2026-09-08 the whole view returned zero rows
 * against a database holding 502 rankings, because every one of them was
 * pinned to a canonical revision a later dedupe pass had superseded. Nothing
 * reported an error — the screen would simply have been empty. These tests
 * pin the conditions that decide which stored ranking is the current one.
 *
 * Assertions are scoped to rows each test creates, since this query is
 * corpus-wide by design and a shared dev database also holds real rankings.
 */

describe('the ranked view', () => {
  const profileIds: string[] = [];
  const opportunityIds: string[] = [];

  async function profile(): Promise<string> {
    const id = randomUUID();
    profileIds.push(id);
    await db.insert(candidateProfiles).values({
      id,
      label: 'ranked-view test',
      version: 1,
      deletedAt: null,
      createdAt: '2026-09-08T00:00:00Z',
      updatedAt: '2026-09-08T00:00:00Z',
    });
    return id;
  }

  /** An opportunity with a canonical revision, since the view joins on it. */
  async function opportunity(title: string): Promise<{ id: string; revisionId: string }> {
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
    const revisionId = randomUUID();
    await db.insert(opportunityRevisions).values({
      id: revisionId,
      opportunityId: id,
      canonicalTitle: title,
      canonicalStatus: 'active',
      organizationId: null,
      resolvedFields: {},
      sourceMembershipVersions: {},
      resolutionRulesetVersion: 'v1',
      meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      createdAt: '2026-09-08T00:00:00Z',
    });
    await db
      .update(opportunities)
      .set({ currentCanonicalRevisionId: revisionId })
      .where(eq(opportunities.id, id));
    return { id, revisionId };
  }

  async function ranking(spec: {
    profileId: string;
    opportunityId: string;
    revisionId: string | null;
    score: number | null;
    eligible?: boolean;
    profileVersion?: number;
    evaluationVersion?: string;
  }): Promise<void> {
    await db.insert(rankings).values({
      id: randomUUID(),
      opportunityId: spec.opportunityId,
      opportunityRevisionId: spec.revisionId,
      profileId: spec.profileId,
      profileVersion: spec.profileVersion ?? 1,
      evaluationVersion: spec.evaluationVersion ?? RANKING_EVALUATION_VERSION,
      score: spec.score,
      eligible: spec.eligible ?? true,
      hardFilterReasons: [],
      componentScores: [],
      createdAt: '2026-09-08T00:00:00Z',
    });
  }

  afterEach(async () => {
    if (opportunityIds.length > 0) {
      await db.delete(rankings).where(inArray(rankings.opportunityId, opportunityIds));
      await db
        .update(opportunities)
        .set({ currentCanonicalRevisionId: null })
        .where(inArray(opportunities.id, opportunityIds));
      await db
        .delete(opportunityRevisions)
        .where(inArray(opportunityRevisions.opportunityId, opportunityIds));
      await db.delete(opportunities).where(inArray(opportunities.id, opportunityIds));
      opportunityIds.length = 0;
    }
    if (profileIds.length > 0) {
      await db.delete(rankings).where(inArray(rankings.profileId, profileIds));
      await db.delete(candidateProfiles).where(inArray(candidateProfiles.id, profileIds));
      profileIds.length = 0;
    }
  });

  /**
   * The failure that actually happened, as a test. A ranking pinned to a
   * superseded revision described different content, so presenting it as this
   * opportunity's score would be wrong — but the whole view going silently
   * empty is how nobody noticed for two days.
   */
  it('ignores a ranking pinned to a superseded canonical revision', async () => {
    const profileId = await profile();
    const { id, revisionId } = await opportunity('Current revision');

    const supersededRevisionId = randomUUID();
    await db.insert(opportunityRevisions).values({
      id: supersededRevisionId,
      opportunityId: id,
      canonicalTitle: 'Old title',
      canonicalStatus: 'active',
      organizationId: null,
      resolvedFields: {},
      sourceMembershipVersions: {},
      resolutionRulesetVersion: 'v1',
      meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      createdAt: '2026-09-07T00:00:00Z',
    });

    await ranking({ profileId, opportunityId: id, revisionId: supersededRevisionId, score: 0.9 });
    expect(await listRankedOpportunities(db, { profileId })).toHaveLength(0);
    expect(await countRankedOpportunities(db, { profileId })).toBe(0);

    await ranking({ profileId, opportunityId: id, revisionId, score: 0.4 });
    const rows = await listRankedOpportunities(db, { profileId });
    expect(rows).toHaveLength(1);
    // The current one, not the higher-scoring stale one.
    expect(rows[0]?.score).toBeCloseTo(0.4);
    expect(rows[0]?.canonicalStatus).toBe('active');
  });

  it('ignores a ranking from an older profile version or evaluation version', async () => {
    const profileId = await profile();
    const { id, revisionId } = await opportunity('Version test');

    await ranking({ profileId, opportunityId: id, revisionId, score: 0.9, profileVersion: 0 });
    await ranking({
      profileId,
      opportunityId: id,
      revisionId,
      score: 0.8,
      evaluationVersion: 'deterministic-v0',
    });

    expect(await listRankedOpportunities(db, { profileId })).toHaveLength(0);
  });

  it('excludes hard-filtered opportunities unless they are asked for', async () => {
    const profileId = await profile();
    const eligible = await opportunity('Eligible');
    const filtered = await opportunity('Filtered');

    await ranking({
      profileId,
      opportunityId: eligible.id,
      revisionId: eligible.revisionId,
      score: 0.5,
    });
    await ranking({
      profileId,
      opportunityId: filtered.id,
      revisionId: filtered.revisionId,
      score: null,
      eligible: false,
    });

    expect(await listRankedOpportunities(db, { profileId })).toHaveLength(1);
    expect(await countRankedOpportunities(db, { profileId })).toBe(1);

    expect(await listRankedOpportunities(db, { profileId, includeIneligible: true })).toHaveLength(
      2,
    );
    expect(await countRankedOpportunities(db, { profileId, includeIneligible: true })).toBe(2);
  });

  /**
   * The count and the rows are built from one condition list precisely so they
   * cannot disagree — a screen saying "399 matches" above a different set is
   * wrong about both numbers.
   */
  it('counts exactly what it lists', async () => {
    const profileId = await profile();
    for (let index = 0; index < 5; index += 1) {
      const created = await opportunity(`Counted ${index}`);
      await ranking({
        profileId,
        opportunityId: created.id,
        revisionId: created.revisionId,
        score: index / 10,
      });
    }

    const total = await countRankedOpportunities(db, { profileId });
    const rows = await listRankedOpportunities(db, { profileId, limit: 500 });
    expect(total).toBe(5);
    expect(rows).toHaveLength(total);
  });

  /**
   * Pages a fully tied result set and checks nothing is duplicated or lost.
   *
   * **Be clear about what this does not prove.** Mutation-checked on
   * 2026-09-08: removing the `rankings.opportunityId` tie-breaker leaves this
   * test green. Postgres returns a small heap scan in a stable order, so the
   * nondeterminism the tie-breaker guards against cannot be provoked at this
   * size — and probably not reliably at any size, since it depends on plan
   * choice and physical row order rather than on anything a test controls.
   *
   * The tie-breaker stays regardless, because the guarantee is structural: an
   * ORDER BY that is not total permits the database to return tied rows in any
   * order, and LIMIT/OFFSET over that duplicates some rows onto the next batch
   * and drops others. Scores tie constantly here — a component set that
   * matches nothing scores exactly 0 for every listing it applies to.
   *
   * Recorded rather than deleted: the paging check below is still worth
   * having, and a test that silently proves less than its name claims is worse
   * than one that says so.
   */
  it('pages a tied result set without duplicating or dropping a row', async () => {
    const profileId = await profile();
    for (let index = 0; index < 6; index += 1) {
      const created = await opportunity(`Tied ${index}`);
      await ranking({
        profileId,
        opportunityId: created.id,
        revisionId: created.revisionId,
        score: 0,
      });
    }

    const first = await listRankedOpportunities(db, { profileId, limit: 3, offset: 0 });
    const second = await listRankedOpportunities(db, { profileId, limit: 3, offset: 3 });
    const paged = [...first, ...second].map((row) => row.opportunityId);

    expect(paged).toHaveLength(6);
    expect(new Set(paged).size).toBe(6);
  });

  /**
   * Hard-filtered results sort LAST, and the default is the opposite.
   *
   * A filtered opportunity has a null score, because §17.2 treats filtering as
   * a stage before scoring rather than a score of zero — and Postgres orders
   * DESC with NULLS FIRST, so every excluded result led the list. The screen
   * numbers these rows, so it presented "your best result" as something the
   * scorer had rejected outright. Found in browser QA on 2026-09-08, with all
   * eight of the corpus's excluded opportunities sitting at ranks 1-8.
   */
  it('sorts hard-filtered results below every scored one', async () => {
    const profileId = await profile();
    const filtered = await opportunity('Excluded');
    const low = await opportunity('Low score');

    await ranking({
      profileId,
      opportunityId: filtered.id,
      revisionId: filtered.revisionId,
      score: null,
      eligible: false,
    });
    await ranking({ profileId, opportunityId: low.id, revisionId: low.revisionId, score: 0.01 });

    const rows = await listRankedOpportunities(db, { profileId, includeIneligible: true });
    expect(rows.map((row) => row.canonicalTitle)).toEqual(['Low score', 'Excluded']);
  });

  it('returns nothing for a profile that does not exist', async () => {
    expect(await listRankedOpportunities(db, { profileId: randomUUID() })).toEqual([]);
    expect(await countRankedOpportunities(db, { profileId: randomUUID() })).toBe(0);
  });

  /** An absurd limit is clamped rather than handed to the database. */
  it('clamps the limit', async () => {
    const profileId = await profile();
    const created = await opportunity('Clamped');
    await ranking({
      profileId,
      opportunityId: created.id,
      revisionId: created.revisionId,
      score: 0.1,
    });

    expect(await listRankedOpportunities(db, { profileId, limit: 100_000 })).toHaveLength(1);
    expect(await listRankedOpportunities(db, { profileId, limit: -5 })).toHaveLength(1);
  });
});
