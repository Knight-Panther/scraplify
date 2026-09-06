import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  duplicateCandidates,
  opportunities,
  opportunitySourceMemberships,
  sourceListingRevisions,
  sourceListings,
} from '../db/schema/index.js';
import type { Database, DatabaseOrTransaction } from '../db/types.js';
import { normalizeOrganizationName } from '../normalize/organization.js';
import { normalizeApplicationValue } from '../normalize/text.js';
import { resolveCanonicalOpportunity } from './resolve-canonical.js';
import {
  DEDUPE_RULESET_VERSION,
  type ListingForScoring,
  type PairScore,
  scorePair,
} from './score-pair.js';

/**
 * The cross-source deduplication pass (§14): loads the current view of every
 * source listing, generates candidate pairs by blocking, scores them, and
 * persists both the candidates and — for auto-linkable pairs only — the
 * canonical opportunity membership.
 *
 * Two properties matter more than throughput here:
 *
 * 1. **Nothing is ever erased.** §14 opens with "deduplication links records;
 *    it does not erase them." Source listings and revisions are untouched by
 *    this pass; it only ever adds rows to `duplicate_candidates`,
 *    `opportunities` and `opportunity_source_memberships`.
 * 2. **Only `confirmed_same` auto-links.** Everything else is persisted as a
 *    candidate for a human to resolve. §14.2 permits auto-linking only for
 *    high-confidence pairs with multiple independent signals, which
 *    `scorePair` alone decides — this function never second-guesses it
 *    upward.
 */

/**
 * A block larger than this is not evidence, it is a bucket — an employer with
 * hundreds of listings, or a shared applicant-tracking domain. Comparing
 * inside it is quadratic and produces noise rather than duplicates, so the
 * block is skipped and its pairs left ungenerated. Deliberately generous:
 * the largest real organization block in the live corpus is 20.
 */
const MAX_BLOCK_SIZE = 200;

export interface RunDedupeOptions {
  /** Wall clock, injectable for deterministic tests. */
  now?: () => string;
  /** When false (the default), score and persist candidates but create no memberships. */
  autoLink?: boolean;
  /**
   * Restrict the pass to listings from these sources. Omitted means "every
   * source", which is the intended production behaviour — cross-source
   * dedupe is meaningless scoped to one source.
   *
   * This exists because an unscoped pass reads and writes against every
   * listing in the database, which made the first version of the dedupe
   * tests silently create canonical opportunities for real crawled data:
   * the test set up two disposable sources, but the pass scanned the whole
   * corpus alongside them (found 2026-09-06). Scoping is the fix that makes
   * the function testable without a separate database, and it is genuinely
   * useful in production too — re-running dedupe for one newly-added source
   * pair without rescoring the entire corpus.
   */
  sourceIds?: readonly string[];
}

export interface RunDedupeResult {
  listingsConsidered: number;
  pairsCompared: number;
  candidatesWritten: number;
  byDecision: Record<string, number>;
  opportunitiesCreated: number;
  membershipsCreated: number;
  /** Listings that had no duplicate and were canonicalized as single-member opportunities. */
  singletonsCanonicalized: number;
  /** Existing automatic merges whose evidence no longer holds, queued for human review. */
  staleLinksFlagged: number;
}

interface LoadedListing extends ListingForScoring {
  currentRevisionId: string;
  opportunityType: 'job';
  /** §13 lifecycle state of the contributing source listing. */
  status: string;
}

