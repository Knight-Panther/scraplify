import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  opportunities,
  opportunitySourceMemberships,
  rankings,
  sourceListingRevisions,
  sourceListings,
} from '../db/schema/index.js';
import type { Database, DatabaseOrTransaction } from '../db/types.js';
import { loadCandidateProfile } from './profile-store.js';
import {
  type OpportunityForScoring,
  RANKING_EVALUATION_VERSION,
  scoreOpportunity,
} from './score-opportunity.js';

/**
 * Ranks every canonical opportunity against one candidate profile and caches
 * the results (§17.2).
 *
 * Caching is keyed by (opportunity revision, profile, profile version,
 * evaluation version). Because every input is in the key, changing any of them
 * produces a NEW row rather than overwriting the old — which is precisely what
 * §17.2's "never overwrite prior assessments when an input or model changes"
 * asks for. A rerun with unchanged inputs is therefore free and idempotent.
 */

export interface RunRankingOptions {
  profileId: string;
  now?: () => string;
  /** Recompute and replace cached rows for this exact key instead of reusing them. */
  force?: boolean;
  /** Rank only these opportunities; omitted means all of them. */
  opportunityIds?: readonly string[];
}

export interface RunRankingResult {
  profileId: string;
  profileVersion: number;
  evaluationVersion: string;
  opportunitiesConsidered: number;
  scored: number;
  cacheHits: number;
  filteredOut: number;
}

/**
 * Assembles the text a ranking scores against, from every source listing
 * currently clustered into the opportunity.
 *
 * Concatenating all contributing sources rather than picking one is
 * deliberate: the two boards carry genuinely different fields — hr.ge states
 * locations and salary, jobs.ge states neither — so choosing a single
 * "winner" listing would throw away the only copy of some facts. §14.2's
 * "preserve every source description" points the same way.
 */
async function loadOpportunitiesForScoring(
  db: DatabaseOrTransaction,
  opportunityIds: readonly string[] | undefined,
): Promise<Array<OpportunityForScoring & { currentRevisionId: string | null }>> {
  const opportunityRows = await db
    .select({
      opportunityId: opportunities.id,
      canonicalTitle: opportunities.canonicalTitle,
      currentRevisionId: opportunities.currentCanonicalRevisionId,
    })
    .from(opportunities)
    .where(
      opportunityIds === undefined ? undefined : inArray(opportunities.id, [...opportunityIds]),
    );

  if (opportunityRows.length === 0) return [];

  const memberRows = await db
    .select({
      opportunityId: opportunitySourceMemberships.opportunityId,
      title: sourceListingRevisions.titleRaw,
      description: sourceListingRevisions.description,
      locations: sourceListingRevisions.locations,
      deadlineAt: sourceListings.sourceDeadlineAt,
    })
    .from(opportunitySourceMemberships)
    .innerJoin(sourceListings, eq(sourceListings.id, opportunitySourceMemberships.sourceListingId))
    .innerJoin(
      sourceListingRevisions,
      eq(sourceListingRevisions.id, sourceListings.currentRevisionId),
    )
    .where(
      and(
        inArray(
          opportunitySourceMemberships.opportunityId,
          opportunityRows.map((row) => row.opportunityId),
        ),
        isNull(opportunitySourceMemberships.supersededAt),
      ),
    );

  return opportunityRows.map((row) => {
    const members = memberRows.filter((member) => member.opportunityId === row.opportunityId);
    const locations = new Set<string>();
    for (const member of members) {
      if (Array.isArray(member.locations)) {
        for (const location of member.locations) {
          if (typeof location === 'string') locations.add(location);
        }
      }
    }
    // The EARLIEST deadline across contributing sources: if one board says the
    // vacancy closes sooner, that is when a candidate loses the chance to
    // apply through it, and treating the later date as authoritative would
    // keep recommending an opportunity that is already shut on that source.
    const deadlines = members
      .map((member) => member.deadlineAt)
      .filter((deadline): deadline is string => deadline !== null)
      .sort();
    return {
      opportunityId: row.opportunityId,
      currentRevisionId: row.currentRevisionId,
      title: row.canonicalTitle,
      description: members.map((member) => member.description).join('\n\n'),
      deadlineAt: deadlines[0] ?? null,
      locations: [...locations],
    };
  });
}

