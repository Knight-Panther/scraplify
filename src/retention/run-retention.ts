import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  duplicateCandidates,
  fetchAttempts,
  listingClassifications,
  opportunities,
  opportunityRevisions,
  opportunitySourceMemberships,
  parserIncidents,
  resources,
  sourceListingRevisions,
  sourceListings,
  sources,
} from '../db/schema/index.js';
import type { Database, DatabaseOrTransaction } from '../db/types.js';
import {
  type ClusterClosureResult,
  type ClusterGraph,
  closeOverClusters,
  filterTier3Candidates,
  findAgedFetchAttemptIds,
  findOrphanResourceIds,
  findResolvedIncidentIds,
  findTier2CandidateListingIds,
  findTier3CandidateListingIds,
  loadClusterGraph,
  planTier2Revisions,
  type Tier2RevisionPlan,
} from './eligibility.js';
import { cutoffs, RETENTION_POLICY } from './policy.js';
import { withRetentionLocks } from './retention-lock.js';

/**
 * Runs one retention pass (Phase 7C): telemetry cleanup, closed/expired
 * trimming, and whole-cluster purging, in that order (docs, retention plan
 * §4's "Run order: 1a fetch_attempts -> 1b incidents -> 3 -> 2 -> 1c
 * resources").
 *
 * Bounded, not a drain-to-empty loop — the same `find...` query would return
 * the same rows forever in dry run (nothing is deleted to make it advance),
 * so a bounded pass is what keeps dry-run and apply counts comparable for
 * the SAME input. But "bounded to one batch" is NOT the same as "makes
 * progress": a batch selected by id alone has no way to know a row is
 * permanently blocked (entangled with a live listing, or referenced by user
 * data), and re-selecting the same blocked low-id rows every run would
 * starve real, deletable work sitting behind them forever — a P1 found in
 * adversarial review (2026-09-28). Tier 2 and tier 3 each keyset-paginate
 * (`findTier2CandidateListingIds`/`findTier3CandidateListingIds`'s own
 * `afterId`) through up to `RETENTION_POLICY.tier2MaxPages`/`tier3MaxPages`
 * batches per call, stopping at the first one with actual work, so a
 * permanently-blocked prefix is skipped rather than re-processed — this
 * still runs after every crawl (deploy/run-pipeline.sh,
 * scripts/run-crawl.ps1), so anything left over past that page budget is
 * picked up by the next run.
 */

export interface RunRetentionOptions {
  now: Date;
  /** Dry run by default at the CLI layer — this flag is what actually gates every mutation. */
  apply: boolean;
  /** Scopes every tier's queries AND every source's crawl-process lock. Defaults to every row in `sources`. Tests MUST pass their own disposable source ids (real-data-guard.ts) — never left to default against a database that also holds real jobs-ge/hr-ge rows. */
  sourceIds?: readonly string[];
  /** Overrides `RETENTION_POLICY`'s tier 2/3 batch sizes — for tests only, so a "more blocked candidates than one batch" scenario stays cheap to set up. */
  batchSize?: { tier2?: number; tier3?: number };
}

export interface Tier1Result {
  fetchAttemptsDeleted: number;
  incidentsDeleted: number;
  orphanResourcesDeleted: number;
}

export interface Tier2Result {
  listingsTrimmed: number;
  revisionsDeleted: number;
  skippedPinnedByDraft: number;
  skippedClassificationChain: number;
  descriptionBytesFreed: number;
}

export interface Tier3Result {
  listingsDeleted: number;
  opportunitiesDeleted: number;
  membershipsDeleted: number;
  duplicateCandidatesDeleted: number;
  classificationsDeleted: number;
  revisionsDeleted: number;
  /** Candidates left alone because their cluster's opportunity carries a decision, a ranking, or an outreach draft. */
  blockedUserData: number;
  /** Candidates left alone because a cluster-mate (live or retired) is not itself a candidate. */
  blockedEntangled: number;
}

export interface RunRetentionResult {
  apply: boolean;
  tier1: Tier1Result;
  tier2: Tier2Result;
  tier3: Tier3Result;
}

export type RunRetentionOutcome =
  | { ran: true; result: RunRetentionResult }
  | { ran: false; reason: string };

export async function runRetention(
  db: Database,
  pool: Pool,
  options: RunRetentionOptions,
): Promise<RunRetentionOutcome> {
  const sourceIds = options.sourceIds ?? (await allSourceIds(db));
  const locked = await withRetentionLocks(pool, sourceIds, () =>
    runRetentionLocked(db, { ...options, sourceIds }),
  );
  if (locked.outcome === 'skipped') return { ran: false, reason: locked.reason };
  return { ran: true, result: locked.result };
}

