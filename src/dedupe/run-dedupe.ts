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
import type { OpportunityType } from '../domain/opportunity.js';
import { normalizeOrganizationName } from '../normalize/organization.js';
import { normalizeApplicationValue } from '../normalize/text.js';
import { reassignListingWithin } from './membership-review.js';
import { resolveCanonicalOpportunity } from './resolve-canonical.js';
import {
  DEDUPE_RULESET_VERSION,
  type ListingForScoring,
  type PairScore,
  type ScoringContext,
  type SignalBreakdown,
  scorePair,
} from './score-pair.js';
import { scoreTenderPair, type TenderSignalBreakdown } from './score-tender-pair.js';
import { buyerHeadWord, normalizeBuyerName } from './tender-buyer.js';
import { descriptionAnnouncesTenderSql, opportunityTypeForListing } from './tender-post.js';

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

/**
 * The cap for a tender buyer block, which only ever yields CROSS-source pairs.
 * One buyer's etenders.ge history grows without end (Telasi posted 41 tenders
 * in 60 days), and the vacancy cap would silently drop a big buyer's block,
 * and with it every board post about that buyer's tenders. Skipping
 * same-source pairs keeps the work at "that buyer's tenders times its board
 * posts", so the cap only guards against a runaway key.
 */
const MAX_TENDER_BLOCK_SIZE = 5_000;
const TENDER_BLOCK_PREFIX = 'tender-buyer:';

/** Either scorer's result: vacancies and tenders carry different signals. */
type AnyPairScore = PairScore<SignalBreakdown | TenderSignalBreakdown>;

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
  opportunityType: OpportunityType;
  /** §13 lifecycle state of the contributing source listing. */
  status: string;
}

/** The verdict for a tender paired with a vacancy: never the same opportunity. */
function typeMismatchScore(
  a: LoadedListing,
  b: LoadedListing,
  context: ScoringContext,
): AnyPairScore {
  return {
    ...scorePair(a, b, context),
    decision: 'distinct',
    confidence: 0,
    reasons: ['one listing is a tender and the other a vacancy'],
  };
}

/** The scorer for a pair of one type: tenders and vacancies are evidenced differently. */
function scoreSameTypePair(
  a: LoadedListing,
  b: LoadedListing,
  context: ScoringContext,
): AnyPairScore {
  return a.opportunityType === 'tender' ? scoreTenderPair(a, b) : scorePair(a, b, context);
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
      descriptionAnnouncesTender: descriptionAnnouncesTenderSql(sourceListingRevisions.description),
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
      // Every etenders.ge listing is a tender; a job-board listing is a
      // tender when it is a buyer's tender post (tender-post.ts, Phase 9B).
      opportunityType: opportunityTypeForListing({
        sourceId: row.sourceId,
        title: row.titleRaw,
        descriptionAnnouncesTender: row.descriptionAnnouncesTender,
      }),
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
    if (listing.opportunityType === 'tender') {
      // Tenders also block by buyer (docs/addEtender.md §14.6): the full buyer
      // key, and its first identifying word, so `ს.ს. ლომისი` meets
      // `ლომისი - ლუდსახარში ნატახტარი`. The scorer decides whether the
      // buyers really match.
      const buyer = normalizeBuyerName(listing.organizationRaw);
      if (buyer !== null) {
        add(`${TENDER_BLOCK_PREFIX}${buyer}`, listing);
        const head = buyerHeadWord(buyer);
        if (head !== null && head !== buyer) add(`${TENDER_BLOCK_PREFIX}head:${head}`, listing);
      }
    }
  }
  return blocks;
}

/**
 * Downgrades every automatic merge that would make one listing the duplicate
 * of TWO listings on the same other source. Within a source every listing is a
 * separate posting (§12.1), so at most one of them can be the right partner,
 * and choosing between them is a human's call. Without this, transitivity
 * would do the choosing: a board post matching two of one buyer's etenders.ge
 * tenders would pull both tenders into one opportunity.
 */