export async function runRanking(
  db: Database,
  options: RunRankingOptions,
): Promise<RunRankingResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const profile = await loadCandidateProfile(db, options.profileId);
  if (profile === null) {
    throw new Error(`runRanking: no active candidate profile with id ${options.profileId}`);
  }

  const targets = await loadOpportunitiesForScoring(db, options.opportunityIds);
  const timestamp = now();

  let scored = 0;
  let cacheHits = 0;
  let filteredOut = 0;

  for (const target of targets) {
    // A cached row is only reusable when it pins the same revision. An
    // opportunity with no canonical revision yet pins nothing, so its ranking
    // is explicitly provisional and always recomputed.
    if (!options.force && target.currentRevisionId !== null) {
      const [cached] = await db
        .select({ id: rankings.id })
        .from(rankings)
        .where(
          and(
            eq(rankings.opportunityRevisionId, target.currentRevisionId),
            eq(rankings.profileId, profile.profileId),
            eq(rankings.profileVersion, profile.version),
            eq(rankings.evaluationVersion, RANKING_EVALUATION_VERSION),
          ),
        );
      if (cached !== undefined) {
        cacheHits++;
        continue;
      }
    }

    const result = scoreOpportunity(target, profile.claims, { now: timestamp });
    if (!result.eligible) filteredOut++;

    const row = {
      opportunityId: target.opportunityId,
      opportunityRevisionId: target.currentRevisionId,
      profileId: profile.profileId,
      profileVersion: profile.version,
      evaluationVersion: RANKING_EVALUATION_VERSION,
      score: result.score,
      eligible: result.eligible,
      hardFilterReasons: result.hardFilterReasons,
      componentScores: result.componentScores,
      createdAt: timestamp,
    };

    if (target.currentRevisionId === null) {
      // Unpinned: no cache key to conflict on, so replace this profile's
      // previous provisional row rather than accumulating one per run.
      await db
        .delete(rankings)
        .where(
          and(
            eq(rankings.opportunityId, target.opportunityId),
            eq(rankings.profileId, profile.profileId),
            isNull(rankings.opportunityRevisionId),
          ),
        );
      await db.insert(rankings).values({ id: randomUUID(), ...row });
    } else {
      await db
        .insert(rankings)
        .values({ id: randomUUID(), ...row })
        .onConflictDoUpdate({
          target: [
            rankings.opportunityRevisionId,
            rankings.profileId,
            rankings.profileVersion,
            rankings.evaluationVersion,
          ],
          set: {
            score: row.score,
            eligible: row.eligible,
            hardFilterReasons: row.hardFilterReasons,
            componentScores: row.componentScores,
            createdAt: row.createdAt,
          },
        });
    }
    scored++;
  }

  return {
    profileId: profile.profileId,
    profileVersion: profile.version,
    evaluationVersion: RANKING_EVALUATION_VERSION,
    opportunitiesConsidered: targets.length,
    scored,
    cacheHits,
    filteredOut,
  };
}

export interface RankedOpportunityView {
  opportunityId: string;
  canonicalTitle: string;
  score: number | null;
  eligible: boolean;
  hardFilterReasons: unknown;
  componentScores: unknown;
}

/**
 * The ranked list for a profile, best first. Ineligible opportunities are
 * excluded by default rather than sorted to the bottom: §17.2 treats hard
 * filtering as a separate stage, and a filtered-out opportunity has no score
 * to compare at all.
 */
export async function listRankedOpportunities(
  db: DatabaseOrTransaction,
  input: { profileId: string; includeIneligible?: boolean; limit?: number },
): Promise<RankedOpportunityView[]> {
  const conditions = [eq(rankings.profileId, input.profileId)];
  if (input.includeIneligible !== true) conditions.push(eq(rankings.eligible, true));

  return db
    .select({
      opportunityId: rankings.opportunityId,
      canonicalTitle: opportunities.canonicalTitle,
      score: rankings.score,
      eligible: rankings.eligible,
      hardFilterReasons: rankings.hardFilterReasons,
      componentScores: rankings.componentScores,
    })
    .from(rankings)
    .innerJoin(opportunities, eq(opportunities.id, rankings.opportunityId))
    .where(and(...conditions))
    .orderBy(desc(rankings.score))
    .limit(Math.min(input.limit ?? 25, 200));
}