async function allSourceIds(db: Database): Promise<string[]> {
  const rows = await db.select({ id: sources.id }).from(sources);
  return rows.map((row) => row.id);
}

async function runRetentionLocked(
  db: Database,
  options: RunRetentionOptions & { sourceIds: readonly string[] },
): Promise<RunRetentionResult> {
  const { apply, sourceIds } = options;
  const { telemetryCutoff, trimCutoff, purgeCutoff } = cutoffs(options.now);
  const nowIso = options.now.toISOString();

  // 1a + 1b, before tier 3 and 2 (plan §4's run order) — cheap, no cluster
  // reasoning, and doing them first means the orphan-resource sweep at the
  // very end sees whatever tier 2/3 additionally freed up.
  const fetchAttemptIds = await findAgedFetchAttemptIds(
    db,
    telemetryCutoff,
    RETENTION_POLICY.tier1BatchSize,
    sourceIds,
  );
  if (apply && fetchAttemptIds.length > 0) {
    await db.delete(fetchAttempts).where(inArray(fetchAttempts.id, fetchAttemptIds));
  }

  const incidentIds = await findResolvedIncidentIds(
    db,
    telemetryCutoff,
    RETENTION_POLICY.tier1BatchSize,
    sourceIds,
  );
  if (apply && incidentIds.length > 0) {
    await db.delete(parserIncidents).where(inArray(parserIncidents.id, incidentIds));
  }

  const tier2BatchSize = options.batchSize?.tier2 ?? RETENTION_POLICY.tier2BatchSize;
  const tier3BatchSize = options.batchSize?.tier3 ?? RETENTION_POLICY.tier3BatchSize;

  const tier3 = await runTier3(db, apply, purgeCutoff, sourceIds, tier3BatchSize);
  const tier2 = await runTier2(db, apply, trimCutoff, nowIso, sourceIds, tier2BatchSize);

  const orphanResourceIds = await findOrphanResourceIds(
    db,
    telemetryCutoff,
    RETENTION_POLICY.tier1ResourceBatchSize,
    sourceIds,
  );
  if (apply && orphanResourceIds.length > 0) {
    await db.delete(resources).where(inArray(resources.id, orphanResourceIds));
  }

  return {
    apply,
    tier1: {
      fetchAttemptsDeleted: fetchAttemptIds.length,
      incidentsDeleted: incidentIds.length,
      orphanResourcesDeleted: orphanResourceIds.length,
    },
    tier2,
    tier3,
  };
}

// ---------------------------------------------------------------------------
// Tier 2
// ---------------------------------------------------------------------------

function emptyTier2Result(): Tier2Result {
  return {
    listingsTrimmed: 0,
    revisionsDeleted: 0,
    skippedPinnedByDraft: 0,
    skippedClassificationChain: 0,
    descriptionBytesFreed: 0,
  };
}

/** Whether this page's plans actually have something left to do — see `runTier2`'s own comment on why a candidate page can come up empty. */
function tier2PageHasWork(
  plans: readonly Tier2RevisionPlan[],
  currentRevisionById: ReadonlyMap<string, { trimmedAt: string | null }>,
): boolean {
  return plans.some((plan) => {
    if (plan.deletableRevisionIds.length > 0) return true;
    if (plan.currentRevisionId === null) return false;
    return currentRevisionById.get(plan.currentRevisionId)?.trimmedAt === null;
  });
}