async function loadListings(
  db: DatabaseOrTransaction,
  sourceIds: readonly string[] | undefined,
): Promise<LoadedListing[]> {
  if (sourceIds !== undefined && sourceIds.length === 0) return [];
  const rows = await db
    .select({
      sourceId: sourceListings.sourceId,
      sourceListingId: sourceListings.id,
      currentRevisionId: sourceListingRevisions.id,
      titleRaw: sourceListingRevisions.titleRaw,
      organizationRaw: sourceListingRevisions.organizationRaw,
      applicationMethod: sourceListingRevisions.applicationMethod,
      publishedAt: sourceListings.sourcePublishedAt,
      deadlineAt: sourceListings.sourceDeadlineAt,
      status: sourceListings.status,
    })
    .from(sourceListings)
    .innerJoin(
      sourceListingRevisions,
      eq(sourceListingRevisions.id, sourceListings.currentRevisionId),
    )
    .where(sourceIds === undefined ? undefined : inArray(sourceListings.sourceId, [...sourceIds]));

  return rows.map((row) => {
    const method = (row.applicationMethod ?? null) as { type?: string; value?: string } | null;
    return {
      sourceId: row.sourceId,
      sourceListingId: row.sourceListingId,
      currentRevisionId: row.currentRevisionId,
      titleRaw: row.titleRaw,
      organizationRaw: row.organizationRaw,
      applicationType: method?.type ?? null,
      applicationValue: method?.value ?? null,
      publishedAt: row.publishedAt,
      deadlineAt: row.deadlineAt,
      status: row.status,
      // Every listing both sources currently carry is a job vacancy. The
      // other §12.3 types (scholarship, grant, event) become reachable once
      // classification exists; hardcoding the honest current value beats
      // inventing a type from a title guess.
      opportunityType: 'job' as const,
    };
  });
}

/**
 * Groups listings into comparison blocks (§14.1 stage 3) so the pass never
 * does an all-pairs comparison. Two blocking keys, both index-friendly:
 * a normalized application value, and a normalized organization name.
 *
 * `pg_trgm` is the concept's suggested tool and remains the right one for
 * title-only fuzzy blocking; it is not needed yet, because every duplicate
 * this corpus actually contains shares either a contact value or an employer
 * name, and an exact-key block is both cheaper and easier to reason about.
 */
function buildBlocks(listings: LoadedListing[]): Map<string, LoadedListing[]> {
  const blocks = new Map<string, LoadedListing[]>();
  const add = (key: string | null, listing: LoadedListing): void => {
    if (key === null) return;
    const existing = blocks.get(key);
    if (existing) existing.push(listing);
    else blocks.set(key, [listing]);
  };

  for (const listing of listings) {
    add(normalizeApplicationValue(listing.applicationType, listing.applicationValue), listing);
    const organization = normalizeOrganizationName(listing.organizationRaw);
    add(organization === null ? null : `org:${organization}`, listing);
  }
  return blocks;
}

