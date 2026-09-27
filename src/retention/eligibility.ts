import { and, eq, gt, inArray, lt, sql, type SQL } from 'drizzle-orm';
import {
  crawlRuns,
  duplicateCandidates,
  fetchAttempts,
  listingClassifications,
  opportunityDecisions,
  opportunitySourceMemberships,
  organizationAliases,
  outreachDrafts,
  parserIncidents,
  rankings,
  resourceLinks,
  resources,
  sourceListingRevisions,
  sourceListings,
} from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';

/**
 * Query builders and the pure cluster-closure function behind `runRetention`
 * (Phase 7C, docs/PHASE_7C_PLAN.md's Retention section, the owner-approved
 * retention plan). Every function here only READS or computes — the actual
 * DELETE/UPDATE statements live in run-retention.ts, which is what makes the
 * closure function (`closeOverClusters`) unit-testable with no database at
 * all.
 *
 * Style follows src/browse/queries.ts: raw `sql` fragments for EXISTS
 * subqueries, composed with the drizzle query builder's `and`/`inArray` for
 * everything that has a typed column to hang off.
 */

/** §13's lifecycle states a listing must be in for either dead-data tier to consider it. */
const DEAD_STATUSES = ['closed', 'expired'] as const;

/**
 * `dead_since` (the retention plan's own term, §1): when a closed/expired
 * listing actually stopped being live, not merely when it was last touched.
 *
 * `closed`: set at the reconciliation pass that closed it
 * (reconcile-source-listings.ts's closeMissingListingsInTransaction sets
 * `last_reconciled_at = run.startedAt` on the same UPDATE that sets
 * `status = 'closed'`), so `greatest(last_seen_at, last_reconciled_at)` is
 * the later of "last genuinely seen" and "closed as of this run".
 * `expired`: expireOverdueListings only ever sets `status`, never touches
 * `last_reconciled_at`, so the deadline itself
 * (`greatest(last_seen_at, source_deadline_at)`) is the only signal —
 * `source_deadline_at` is usually the later of the two, but `greatest`
 * covers a listing whose deadline passed before it was last crawled.
 *
 * `greatest()` ignores NULLs (Postgres semantics: NULL only if every
 * argument is NULL), so a `last_reconciled_at`/`source_deadline_at` that
 * happens to be null falls back to `last_seen_at` rather than making the
 * whole expression NULL and never-matching.
 */
function deadSinceBefore(cutoff: string): SQL {
  return sql`(case ${sourceListings.status}
    when 'closed' then greatest(${sourceListings.lastSeenAt}, ${sourceListings.lastReconciledAt})
    when 'expired' then greatest(${sourceListings.lastSeenAt}, ${sourceListings.sourceDeadlineAt})
  end) < ${cutoff}`;
}

// ---------------------------------------------------------------------------
// Tier 1: telemetry (fetch_attempts, resolved parser_incidents, orphan resources)
// ---------------------------------------------------------------------------

/** Aged `fetch_attempts` ids, scoped to `sourceIds` through their crawl run when given. */
export async function findAgedFetchAttemptIds(
  tx: DatabaseOrTransaction,
  cutoff: string,
  limit: number,
  sourceIds?: readonly string[],
): Promise<string[]> {
  const conditions: SQL[] = [lt(fetchAttempts.attemptedAt, cutoff)];
  if (sourceIds !== undefined) {
    const runs = await tx
      .select({ id: crawlRuns.id })
      .from(crawlRuns)
      .where(inArray(crawlRuns.sourceId, [...sourceIds]));
    if (runs.length === 0) return [];
    conditions.push(
      inArray(
        fetchAttempts.crawlRunId,
        runs.map((run) => run.id),
      ),
    );
  }
  const rows = await tx
    .select({ id: fetchAttempts.id })
    .from(fetchAttempts)
    .where(and(...conditions))
    .orderBy(fetchAttempts.id)
    .limit(limit);
  return rows.map((row) => row.id);
}