async function runTier2(
  db: Database,
  apply: boolean,
  trimCutoff: string,
  nowIso: string,
  sourceIds: readonly string[],
  batchSize: number,
): Promise<Tier2Result> {
  let afterId: string | undefined;

  for (let page = 0; page < RETENTION_POLICY.tier2MaxPages; page++) {
    const listingIds = await findTier2CandidateListingIds(
      db,
      trimCutoff,
      batchSize,
      sourceIds,
      afterId,
    );
    if (listingIds.length === 0) return emptyTier2Result();

    const plans = await planTier2Revisions(db, listingIds);
    const currentRevisionIds = plans
      .map((plan) => plan.currentRevisionId)
      .filter((id): id is string => id !== null);
    const currentRevisionRows =
      currentRevisionIds.length === 0
        ? []
        : await db
            .select({
              id: sourceListingRevisions.id,
              description: sourceListingRevisions.description,
              trimmedAt: sourceListingRevisions.trimmedAt,
            })
            .from(sourceListingRevisions)
            .where(inArray(sourceListingRevisions.id, currentRevisionIds));
    const currentRevisionById = new Map(currentRevisionRows.map((row) => [row.id, row]));

    // A candidate page can come up with NOTHING left to actually do: every
    // one of its listings' current revisions was already trimmed on an
    // earlier run, and their only non-current revision is permanently
    // pinned (an outreach draft, or a live classification chain) — both of
    // which keep matching `findTier2CandidateListingIds`'s own "trim work
    // outstanding" condition forever, since neither this run nor any future
    // one will ever be ABLE to delete that pinned revision. Re-processing
    // (and re-reporting zero progress on) the same such page every run would
    // never itself be wrong, but paired with keyset pagination it is also
    // never necessary: skip straight to the next page instead.
    if (!tier2PageHasWork(plans, currentRevisionById)) {
      afterId = listingIds[listingIds.length - 1];
      if (listingIds.length < batchSize) return emptyTier2Result(); // fewer than a full page: nothing more exists
      continue;
    }

    const result = emptyTier2Result();
    for (const plan of plans) {
      result.revisionsDeleted += plan.deletableRevisionIds.length;
      result.skippedPinnedByDraft += plan.skippedPinnedByDraft;
      result.skippedClassificationChain += plan.skippedClassificationChain;
    }

    if (!apply) {
      // Dry run: still read-only, but reports a real estimate rather than a guess.
      for (const row of currentRevisionRows) {
        if (row.trimmedAt === null) {
          result.listingsTrimmed += 1;
          result.descriptionBytesFreed += Buffer.byteLength(row.description, 'utf8');
        }
      }
      return result;
    }

    await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      // Locks the batch's own listing rows so a concurrent writer (a fresh
      // fetch reopening one of them) is serialized behind this transaction,
      // not racing it.
      await tx
        .select({ id: sourceListings.id })
        .from(sourceListings)
        .where(inArray(sourceListings.id, listingIds))
        .for('update');

      for (const plan of plans) {
        if (plan.deletableRevisionIds.length > 0) {
          await tx
            .delete(listingClassifications)
            .where(
              inArray(listingClassifications.sourceListingRevisionId, plan.deletableRevisionIds),
            );
          await tx
            .delete(sourceListingRevisions)
            .where(inArray(sourceListingRevisions.id, plan.deletableRevisionIds));
        }

        if (plan.currentRevisionId === null) continue;
        const [current] = await tx
          .select({
            description: sourceListingRevisions.description,
            trimmedAt: sourceListingRevisions.trimmedAt,
          })
          .from(sourceListingRevisions)
          .where(eq(sourceListingRevisions.id, plan.currentRevisionId));
        if (current === undefined || current.trimmedAt !== null) continue;

        result.descriptionBytesFreed += Buffer.byteLength(current.description, 'utf8');
        await tx
          .update(sourceListingRevisions)
          .set({ description: '', trimmedAt: nowIso })
          .where(
            and(
              eq(sourceListingRevisions.id, plan.currentRevisionId),
              isNull(sourceListingRevisions.trimmedAt),
            ),
          );
        result.listingsTrimmed += 1;
      }
    });

    return result;
  }

  // Exhausted the page budget without finding a batch with real work.
  return emptyTier2Result();
}

// ---------------------------------------------------------------------------
// Tier 3
// ---------------------------------------------------------------------------

interface Tier3Closure {
  graph: ClusterGraph;
  closure: ClusterClosureResult;
  /** Every listing individually meeting tier 3's direct candidacy conditions — a superset of `closure.deletableListingIds` (which also requires every ever-opportunity to be deletable). */
  candidateListingIds: ReadonlySet<string>;
}

/** Loads the full cluster graph reachable from `seedListingIds` and closes over it — shared by the initial (unlocked) pass and the re-check done under lock right before deleting. */
async function computeTier3Closure(
  tx: DatabaseOrTransaction,
  seedListingIds: readonly string[],
  purgeCutoff: string,
): Promise<Tier3Closure> {
  const graph = await loadClusterGraph(tx, seedListingIds);
  const allKnownListingIds = [
    ...new Set([...seedListingIds, ...graph.listingOpportunities.keys()]),
  ];
  const candidateListingIds = await filterTier3Candidates(tx, allKnownListingIds, purgeCutoff);
  const closure = closeOverClusters({
    candidateListingIds,
    opportunityMembers: graph.opportunityMembers,
    listingOpportunities: graph.listingOpportunities,
    opportunitiesWithUserData: graph.opportunitiesWithUserData,
  });
  return { graph, closure, candidateListingIds };
}