function holdAmbiguousMerges(
  scored: Array<{ a: LoadedListing; b: LoadedListing; score: AnyPairScore }>,
): void {
  const partners = new Map<string, number>();
  const count = (listing: LoadedListing, other: LoadedListing): void => {
    const key = `${listing.sourceListingId}|${other.sourceId}`;
    partners.set(key, (partners.get(key) ?? 0) + 1);
  };
  for (const { a, b, score } of scored) {
    if (score.decision !== 'confirmed_same') continue;
    count(a, b);
    count(b, a);
  }
  for (const entry of scored) {
    if (entry.score.decision !== 'confirmed_same') continue;
    const ambiguousA = (partners.get(`${entry.a.sourceListingId}|${entry.b.sourceId}`) ?? 0) > 1;
    const ambiguousB = (partners.get(`${entry.b.sourceListingId}|${entry.a.sourceId}`) ?? 0) > 1;
    if (!ambiguousA && !ambiguousB) continue;
    entry.score = {
      ...entry.score,
      decision: 'needs_review',
      confidence: 0.6,
      reasons: [
        ...entry.score.reasons,
        'one side also matches another listing on the same source; a human picks the right one',
      ],
    };
  }
}

/**
 * Merges two TENDER opportunities that each hold one listing, put there by
 * the ruleset, when their listings now score as one tender. Returns false,
 * changing nothing, for anything else.
 *
 * linkPair otherwise never joins two existing clusters, because undoing a
 * merge someone or something decided is a human's call (§14.2). A pair of
 * single-listing opportunities holds no such decision: each is just a listing
 * canonicalized alone, and merging them is the same act as linking two fresh
 * listings. Tenders need it because their rules arrived after the listings
 * did. Every job-board tender post from before Phase 9B already sits in its
 * own opportunity, so without this the hr.ge and jobs.ge copies of one tender
 * would stay apart for good. A human-made single-listing opportunity (a
 * reviewer's split) is never folded.
 *
 * The listing moves through the reviewer's own reassign path, so the emptied
 * opportunity's saved or dismissed decision follows it. The older opportunity
 * survives, keeping the id that has been public longest.
 */