/** Distinct listings carrying each normalized application value — the selectivity signal. */
function countApplicationValues(listings: LoadedListing[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const listing of listings) {
    const value = normalizeApplicationValue(listing.applicationType, listing.applicationValue);
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/**
 * Links two listings into one canonical opportunity, reusing whichever
 * opportunity either side already belongs to.
 *
 * Reuse rather than always-create is what makes clustering transitive: when
 * A~B and B~C are confirmed in separate pairs, C must join A and B's existing
 * opportunity instead of starting a third one. When the two sides already
 * belong to DIFFERENT opportunities this function deliberately does nothing
 * and reports it — merging two established clusters is a destructive,
 * hard-to-reverse operation that §14.2's "false merges are more damaging"
 * rule says a human should authorize, not a batch job.
 */
async function linkPair(
  tx: DatabaseOrTransaction,
  a: LoadedListing,
  b: LoadedListing,
  score: PairScore,
  now: string,
): Promise<{ createdOpportunity: boolean; createdMemberships: number; conflict: boolean }> {
  const liveMembership = async (sourceListingId: string) => {
    const [row] = await tx
      .select({ opportunityId: opportunitySourceMemberships.opportunityId })
      .from(opportunitySourceMemberships)
      .where(
        and(
          eq(opportunitySourceMemberships.sourceListingId, sourceListingId),
          isNull(opportunitySourceMemberships.supersededAt),
        ),
      );
    return row?.opportunityId ?? null;
  };

  const existingA = await liveMembership(a.sourceListingId);
  const existingB = await liveMembership(b.sourceListingId);

  if (existingA !== null && existingB !== null) {
    if (existingA === existingB) {
      // Already together — but their SOURCE revisions may have moved on since
      // the canonical revision was computed. §12.4 requires a canonical
      // revision to be recomputed when a contributing source revision changes;
      // returning early without checking leaves the resolved fields and
      // sourceMembershipVersions describing content neither source shows any
      // more (adversarial review, 2026-09-06).
      await resolveCanonicalOpportunity(tx, existingA, now);
    }
    // Two separate clusters are deliberately left alone: joining established
    // clusters is destructive and §14.2 says a human authorizes it.
    return {
      createdOpportunity: false,
      createdMemberships: 0,
      conflict: existingA !== existingB,
    };
  }

  let opportunityId = existingA ?? existingB;
  let createdOpportunity = false;

  if (opportunityId === null) {
    // A SHELL only — no revision. The canonical revision is built at the end,
    // by the one resolver, from the memberships that actually exist by then.
    //
    // This path used to build its own revision inline from the scored pair,
    // which reproduced the resolver's logic badly: it hardcoded
    // `canonicalStatus: 'active'` regardless of what the two listings' real
    // statuses were, omitted the `status` field from `resolvedFields`, and
    // wrote a placeholder string where the content hash belongs. The same
    // duplicated-logic mistake resolve-canonical.ts was extracted to end.
    opportunityId = randomUUID();
    await tx.insert(opportunities).values({
      id: opportunityId,
      type: a.opportunityType,
      canonicalTitle: a.titleRaw,
      organizationId: null,
      canonicalStatus: 'active',
      currentCanonicalRevisionId: null,
      createdAt: now,
      updatedAt: now,
    });
    createdOpportunity = true;
  }

  let createdMemberships = 0;
  for (const listing of [a, b]) {
    const already = await liveMembership(listing.sourceListingId);
    if (already !== null) continue;
    await tx.insert(opportunitySourceMemberships).values({
      id: randomUUID(),
      opportunityId,
      sourceListingId: listing.sourceListingId,
      decision: score.decision,
      confidence: score.confidence,
      evidence: { signals: score.signals, reasons: score.reasons },
      decidedBy: 'ruleset',
      decidedAt: now,
      dedupeModelOrRulesetVersion: score.rulesetVersion,
      supersededAt: null,
    });
    createdMemberships++;
  }

  // The canonical revision is built HERE, from the memberships that now
  // exist, for both the new-opportunity and the join-an-existing-cluster
  // case.
  //
  // A later loop in runDedupe re-resolves every clustered listing anyway, so
  // this is not today the only thing standing between a grown cluster and a
  // stale revision — but linkPair must leave consistent state on its own
  // rather than depend on a distant caller running afterwards, and it is what
  // lets this function stop hand-building a revision (and hand-writing a
  // placeholder hash) altogether.
  await resolveCanonicalOpportunity(tx, opportunityId, now);

  return { createdOpportunity, createdMemberships, conflict: false };
}

export async function runDedupe(
  db: Database,
  options: RunDedupeOptions = {},
): Promise<RunDedupeResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const autoLink = options.autoLink ?? false;

  const listings = await loadListings(db, options.sourceIds);
  // Selectivity is measured over the WHOLE corpus, never over the scoped
  // subset (adversarial review, 2026-09-06). Counting only scoped listings
  // would let a generic careers inbox or ATS landing page — one carried by
  // forty listings across the corpus — appear to be carried by two, clear the
  // vacancy-level threshold, and satisfy the single automatic merge path.
  // That is precisely the false merge §14.2 forbids, and scoping a run to one
  // source pair is exactly when it would happen. Candidate GENERATION stays
  // scoped; only the counts are global.
  const corpusForCounts =
    options.sourceIds === undefined ? listings : await loadListings(db, undefined);
  const context = { applicationValueListingCounts: countApplicationValues(corpusForCounts) };
  const blocks = buildBlocks(listings);

  const seenPairs = new Set<string>();
  const scored: Array<{ a: LoadedListing; b: LoadedListing; score: PairScore }> = [];
  /** Pairs now scoring 'distinct' — only acted on if they are currently linked. */
  const contradictedPairs: Array<{ a: LoadedListing; b: LoadedListing; score: PairScore }> = [];
  let pairsCompared = 0;

  for (const group of blocks.values()) {
    if (group.length < 2 || group.length > MAX_BLOCK_SIZE) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const first = group[i];
        const second = group[j];
        if (first === undefined || second === undefined) continue;
        // Order the pair by id so a pair reachable through two different
        // blocks is compared once, and so the stored row matches the
        // duplicate_candidates unique constraint's (a < b) expectation.
        const [a, b] =
          first.sourceListingId < second.sourceListingId ? [first, second] : [second, first];
        const key = `${a.sourceListingId}|${b.sourceListingId}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        pairsCompared++;
        const score = scorePair(a, b, context);
        // A pair that now scores 'distinct' is still kept when the two are
        // currently linked: their existing automatic membership was built on
        // evidence that no longer holds, and dropping the pair here would
        // leave that stale merge in place forever with no path to revisit it
        // (adversarial review, 2026-09-06). Everything else that scores
        // 'distinct' is genuinely uninteresting and discarded.
        if (score.decision !== 'distinct') scored.push({ a, b, score });
        else contradictedPairs.push({ a, b, score });
      }
    }
  }

  const byDecision: Record<string, number> = {};
  let candidatesWritten = 0;
  let opportunitiesCreated = 0;
  let membershipsCreated = 0;

  const timestamp = now();
  for (const { a, b, score } of scored) {
    byDecision[score.decision] = (byDecision[score.decision] ?? 0) + 1;

    await db.transaction(async (tx) => {
      await tx
        .insert(duplicateCandidates)
        .values({
          id: randomUUID(),
          sourceListingIdA: a.sourceListingId,
          sourceListingIdB: b.sourceListingId,
          generatedAt: timestamp,
          generationMethod: 'deterministic_match',
          similarityScore: score.signals.titleSimilarity,
          status: 'evaluated',
          resultingDecision: score.decision,
          decidedBy: 'ruleset',
        })
        .onConflictDoUpdate({
          target: [duplicateCandidates.sourceListingIdA, duplicateCandidates.sourceListingIdB],
          set: {
            generatedAt: timestamp,
            similarityScore: score.signals.titleSimilarity,
            status: 'evaluated',
            resultingDecision: score.decision,
            decidedBy: 'ruleset',
          },
          // A human's verdict outranks the ruleset's. Without this guard the
          // pass overwrites an operator's `distinct` with its own
          // `needs_review`, putting a settled pair straight back in the queue
          // and losing the correction (adversarial review, 2026-09-06).
          setWhere: sql`${duplicateCandidates.decidedBy} is distinct from 'human'`,
        });
      candidatesWritten++;

      // A human's verdict outranks the ruleset's, and guarding only the
      // candidate upsert was not enough: this branch still linked purely off
      // the fresh score, so an --auto-link run could recreate exactly the
      // merge a reviewer had reversed (adversarial review, 2026-09-06). The
      // persisted human decision is consulted before any linking happens.
      const [persisted] = await tx
        .select({
          decidedBy: duplicateCandidates.decidedBy,
          decision: duplicateCandidates.resultingDecision,
        })
        .from(duplicateCandidates)
        .where(
          and(
            eq(duplicateCandidates.sourceListingIdA, a.sourceListingId),
            eq(duplicateCandidates.sourceListingIdB, b.sourceListingId),
          ),
        );
      const humanSaidNotSame =
        persisted?.decidedBy === 'human' && persisted.decision !== 'confirmed_same';

      if (autoLink && score.decision === 'confirmed_same' && !humanSaidNotSame) {
        const linked = await linkPair(tx, a, b, score, timestamp);
        if (linked.createdOpportunity) opportunitiesCreated++;
        membershipsCreated += linked.createdMemberships;
      }
    });
  }

  // Revisit automatic merges whose evidence has since evaporated. A pair
  // linked on a shared ATS link that a later revision changed still scores
  // 'confirmed_same' nowhere, yet its membership persists — so the merge
  // outlives its own justification and nothing ever queues it for a second
  // look (adversarial review, 2026-09-06).
  //
  // The correction is to FLAG, not to unmerge: automatically tearing apart an
  // existing cluster is itself destructive, and §14.2 puts that call with a
  // human. The pair is written back as `needs_review` so it surfaces in the
  // queue, and a human then detaches or keeps it via membership-review.ts.
  // Every persisted AUTOMATIC merge is re-scored here, not just the pairs the
  // current blocking happened to regenerate. Blocking keys on the shared
  // application value or organization — the very evidence a merge rests on —
  // so a pair whose ATS link later changed leaves every block and would never
  // be re-examined by a block-driven check. The merge would then outlive its
  // justification permanently and invisibly (adversarial review, 2026-09-06).
  //
  // This also catches a downgrade to `probable_same`, which is equally
  // unqualified to hold an automatic link: anything that no longer scores
  // `confirmed_same` is queued.
  const clusteredListings = new Map<string, LoadedListing>();
  for (const listing of listings) clusteredListings.set(listing.sourceListingId, listing);

  const automaticClusters = await db
    .select({
      opportunityId: opportunitySourceMemberships.opportunityId,
      sourceListingId: opportunitySourceMemberships.sourceListingId,
      decidedBy: opportunitySourceMemberships.decidedBy,
    })
    .from(opportunitySourceMemberships)
    .where(isNull(opportunitySourceMemberships.supersededAt));

  const membersByOpportunity = new Map<string, Array<{ listingId: string; decidedBy: string }>>();
  for (const row of automaticClusters) {
    if (!clusteredListings.has(row.sourceListingId)) continue;
    const existing = membersByOpportunity.get(row.opportunityId);
    const entry = { listingId: row.sourceListingId, decidedBy: row.decidedBy };
    if (existing) existing.push(entry);
    else membersByOpportunity.set(row.opportunityId, [entry]);
  }

  for (const [, members] of membersByOpportunity) {
    // Single-member clusters assert nothing about another listing.
    if (members.length < 2) continue;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const first = members[i];
        const second = members[j];
        if (first === undefined || second === undefined) continue;
        // A human's merge outranks the ruleset (§14.2) and is never second-guessed.
        if (first.decidedBy === 'human' || second.decidedBy === 'human') continue;
        const a = clusteredListings.get(first.listingId);
        const b = clusteredListings.get(second.listingId);
        if (a === undefined || b === undefined) continue;
        const [low, high] = a.sourceListingId < b.sourceListingId ? [a, b] : [b, a];
        const key = `${low.sourceListingId}|${high.sourceListingId}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const rescored = scorePair(low, high, context);
        if (rescored.decision !== 'confirmed_same') {
          contradictedPairs.push({ a: low, b: high, score: rescored });
        }
      }
    }
  }

  let staleLinksFlagged = 0;
  for (const { a, b, score } of contradictedPairs) {
    const [liveA] = await db
      .select({ opportunityId: opportunitySourceMemberships.opportunityId })
      .from(opportunitySourceMemberships)
      .where(
        and(
          eq(opportunitySourceMemberships.sourceListingId, a.sourceListingId),
          isNull(opportunitySourceMemberships.supersededAt),
        ),
      );
    if (liveA === undefined) continue;
    const [liveB] = await db
      .select({ opportunityId: opportunitySourceMemberships.opportunityId })
      .from(opportunitySourceMemberships)
      .where(
        and(
          eq(opportunitySourceMemberships.sourceListingId, b.sourceListingId),
          isNull(opportunitySourceMemberships.supersededAt),
        ),
      );
    if (liveB === undefined || liveA.opportunityId !== liveB.opportunityId) continue;

    // Only automatic merges are second-guessed. A human who deliberately put
    // these together outranks the ruleset (§14.2).
    const [membership] = await db
      .select({ decidedBy: opportunitySourceMemberships.decidedBy })
      .from(opportunitySourceMemberships)
      .where(
        and(
          eq(opportunitySourceMemberships.sourceListingId, a.sourceListingId),
          isNull(opportunitySourceMemberships.supersededAt),
        ),
      );
    if (membership?.decidedBy === 'human') continue;

    await db
      .insert(duplicateCandidates)
      .values({
        id: randomUUID(),
        sourceListingIdA: a.sourceListingId,
        sourceListingIdB: b.sourceListingId,
        generatedAt: timestamp,
        generationMethod: 'deterministic_match',
        similarityScore: score.signals.titleSimilarity,
        status: 'evaluated',
        resultingDecision: 'needs_review',
        decidedBy: 'ruleset',
      })
      .onConflictDoUpdate({
        target: [duplicateCandidates.sourceListingIdA, duplicateCandidates.sourceListingIdB],
        set: {
          generatedAt: timestamp,
          similarityScore: score.signals.titleSimilarity,
          status: 'evaluated',
          resultingDecision: 'needs_review',
          decidedBy: 'ruleset',
        },
        setWhere: sql`${duplicateCandidates.decidedBy} is distinct from 'human'`,
      });
    staleLinksFlagged++;
    byDecision.stale_link_flagged = (byDecision.stale_link_flagged ?? 0) + 1;
  }

  // Canonicalize the leftovers. Without this step only DUPLICATED listings
  // ever become opportunities, and the canonical layer would hold just the
  // handful of cross-posted vacancies while every unique job — 406 of the
  // corpus's 410 listings — existed nowhere above the raw source tables.
  // Anything reading the canonical layer (browsing, and §17's ranking, which
  // enumerates opportunities) would then show a user four jobs instead of four
  // hundred. Found 2026-09-06 by ranking the real corpus and getting 4 results.
  //
  // A single-member opportunity is not a merge and carries none of a merge's
  // risk: there is no second listing to be wrong about, so this cannot produce
  // a false merge however it behaves.
  let singletonsCanonicalized = 0;
  if (autoLink) {
    for (const listing of listings) {
      const existing = await db
        .select({ opportunityId: opportunitySourceMemberships.opportunityId })
        .from(opportunitySourceMemberships)
        .where(
          and(
            eq(opportunitySourceMemberships.sourceListingId, listing.sourceListingId),
            isNull(opportunitySourceMemberships.supersededAt),
          ),
        );
      const existingMembership = existing[0];
      if (existingMembership !== undefined) {
        // Already clustered — but its source revision may have moved on since
        // the canonical revision was built. Skipping outright pinned every
        // singleton to whatever it looked like on the FIRST dedupe run, so a
        // later title change never reached browsing or ranking (adversarial
        // review, 2026-09-06).
        await db.transaction(async (tx) => {
          await resolveCanonicalOpportunity(tx, existingMembership.opportunityId, timestamp);
        });
        continue;
      }

      await db.transaction(async (tx) => {
        const opportunityId = randomUUID();
        // The row is created as a shell and the membership attached; the
        // canonical revision and the status are then derived by the resolver.
        //
        // This path previously built its own revision and hardcoded
        // `canonicalStatus: 'active'`, so a closed, expired or quarantined
        // listing became a live-looking opportunity that browsing and ranking
        // would happily recommend (adversarial review, 2026-09-06). Building
        // canonical state in a second place was the mistake — the resolver
        // exists precisely so there is one.
        await tx.insert(opportunities).values({
          id: opportunityId,
          type: listing.opportunityType,
          canonicalTitle: listing.titleRaw,
          organizationId: null,
          // Provisional; resolveCanonicalOpportunity overwrites it below from
          // the member's real §13 state before this transaction commits.
          canonicalStatus: 'discovered',
          currentCanonicalRevisionId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        });

        await tx.insert(opportunitySourceMemberships).values({
          id: randomUUID(),
          opportunityId,
          sourceListingId: listing.sourceListingId,
          // Its relationship to its own single-member cluster is trivially
          // identity — this is not a claim about any other listing.
          decision: 'confirmed_same',
          confidence: 1,
          evidence: {
            reasons: ['no duplicate found; canonicalized as a single-member opportunity'],
          },
          decidedBy: 'ruleset',
          decidedAt: timestamp,
          dedupeModelOrRulesetVersion: DEDUPE_RULESET_VERSION,
          supersededAt: null,
        });

        await resolveCanonicalOpportunity(tx, opportunityId, timestamp);
      });
      singletonsCanonicalized++;
      opportunitiesCreated++;
      membershipsCreated++;
    }
  }

  return {
    listingsConsidered: listings.length,
    pairsCompared,
    candidatesWritten,
    byDecision,
    opportunitiesCreated,
    membershipsCreated,
    singletonsCanonicalized,
    staleLinksFlagged,
  };
}

/** Count of pairs awaiting human resolution — the review queue's depth. */
export async function countPendingReview(db: DatabaseOrTransaction): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(duplicateCandidates)
    .where(eq(duplicateCandidates.resultingDecision, 'needs_review'));
  return row?.count ?? 0;
}