function emptyTier3Result(): Tier3Result {
  return {
    listingsDeleted: 0,
    opportunitiesDeleted: 0,
    membershipsDeleted: 0,
    duplicateCandidatesDeleted: 0,
    classificationsDeleted: 0,
    revisionsDeleted: 0,
    blockedUserData: 0,
    blockedEntangled: 0,
  };
}

async function runTier3(
  db: Database,
  apply: boolean,
  purgeCutoff: string,
  sourceIds: readonly string[],
  batchSize: number,
): Promise<Tier3Result> {
  // Declared ONCE, outside the loop, and accumulated into across pages —
  // NOT recreated per page. A skipped (no-work) page's blocked diagnostics
  // must survive into whichever later page actually gets processed and
  // returned, or a permanently-blocked prefix would silently vanish from
  // the result the moment pagination looks past it.
  const result = emptyTier3Result();
  let afterId: string | undefined;

  for (let page = 0; page < RETENTION_POLICY.tier3MaxPages; page++) {
    const seedListingIds = await findTier3CandidateListingIds(
      db,
      purgeCutoff,
      batchSize,
      sourceIds,
      afterId,
    );
    if (seedListingIds.length === 0) return result;

    const { graph, closure, candidateListingIds } = await computeTier3Closure(
      db,
      seedListingIds,
      purgeCutoff,
    );

    // Diagnostic breakdown: every candidate that did NOT make it into the
    // deletable set, split by why — an opportunity it belongs to carries user
    // data, or a cluster-mate (live or retired) is not itself a candidate.
    // Computed every page (even one this run skips past below) so a
    // permanently-blocked prefix still shows up in the result rather than
    // silently vanishing.
    for (const listingId of candidateListingIds) {
      if (closure.deletableListingIds.has(listingId)) continue;
      const opportunityIds = graph.listingOpportunities.get(listingId) ?? [];
      if (opportunityIds.some((id) => graph.opportunitiesWithUserData.has(id))) {
        result.blockedUserData += 1;
      } else {
        result.blockedEntangled += 1;
      }
    }

    const deletableListingIds = [...closure.deletableListingIds];
    if (deletableListingIds.length === 0) {
      // Nothing on this page is actually safe to delete — every candidate
      // here is permanently blocked (entangled with a live listing, or its
      // cluster carries user data), and re-selecting the SAME low-id rows
      // next run would starve deletable work sitting behind them (the P1
      // this pagination fixes). Move on rather than stopping here.
      afterId = seedListingIds[seedListingIds.length - 1];
      if (seedListingIds.length < batchSize) return result; // fewer than a full page: nothing more exists
      continue;
    }

    return await finishTier3Page(db, apply, purgeCutoff, closure, deletableListingIds, result);
  }

  // Exhausted the page budget without finding a batch with real work.
  return result;
}

