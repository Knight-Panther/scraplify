import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  duplicateCandidates,
  opportunities,
  opportunityRevisions,
  opportunitySourceMemberships,
  sourceListingRevisions,
  sourceListings,
} from '../db/schema/index.js';
import type { Database, DatabaseOrTransaction } from '../db/types.js';
import { normalizeOrganizationName } from '../normalize/organization.js';
import { normalizeApplicationValue } from '../normalize/text.js';
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
}

interface LoadedListing extends ListingForScoring {
  currentRevisionId: string;
  opportunityType: 'job';
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
    // Already together, or two separate clusters that only a human may join.
    return {
      createdOpportunity: false,
      createdMemberships: 0,
      conflict: existingA !== existingB,
    };
  }

  let opportunityId = existingA ?? existingB;
  let createdOpportunity = false;

  if (opportunityId === null) {
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

    const revisionId = randomUUID();
    await tx.insert(opportunityRevisions).values({
      id: revisionId,
      opportunityId,
      canonicalTitle: a.titleRaw,
      canonicalStatus: 'active',
      organizationId: null,
      // §14.2: surface disagreements rather than silently choosing. Each
      // field records what every contributing source said, so a later
      // resolution ruleset can choose without having lost the alternatives.
      resolvedFields: {
        title: [
          { sourceListingId: a.sourceListingId, value: a.titleRaw },
          { sourceListingId: b.sourceListingId, value: b.titleRaw },
        ],
        organization: [
          { sourceListingId: a.sourceListingId, value: a.organizationRaw },
          { sourceListingId: b.sourceListingId, value: b.organizationRaw },
        ],
      },
      sourceMembershipVersions: {
        [a.sourceListingId]: a.currentRevisionId,
        [b.sourceListingId]: b.currentRevisionId,
      },
      resolutionRulesetVersion: DEDUPE_RULESET_VERSION,
      meaningfulContentHash: 'sha256:pending-resolution',
      createdAt: now,
    });

    await tx
      .update(opportunities)
      .set({ currentCanonicalRevisionId: revisionId, updatedAt: now })
      .where(eq(opportunities.id, opportunityId));
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

  return { createdOpportunity, createdMemberships, conflict: false };
}

export async function runDedupe(
  db: Database,
  options: RunDedupeOptions = {},
): Promise<RunDedupeResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const autoLink = options.autoLink ?? false;

  const listings = await loadListings(db, options.sourceIds);
  const context = { applicationValueListingCounts: countApplicationValues(listings) };
  const blocks = buildBlocks(listings);

  const seenPairs = new Set<string>();
  const scored: Array<{ a: LoadedListing; b: LoadedListing; score: PairScore }> = [];
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
        if (score.decision !== 'distinct') scored.push({ a, b, score });
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
        })
        .onConflictDoUpdate({
          target: [duplicateCandidates.sourceListingIdA, duplicateCandidates.sourceListingIdB],
          set: {
            generatedAt: timestamp,
            similarityScore: score.signals.titleSimilarity,
            status: 'evaluated',
            resultingDecision: score.decision,
          },
        });
      candidatesWritten++;

      if (autoLink && score.decision === 'confirmed_same') {
        const linked = await linkPair(tx, a, b, score, timestamp);
        if (linked.createdOpportunity) opportunitiesCreated++;
        membershipsCreated += linked.createdMemberships;
      }
    });
  }

  return {
    listingsConsidered: listings.length,
    pairsCompared,
    candidatesWritten,
    byDecision,
    opportunitiesCreated,
    membershipsCreated,
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