async function foldTenderSingleton(
  tx: DatabaseOrTransaction,
  opportunityA: string,
  opportunityB: string,
  score: AnyPairScore,
  now: string,
): Promise<boolean> {
  const members = await tx
    .select({
      opportunityId: opportunitySourceMemberships.opportunityId,
      sourceListingId: opportunitySourceMemberships.sourceListingId,
      decidedBy: opportunitySourceMemberships.decidedBy,
      createdAt: opportunities.createdAt,
    })
    .from(opportunitySourceMemberships)
    .innerJoin(opportunities, eq(opportunities.id, opportunitySourceMemberships.opportunityId))
    .where(
      and(
        inArray(opportunitySourceMemberships.opportunityId, [opportunityA, opportunityB]),
        isNull(opportunitySourceMemberships.supersededAt),
      ),
    );
  const memberA = members.filter((member) => member.opportunityId === opportunityA);
  const memberB = members.filter((member) => member.opportunityId === opportunityB);
  const [onlyA] = memberA;
  const [onlyB] = memberB;
  if (memberA.length !== 1 || memberB.length !== 1 || onlyA === undefined || onlyB === undefined) {
    return false;
  }
  if (onlyA.decidedBy !== 'ruleset' || onlyB.decidedBy !== 'ruleset') return false;

  const [survivor, mover] = onlyA.createdAt <= onlyB.createdAt ? [onlyA, onlyB] : [onlyB, onlyA];
  // Brings the survivor's type up to date first: an opportunity made before
  // its listing was recognized as a tender still reads 'job', and the move
  // refuses to put a tender into a vacancy.
  await resolveCanonicalOpportunity(tx, survivor.opportunityId, now);
  await reassignListingWithin(tx, {
    sourceListingId: mover.sourceListingId,
    toOpportunityId: survivor.opportunityId,
    decision: score.decision,
    confidence: score.confidence,
    evidence: { signals: score.signals, reasons: score.reasons },
    actor: { decidedBy: 'ruleset', version: score.rulesetVersion },
    at: now,
  });
  return true;
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
  score: AnyPairScore,
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
    } else if (
      a.opportunityType === 'tender' &&
      (await foldTenderSingleton(tx, existingA, existingB, score, now))
    ) {
      return { createdOpportunity: false, createdMemberships: 1, conflict: false };
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

  if (opportunityId !== null) {
    // Joining an existing cluster: never as a second listing from a source the
    // cluster already holds. Two postings on one source are two postings
    // (§12.1), so a cluster holding both would be a false merge however the
    // pair scored — reachable for tenders, whose merges rest on dates and
    // titles rather than on a link only two listings can share.
    const joining = existingA === null ? a : b;
    const [sameSourceMember] = await tx
      .select({ id: opportunitySourceMemberships.id })
      .from(opportunitySourceMemberships)
      .innerJoin(
        sourceListings,
        eq(sourceListings.id, opportunitySourceMemberships.sourceListingId),
      )
      .where(
        and(
          eq(opportunitySourceMemberships.opportunityId, opportunityId),
          isNull(opportunitySourceMemberships.supersededAt),
          eq(sourceListings.sourceId, joining.sourceId),
        ),
      )
      .limit(1);
    if (sameSourceMember !== undefined) {
      return { createdOpportunity: false, createdMemberships: 0, conflict: true };
    }
  }

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
  const scored: Array<{ a: LoadedListing; b: LoadedListing; score: AnyPairScore }> = [];
  /** Pairs now scoring 'distinct' — only acted on if they are currently linked. */
  const contradictedPairs: Array<{ a: LoadedListing; b: LoadedListing; score: AnyPairScore }> = [];
  let pairsCompared = 0;

  for (const [blockKey, group] of blocks) {
    const tenderBlock = blockKey.startsWith(TENDER_BLOCK_PREFIX);
    const maxSize = tenderBlock ? MAX_TENDER_BLOCK_SIZE : MAX_BLOCK_SIZE;
    if (group.length < 2 || group.length > maxSize) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const first = group[i];
        const second = group[j];
        if (first === undefined || second === undefined) continue;
        // A buyer block can hold hundreds of one buyer's own tenders; only
        // its cross-source pairs can be duplicates (see MAX_TENDER_BLOCK_SIZE).
        if (tenderBlock && first.sourceId === second.sourceId) continue;
        // Order the pair by id so a pair reachable through two different
        // blocks is compared once, and so the stored row matches the
        // duplicate_candidates unique constraint's (a < b) expectation.
        const [a, b] =
          first.sourceListingId < second.sourceListingId ? [first, second] : [second, first];
        const key = `${a.sourceListingId}|${b.sourceListingId}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        // A tender and a vacancy are never the same opportunity, however
        // alike the buyer and title read. Kept as a contradiction, like a
        // 'distinct' score, so a link made before one side was reclassified
        // (a vacancy merge whose listing turned out to be a tender post) is
        // queued for review instead of standing unexamined.
        if (a.opportunityType !== b.opportunityType) {
          contradictedPairs.push({ a, b, score: typeMismatchScore(a, b, context) });
          continue;
        }
        pairsCompared++;
        const score = scoreSameTypePair(a, b, context);
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
  holdAmbiguousMerges(scored);

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
          // Written at BOTH sites — values and the conflict update — because
          // every candidate row already existed before this column did, so an
          // insert-only write would have left the whole backlog empty and the
          // review screen with nothing to show for exactly the pairs it exists
          // to judge.
          evidence: { reasons: score.reasons, signals: score.signals },
        })
        .onConflictDoUpdate({
          target: [duplicateCandidates.sourceListingIdA, duplicateCandidates.sourceListingIdB],
          set: {
            generatedAt: timestamp,
            similarityScore: score.signals.titleSimilarity,
            status: 'evaluated',
            resultingDecision: score.decision,
            decidedBy: 'ruleset',
            evidence: { reasons: score.reasons, signals: score.signals },
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
        const rescored =
          low.opportunityType === high.opportunityType
            ? scoreSameTypePair(low, high, context)
            : typeMismatchScore(low, high, context);
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
        // A different KIND of reason from site 1, and the distinction matters
        // to a reviewer: this pair is queued because a link that already
        // exists no longer scores as one, not because fresh evidence proposed
        // it. The scorer's signals are carried too, since they are what
        // changed.
        evidence: {
          reasons: ['existing link no longer supported by the current ruleset', ...score.reasons],
          signals: score.signals,
        },
      })
      .onConflictDoUpdate({
        target: [duplicateCandidates.sourceListingIdA, duplicateCandidates.sourceListingIdB],
        set: {
          generatedAt: timestamp,
          similarityScore: score.signals.titleSimilarity,
          status: 'evaluated',
          resultingDecision: 'needs_review',
          decidedBy: 'ruleset',
          evidence: {
            reasons: ['existing link no longer supported by the current ruleset', ...score.reasons],
            signals: score.signals,
          },
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