async function finishTier3Page(
  db: Database,
  apply: boolean,
  purgeCutoff: string,
  closure: ClusterClosureResult,
  deletableListingIds: string[],
  result: Tier3Result,
): Promise<Tier3Result> {
  if (!apply) {
    const revisionRows = await db
      .select({ id: sourceListingRevisions.id })
      .from(sourceListingRevisions)
      .where(inArray(sourceListingRevisions.sourceListingId, deletableListingIds));
    const membershipRows = await db
      .select({ id: opportunitySourceMemberships.id })
      .from(opportunitySourceMemberships)
      .where(inArray(opportunitySourceMemberships.sourceListingId, deletableListingIds));
    const duplicateRows = await db
      .select({ id: duplicateCandidates.id })
      .from(duplicateCandidates)
      .where(
        or(
          inArray(duplicateCandidates.sourceListingIdA, deletableListingIds),
          inArray(duplicateCandidates.sourceListingIdB, deletableListingIds),
        ),
      );
    const classificationRows =
      revisionRows.length === 0
        ? []
        : await db
            .select({ id: listingClassifications.id })
            .from(listingClassifications)
            .where(
              inArray(
                listingClassifications.sourceListingRevisionId,
                revisionRows.map((row) => row.id),
              ),
            );

    result.listingsDeleted = deletableListingIds.length;
    result.opportunitiesDeleted = closure.deletableOpportunityIds.size;
    result.revisionsDeleted = revisionRows.length;
    result.membershipsDeleted = membershipRows.length;
    result.duplicateCandidatesDeleted = duplicateRows.length;
    result.classificationsDeleted = classificationRows.length;
    return result;
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);

    await tx
      .select({ id: sourceListings.id })
      .from(sourceListings)
      .where(inArray(sourceListings.id, deletableListingIds))
      .for('update');
    if (closure.deletableOpportunityIds.size > 0) {
      await tx
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(inArray(opportunities.id, [...closure.deletableOpportunityIds]))
        .for('update');
    }

    // Re-derived FRESH under lock, seeded from what the unlocked pass found —
    // not merely re-checked field by field. A fresh `loadClusterGraph` picks
    // up any membership added since (an admin merge is not gated behind any
    // lock this function holds), and re-running `closeOverClusters` against
    // it is simpler and strictly safer than trying to patch the first
    // result: anything that changed shrinks the deletable set rather than
    // being deleted on stale evidence.
    const recheck = await computeTier3Closure(tx, deletableListingIds, purgeCutoff);
    const L = [...recheck.closure.deletableListingIds];
    const O = [...recheck.closure.deletableOpportunityIds];
    if (L.length === 0) return;

    // Step 2: duplicate_candidates referencing either side of $L.
    const deletedDuplicates = await tx
      .delete(duplicateCandidates)
      .where(
        or(
          inArray(duplicateCandidates.sourceListingIdA, L),
          inArray(duplicateCandidates.sourceListingIdB, L),
        ),
      )
      .returning({ id: duplicateCandidates.id });
    result.duplicateCandidatesDeleted = deletedDuplicates.length;

    // Step 3: opportunity_source_memberships for $L — every membership $O
    // ever had, live or retired, since $O was defined as "every member is in
    // $L".
    const deletedMemberships = await tx
      .delete(opportunitySourceMemberships)
      .where(inArray(opportunitySourceMemberships.sourceListingId, L))
      .returning({ id: opportunitySourceMemberships.id });
    result.membershipsDeleted = deletedMemberships.length;

    // Assertion, not a query the caller needs: $O was defined as "every
    // ever-member is in $L", so deleting every $L membership above must have
    // left NONE of $O's memberships behind. If one survives, something about
    // this batch's closure was wrong — fail loudly and roll back rather than
    // delete an opportunity a membership still points at.
    if (O.length > 0) {
      const [leftover] = await tx
        .select({ opportunityId: opportunitySourceMemberships.opportunityId })
        .from(opportunitySourceMemberships)
        .where(inArray(opportunitySourceMemberships.opportunityId, O))
        .limit(1);
      if (leftover !== undefined) {
        throw new Error(
          `runTier3: opportunity ${leftover.opportunityId} still has a membership after deleting ` +
            'every member listing in this batch — refusing to delete it. This means a cluster ' +
            'closure computed a member outside $L; aborting the whole batch rather than risk an ' +
            'orphaned reference.',
        );
      }
    }

    // Step 4 + 5: opportunities and their revisions.
    if (O.length > 0) {
      await tx
        .update(opportunities)
        .set({ currentCanonicalRevisionId: null })
        .where(inArray(opportunities.id, O));
      await tx.delete(opportunityRevisions).where(inArray(opportunityRevisions.opportunityId, O));
      await tx.delete(opportunities).where(inArray(opportunities.id, O));
    }
    result.opportunitiesDeleted = O.length;

    // Step 6: listing_classifications for every revision of $L, one statement
    // (the self-referencing previous_classification_id FK is NO ACTION,
    // checked at statement end — deleting a whole revision's classification
    // history in one DELETE is what keeps that check satisfiable).
    const revisionRows = await tx
      .select({ id: sourceListingRevisions.id })
      .from(sourceListingRevisions)
      .where(inArray(sourceListingRevisions.sourceListingId, L));
    const revisionIds = revisionRows.map((row) => row.id);
    if (revisionIds.length > 0) {
      const deletedClassifications = await tx
        .delete(listingClassifications)
        .where(inArray(listingClassifications.sourceListingRevisionId, revisionIds))
        .returning({ id: listingClassifications.id });
      result.classificationsDeleted = deletedClassifications.length;
    }
    result.revisionsDeleted = revisionIds.length;

    // Step 7: source_listing_revisions and source_listings themselves.
    await tx
      .update(sourceListings)
      .set({ currentRevisionId: null })
      .where(inArray(sourceListings.id, L));
    await tx
      .delete(sourceListingRevisions)
      .where(inArray(sourceListingRevisions.sourceListingId, L));
    await tx.delete(sourceListings).where(inArray(sourceListings.id, L));
    result.listingsDeleted = L.length;
  });

  return result;
}

export type { ClusterClosureResult, ClusterGraph } from './eligibility.js';
export { closeOverClusters } from './eligibility.js';
export { RETENTION_POLICY, cutoffs } from './policy.js';