/** Resolved `parser_incidents` ids older than the telemetry cutoff. */
export async function findResolvedIncidentIds(
  tx: DatabaseOrTransaction,
  cutoff: string,
  limit: number,
  sourceIds?: readonly string[],
): Promise<string[]> {
  const conditions: SQL[] = [
    eq(parserIncidents.resolved, true),
    lt(parserIncidents.resolvedAt, cutoff),
  ];
  if (sourceIds !== undefined) conditions.push(inArray(parserIncidents.sourceId, [...sourceIds]));
  const rows = await tx
    .select({ id: parserIncidents.id })
    .from(parserIncidents)
    .where(and(...conditions))
    .orderBy(parserIncidents.id)
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * `resources` with no `fetch_attempts` row, no `source_listing_revisions`
 * provenance pointer, and no `resource_links` on either side — nothing left
 * that traces back to this resource — fetched (or never fetched) before the
 * telemetry cutoff. Run LAST in a retention pass: tier 2/3 deleting old
 * revisions is exactly what can turn a still-referenced resource into an
 * orphan.
 */
export async function findOrphanResourceIds(
  tx: DatabaseOrTransaction,
  cutoff: string,
  limit: number,
  sourceIds?: readonly string[],
): Promise<string[]> {
  const conditions: SQL[] = [
    sql`coalesce(${resources.fetchedAt}, '-infinity') < ${cutoff}`,
    sql`not exists (select 1 from ${fetchAttempts} fa where fa.resource_id = ${resources.id})`,
    sql`not exists (
      select 1 from ${sourceListingRevisions} slr where slr.provenance_resource_id = ${resources.id}
    )`,
    sql`not exists (
      select 1 from ${resourceLinks} rl
      where rl.parent_resource_id = ${resources.id} or rl.child_resource_id = ${resources.id}
    )`,
  ];
  if (sourceIds !== undefined) conditions.push(inArray(resources.sourceId, [...sourceIds]));
  const rows = await tx
    .select({ id: resources.id })
    .from(resources)
    .where(and(...conditions))
    .orderBy(resources.id)
    .limit(limit);
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Tier 2: trim (60 days dead — keep the listing and its current revision, blank the description)
// ---------------------------------------------------------------------------

/**
 * Listings with trim work still outstanding: closed/expired, dead more than
 * `trimCutoff`, and either the current revision has never been trimmed or a
 * non-current revision still exists to clean up. Excludes any listing whose
 * live opportunity carries `opportunity_decisions` or `outreach_drafts` —
 * user-facing state that must never have its evidence quietly emptied.
 *
 * `afterId` keyset-paginates (`id > afterId`, same stable `orderBy(id)`
 * every page uses) — `run-retention.ts`'s tier 2 loop uses it to skip past a
 * page whose candidates turn out to have no actual work left (their only
 * outstanding revision is permanently pinned, so they keep matching this
 * query forever without anything changing), rather than re-selecting the
 * same low-id rows every run and starving real work sitting behind them
 * (a P1 finding in adversarial review, 2026-09-28).
 */
export async function findTier2CandidateListingIds(
  tx: DatabaseOrTransaction,
  trimCutoff: string,
  limit: number,
  sourceIds?: readonly string[],
  afterId?: string,
): Promise<string[]> {
  const conditions: SQL[] = [
    inArray(sourceListings.status, [...DEAD_STATUSES]),
    deadSinceBefore(trimCutoff),
    lt(sourceListings.lastSeenAt, trimCutoff),
  ];
  if (sourceIds !== undefined) conditions.push(inArray(sourceListings.sourceId, [...sourceIds]));
  if (afterId !== undefined) conditions.push(gt(sourceListings.id, afterId));

  conditions.push(sql`(
    exists (
      select 1 from ${sourceListingRevisions} cur
      where cur.id = ${sourceListings.currentRevisionId} and cur.trimmed_at is null
    )
    or exists (
      select 1 from ${sourceListingRevisions} other
      where other.source_listing_id = ${sourceListings.id}
        and other.id <> ${sourceListings.currentRevisionId}
    )
  )`);

  conditions.push(sql`not exists (
    select 1 from ${opportunitySourceMemberships} m
    where m.source_listing_id = ${sourceListings.id}
      and m.superseded_at is null
      and (
        exists (select 1 from ${opportunityDecisions} d where d.opportunity_id = m.opportunity_id)
        or exists (select 1 from ${outreachDrafts} od where od.opportunity_id = m.opportunity_id)
      )
  )`);

  const rows = await tx
    .select({ id: sourceListings.id })
    .from(sourceListings)
    .where(and(...conditions))
    .orderBy(sourceListings.id)
    .limit(limit);
  return rows.map((row) => row.id);
}

export interface Tier2RevisionPlan {
  listingId: string;
  currentRevisionId: string | null;
  /** Non-current revisions safe to delete this pass. */
  deletableRevisionIds: string[];
  /** Non-current revisions left alone because an outreach draft pins them. */
  skippedPinnedByDraft: number;
  /**
   * Non-current revisions left alone because a LIVE classification's
   * `previous_classification_id` points at one of this revision's own
   * classification rows — deleting it would break that self-referencing
   * chain (`listing_classifications`'s own FK, checked at statement end).
   */
  skippedClassificationChain: number;
}

/**
 * For each listing, which of its non-current revisions are safe to delete
 * right now (plan §4's `$R`), and how many were skipped and why. Pure
 * read — the caller does the actual deletes and the description trim.
 */
export async function planTier2Revisions(
  tx: DatabaseOrTransaction,
  listingIds: readonly string[],
): Promise<Tier2RevisionPlan[]> {
  if (listingIds.length === 0) return [];
  const ids = [...listingIds];

  const listingRows = await tx
    .select({ id: sourceListings.id, currentRevisionId: sourceListings.currentRevisionId })
    .from(sourceListings)
    .where(inArray(sourceListings.id, ids));

  const revisionRows = await tx
    .select({
      id: sourceListingRevisions.id,
      sourceListingId: sourceListingRevisions.sourceListingId,
    })
    .from(sourceListingRevisions)
    .where(inArray(sourceListingRevisions.sourceListingId, ids));
  const revisionIds = revisionRows.map((row) => row.id);

  const draftPinnedRows =
    revisionIds.length === 0
      ? []
      : await tx
          .select({ id: outreachDrafts.sourceListingRevisionId })
          .from(outreachDrafts)
          .where(inArray(outreachDrafts.sourceListingRevisionId, revisionIds));
  const draftPinned = new Set(draftPinnedRows.map((row) => row.id));

  const classificationRows =
    revisionIds.length === 0
      ? []
      : await tx
          .select({
            id: listingClassifications.id,
            sourceListingRevisionId: listingClassifications.sourceListingRevisionId,
            supersededAt: listingClassifications.supersededAt,
            previousClassificationId: listingClassifications.previousClassificationId,
          })
          .from(listingClassifications)
          .where(inArray(listingClassifications.sourceListingRevisionId, revisionIds));

  const referencedByLiveChain = new Set(
    classificationRows
      .filter((row) => row.supersededAt === null && row.previousClassificationId !== null)
      .map((row) => row.previousClassificationId as string),
  );
  const classificationIdsByRevision = new Map<string, string[]>();
  for (const row of classificationRows) {
    const list = classificationIdsByRevision.get(row.sourceListingRevisionId) ?? [];
    list.push(row.id);
    classificationIdsByRevision.set(row.sourceListingRevisionId, list);
  }

  const revisionIdsByListing = new Map<string, string[]>();
  for (const row of revisionRows) {
    const list = revisionIdsByListing.get(row.sourceListingId) ?? [];
    list.push(row.id);
    revisionIdsByListing.set(row.sourceListingId, list);
  }

  return listingRows.map((listing): Tier2RevisionPlan => {
    const deletableRevisionIds: string[] = [];
    let skippedPinnedByDraft = 0;
    let skippedClassificationChain = 0;
    for (const revisionId of revisionIdsByListing.get(listing.id) ?? []) {
      if (revisionId === listing.currentRevisionId) continue;
      if (draftPinned.has(revisionId)) {
        skippedPinnedByDraft += 1;
        continue;
      }
      const ownClassificationIds = classificationIdsByRevision.get(revisionId) ?? [];
      if (ownClassificationIds.some((id) => referencedByLiveChain.has(id))) {
        skippedClassificationChain += 1;
        continue;
      }
      deletableRevisionIds.push(revisionId);
    }
    return {
      listingId: listing.id,
      currentRevisionId: listing.currentRevisionId,
      deletableRevisionIds,
      skippedPinnedByDraft,
      skippedClassificationChain,
    };
  });
}

// ---------------------------------------------------------------------------
// Tier 3: purge (180 days dead — whole clusters only)
// ---------------------------------------------------------------------------

/** The direct, per-listing half of "listing candidate" (plan §3) — everything that does NOT require looking at its cluster. */
function tier3CandidateConditions(purgeCutoff: string, sourceIds?: readonly string[]): SQL[] {
  const conditions: SQL[] = [
    inArray(sourceListings.status, [...DEAD_STATUSES]),
    deadSinceBefore(purgeCutoff),
  ];
  if (sourceIds !== undefined) conditions.push(inArray(sourceListings.sourceId, [...sourceIds]));

  conditions.push(
    sql`not exists (select 1 from ${outreachDrafts} od where od.source_listing_id = ${sourceListings.id})`,
  );
  conditions.push(
    sql`not exists (select 1 from ${organizationAliases} oa where oa.source_listing_id = ${sourceListings.id})`,
  );
  conditions.push(sql`not exists (
    select 1 from ${opportunitySourceMemberships} m
    where m.source_listing_id = ${sourceListings.id} and m.decided_by = 'human'
  )`);
  conditions.push(sql`not exists (
    select 1 from ${duplicateCandidates} dc
    where (dc.source_listing_id_a = ${sourceListings.id} or dc.source_listing_id_b = ${sourceListings.id})
      and dc.decided_by = 'human'
  )`);
  conditions.push(sql`not exists (
    select 1 from ${listingClassifications} lc
    inner join ${sourceListingRevisions} slr on slr.id = lc.source_listing_revision_id
    where slr.source_listing_id = ${sourceListings.id} and lc.method = 'human_review'
  )`);
  return conditions;
}

/**
 * A batch of listings meeting tier 3's direct, per-listing candidacy
 * conditions.
 *
 * `afterId` keyset-paginates the same way `findTier2CandidateListingIds`
 * does, for the same reason: this query has no way to know a candidate is
 * part of an entangled or user-data-blocked cluster (that needs the full
 * graph, loaded downstream), so without pagination a wall of permanently
 * blocked low-id rows would be re-selected every run and starve deletable
 * work sitting behind them (a P1 finding in adversarial review, 2026-09-28).
 */
export async function findTier3CandidateListingIds(
  tx: DatabaseOrTransaction,
  purgeCutoff: string,
  limit: number,
  sourceIds?: readonly string[],
  afterId?: string,
): Promise<string[]> {
  const conditions = tier3CandidateConditions(purgeCutoff, sourceIds);
  if (afterId !== undefined) conditions.push(gt(sourceListings.id, afterId));
  const rows = await tx
    .select({ id: sourceListings.id })
    .from(sourceListings)
    .where(and(...conditions))
    .orderBy(sourceListings.id)
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Re-evaluates tier 3's direct conditions for a SPECIFIC set of listing ids —
 * used both to check the extra listings a cluster pulls in beyond the
 * original batch, and to re-verify a batch's own listings under lock right
 * before deleting them.
 */
export async function filterTier3Candidates(
  tx: DatabaseOrTransaction,
  listingIds: readonly string[],
  purgeCutoff: string,
): Promise<Set<string>> {
  if (listingIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: sourceListings.id })
    .from(sourceListings)
    .where(
      and(inArray(sourceListings.id, [...listingIds]), ...tier3CandidateConditions(purgeCutoff)),
    )
    .orderBy(sourceListings.id);
  return new Set(rows.map((row) => row.id));
}

export interface ClusterGraph {
  /** opportunityId -> every listingId EVER a member (live or retired). */
  opportunityMembers: Map<string, string[]>;
  /** The inverse of opportunityMembers. */
  listingOpportunities: Map<string, string[]>;
  /** Opportunities that must never be deleted: a decision, a ranking, or an outreach draft references them. */
  opportunitiesWithUserData: Set<string>;
}

/** Safety valve only — real clusters are a handful of hops at most; this guards against an infinite loop if that assumption is ever wrong. */
const MAX_GRAPH_EXPANSION_ROUNDS = 50;

/**
 * Loads the FULL connected component of `opportunity_source_memberships`
 * reachable from `seedListingIds` — every opportunity any of them was ever a
 * member of, every listing THOSE opportunities ever held, and so on outward
 * until nothing new appears.
 *
 * A single-hop expansion is not enough: a listing can carry membership
 * history through several reassignments (§12.5's append-only trail), so an
 * opportunity's "every member is a candidate" question can only be answered
 * once the WHOLE component the seed batch touches is loaded, not just its
 * immediate neighbors. This is what makes `closeOverClusters` below a single
 * deterministic pass over already-complete data rather than needing its own
 * iteration.
 */
export async function loadClusterGraph(
  tx: DatabaseOrTransaction,
  seedListingIds: readonly string[],
): Promise<ClusterGraph> {
  const knownListingIds = new Set(seedListingIds);
  const knownOpportunityIds = new Set<string>();
  let listingFrontier = new Set(seedListingIds);
  let opportunityFrontier = new Set<string>();
  const membershipRows: Array<{ opportunityId: string; sourceListingId: string }> = [];

  let rounds = 0;
  while (listingFrontier.size > 0 || opportunityFrontier.size > 0) {
    rounds += 1;
    if (rounds > MAX_GRAPH_EXPANSION_ROUNDS) {
      throw new Error(
        `loadClusterGraph: cluster expansion did not converge after ${MAX_GRAPH_EXPANSION_ROUNDS} rounds ` +
          `starting from ${seedListingIds.length} listing(s) — refusing to loop forever.`,
      );
    }

    if (listingFrontier.size > 0) {
      const rows = await tx
        .select({
          opportunityId: opportunitySourceMemberships.opportunityId,
          sourceListingId: opportunitySourceMemberships.sourceListingId,
        })
        .from(opportunitySourceMemberships)
        .where(inArray(opportunitySourceMemberships.sourceListingId, [...listingFrontier]));
      membershipRows.push(...rows);
      const nextOpportunityFrontier = new Set<string>();
      for (const row of rows) {
        if (!knownOpportunityIds.has(row.opportunityId)) {
          knownOpportunityIds.add(row.opportunityId);
          nextOpportunityFrontier.add(row.opportunityId);
        }
      }
      listingFrontier = new Set();
      opportunityFrontier = new Set([...opportunityFrontier, ...nextOpportunityFrontier]);
    }

    if (opportunityFrontier.size > 0) {
      const rows = await tx
        .select({
          opportunityId: opportunitySourceMemberships.opportunityId,
          sourceListingId: opportunitySourceMemberships.sourceListingId,
        })
        .from(opportunitySourceMemberships)
        .where(inArray(opportunitySourceMemberships.opportunityId, [...opportunityFrontier]));
      membershipRows.push(...rows);
      const nextListingFrontier = new Set<string>();
      for (const row of rows) {
        if (!knownListingIds.has(row.sourceListingId)) {
          knownListingIds.add(row.sourceListingId);
          nextListingFrontier.add(row.sourceListingId);
        }
      }
      opportunityFrontier = new Set();
      listingFrontier = nextListingFrontier;
    }
  }

  const opportunityMembers = new Map<string, string[]>();
  const listingOpportunities = new Map<string, string[]>();
  // De-duplicated: the two-directional expansion above can re-fetch the same
  // membership row from both sides (a listing frontier round and an
  // opportunity frontier round each returning the same pair).
  const seenPairs = new Set<string>();
  for (const row of membershipRows) {
    const key = `${row.opportunityId}\u0000${row.sourceListingId}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    const members = opportunityMembers.get(row.opportunityId) ?? [];
    members.push(row.sourceListingId);
    opportunityMembers.set(row.opportunityId, members);
    const opportunitiesForListing = listingOpportunities.get(row.sourceListingId) ?? [];
    opportunitiesForListing.push(row.opportunityId);
    listingOpportunities.set(row.sourceListingId, opportunitiesForListing);
  }

  const opportunityIds = [...knownOpportunityIds];
  const opportunitiesWithUserData = new Set<string>();
  if (opportunityIds.length > 0) {
    // Sequential, not `Promise.all` — `tx` may be a single transaction
    // connection (node-postgres serializes queries per connection; issuing
    // several at once against the SAME one is deprecated and, worse, not
    // actually concurrent).
    const decisionRows = await tx
      .select({ opportunityId: opportunityDecisions.opportunityId })
      .from(opportunityDecisions)
      .where(inArray(opportunityDecisions.opportunityId, opportunityIds));
    const rankingRows = await tx
      .select({ opportunityId: rankings.opportunityId })
      .from(rankings)
      .where(inArray(rankings.opportunityId, opportunityIds));
    const draftRows = await tx
      .select({ opportunityId: outreachDrafts.opportunityId })
      .from(outreachDrafts)
      .where(inArray(outreachDrafts.opportunityId, opportunityIds));
    for (const row of decisionRows) opportunitiesWithUserData.add(row.opportunityId);
    for (const row of rankingRows) opportunitiesWithUserData.add(row.opportunityId);
    for (const row of draftRows) opportunitiesWithUserData.add(row.opportunityId);
  }

  return { opportunityMembers, listingOpportunities, opportunitiesWithUserData };
}

export interface ClusterClosureInput {
  /** Every listing in the loaded graph that independently meets tier 3's direct candidacy conditions. */
  candidateListingIds: ReadonlySet<string>;
  opportunityMembers: ReadonlyMap<string, readonly string[]>;
  listingOpportunities: ReadonlyMap<string, readonly string[]>;
  opportunitiesWithUserData: ReadonlySet<string>;
}

export interface ClusterClosureResult {
  deletableOpportunityIds: ReadonlySet<string>;
  deletableListingIds: ReadonlySet<string>;
}

/**
 * Safety valve for the fixpoint loop below. Each round can only ever shrink
 * `deletableListingIds` (see the function's own comment on why), so the
 * loop must stabilize in at most this many rounds — one per candidate,
 * worst case (every round drops exactly one). Real clusters converge in one
 * or two rounds; this bound exists only to fail loudly if that invariant is
 * ever violated by a future change, not because it is expected to bind.
 */
const MAX_CLOSURE_ROUNDS = 10_000;

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * The pure decision at the heart of tier 3 (plan §3): given a FULLY LOADED
 * cluster graph (see `loadClusterGraph`'s own comment on why it must be
 * complete first), which opportunities and listings are actually safe to
 * delete.
 *
 * **This is a genuine mutual fixpoint, not a two-step lookup** — a P1 found
 * in adversarial review (2026-09-28) in an earlier version of this function,
 * which tested an opportunity's members against `candidateListingIds` (a
 * per-listing BASE fact) rather than against `deletableListingIds` (the
 * thing actually being computed). That version let a listing kept for one
 * reason (e.g. entangled with a non-candidate listing through one
 * opportunity) leave ANOTHER of its own ever-opportunities marked deletable,
 * because every one of THAT opportunity's members individually looked like a
 * candidate — even though the KEPT listing's live membership row in it would
 * never actually be deleted (`run-retention.ts` only ever deletes
 * memberships by listing id, for listings in the final deletable set). The
 * opportunity would then be deleted out from under a membership row that
 * still points at it, tripping the leftover-membership assertion in
 * `runTier3` and rolling back the whole batch, every run, forever.
 *
 * The fix: iterate. Start by ASSUMING every candidate is deletable (the
 * largest the answer could possibly be), then repeatedly recompute which
 * opportunities have every member in the CURRENT guess at
 * `deletableListingIds`, and which candidates have every ever-opportunity in
 * the current guess at `deletableOpportunityIds`, until neither changes.
 * Each round can only shrink `deletableListingIds` (never grow it back): a
 * smaller `deletableListingIds` makes "every member is deletable" strictly
 * harder to satisfy, which can only shrink `deletableOpportunityIds`, which
 * in turn can only shrink the next round's `deletableListingIds` — a
 * monotonically decreasing sequence over a finite set, so it must stabilize.
 * A single "poisoned" listing (blocked by user data, a human decision, or
 * simply not itself a candidate) therefore correctly propagates outward
 * through every opportunity and listing that shares ANY membership history
 * with it, keeping the whole connected component rather than only the one
 * listing that first failed.
 */
export function closeOverClusters(input: ClusterClosureInput): ClusterClosureResult {
  let deletableListingIds: ReadonlySet<string> = input.candidateListingIds;

  for (let round = 0; round < MAX_CLOSURE_ROUNDS; round++) {
    const deletableOpportunityIds = new Set<string>();
    for (const [opportunityId, members] of input.opportunityMembers) {
      if (input.opportunitiesWithUserData.has(opportunityId)) continue;
      if (members.length === 0) continue; // Should not happen — a membership row is how the opportunity got in this map at all.
      if (members.every((listingId) => deletableListingIds.has(listingId))) {
        deletableOpportunityIds.add(opportunityId);
      }
    }

    const nextDeletableListingIds = new Set<string>();
    for (const listingId of input.candidateListingIds) {
      const opportunityIds = input.listingOpportunities.get(listingId) ?? [];
      if (opportunityIds.every((opportunityId) => deletableOpportunityIds.has(opportunityId))) {
        nextDeletableListingIds.add(listingId);
      }
    }

    if (setsEqual(nextDeletableListingIds, deletableListingIds)) {
      return { deletableOpportunityIds, deletableListingIds: nextDeletableListingIds };
    }
    deletableListingIds = nextDeletableListingIds;
  }

  throw new Error(
    `closeOverClusters: did not converge after ${MAX_CLOSURE_ROUNDS} rounds over ` +
      `${input.candidateListingIds.size} candidate(s) — the monotonic-shrink invariant this loop ` +
      'relies on must have been violated by a change to this function.',
  );
}
