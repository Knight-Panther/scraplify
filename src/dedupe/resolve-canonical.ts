import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  opportunities,
  opportunityRevisions,
  opportunitySourceMemberships,
  sourceListingRevisions,
  sourceListings,
} from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';

/**
 * Recomputes one opportunity's canonical state from whatever its LIVE members
 * currently say, and appends a new revision when that differs from the stored
 * one (§12.4: recompute "when source membership, a contributing source
 * revision, or the resolution ruleset changes meaningfully").
 *
 * This exists as a single function called from every mutation point rather
 * than as logic repeated at each one, because the first attempt did the latter
 * and went stale in four separate ways at once (adversarial review,
 * 2026-09-06): singleton opportunities never refreshed at all, a refresh
 * updated the revision pointer but left `opportunities.canonicalTitle` on its
 * original value, membership corrections rebuilt nothing, and a refresh
 * triggered by one scored pair rewrote the revision using only those two
 * members while silently dropping every other live member of the cluster.
 * Every one of those is the same underlying mistake — deriving canonical state
 * from the caller's local view instead of from the cluster's actual membership
 * — so the fix is to have exactly one place that reads the membership itself.
 *
 * Callers pass only an opportunity id. That is deliberate: accepting a member
 * list would reintroduce the bug, since the caller's list is precisely what
 * was wrong before.
 */

/** Bumped when the resolution rules below change (§12.4's resolutionRulesetVersion). */
export const CANONICAL_RESOLUTION_VERSION = 'v1';

/**
 * §13 lifecycle, resolved across members. An opportunity is as available as
 * its most available source: if any board still lists it as active, a
 * candidate can still apply, so the canonical view must not present it as
 * closed. Conversely a cluster whose every member is closed or expired must
 * NOT read `active` — that would recommend a dead vacancy, which is the
 * user-visible failure this ordering exists to prevent.
 */
const STATUS_PRECEDENCE = [
  'active',
  'missing_suspected',
  'discovered',
  'expired',
  'closed',
  'quarantined',
] as const;

function resolveStatus(memberStatuses: readonly string[]): (typeof STATUS_PRECEDENCE)[number] {
  for (const candidate of STATUS_PRECEDENCE) {
    if (memberStatuses.includes(candidate)) return candidate;
  }
  // No live members at all — an opportunity emptied by a review correction.
  // 'closed' rather than 'active': nothing supports it any more.
  return 'closed';
}

export interface ResolveCanonicalResult {
  /** True when a new canonical revision was appended. */
  refreshed: boolean;
  revisionId: string | null;
  liveMemberCount: number;
}

export async function resolveCanonicalOpportunity(
  tx: DatabaseOrTransaction,
  opportunityId: string,
  now: string,
): Promise<ResolveCanonicalResult> {
  const [opportunity] = await tx
    .select({
      id: opportunities.id,
      currentRevisionId: opportunities.currentCanonicalRevisionId,
    })
    .from(opportunities)
    .where(eq(opportunities.id, opportunityId));
  if (opportunity === undefined) {
    return { refreshed: false, revisionId: null, liveMemberCount: 0 };
  }

  // The cluster's ACTUAL live membership — read here, never supplied.
  const members = await tx
    .select({
      sourceListingId: sourceListings.id,
      revisionId: sourceListingRevisions.id,
      title: sourceListingRevisions.titleRaw,
      organization: sourceListingRevisions.organizationRaw,
      status: sourceListings.status,
    })
    .from(opportunitySourceMemberships)
    .innerJoin(sourceListings, eq(sourceListings.id, opportunitySourceMemberships.sourceListingId))
    .innerJoin(
      sourceListingRevisions,
      eq(sourceListingRevisions.id, sourceListings.currentRevisionId),
    )
    .where(
      and(
        eq(opportunitySourceMemberships.opportunityId, opportunityId),
        isNull(opportunitySourceMemberships.supersededAt),
      ),
    )
    .orderBy(sourceListings.id);

  const expectedVersions: Record<string, string> = {};
  for (const member of members) expectedVersions[member.sourceListingId] = member.revisionId;

  const canonicalStatus = resolveStatus(members.map((member) => member.status));
  // The first member by a stable ordering, so the chosen title does not flip
  // between runs for reasons unrelated to the data.
  const canonicalTitle = members[0]?.title ?? null;

  if (opportunity.currentRevisionId !== null) {
    const [current] = await tx
      .select({
        versions: opportunityRevisions.sourceMembershipVersions,
        title: opportunityRevisions.canonicalTitle,
        status: opportunityRevisions.canonicalStatus,
      })
      .from(opportunityRevisions)
      .where(eq(opportunityRevisions.id, opportunity.currentRevisionId));
    const stored = (current?.versions ?? {}) as Record<string, string>;
    const sameMembership =
      Object.keys(stored).length === Object.keys(expectedVersions).length &&
      Object.entries(expectedVersions).every(
        ([listingId, revisionId]) => stored[listingId] === revisionId,
      );
    if (
      sameMembership &&
      current?.status === canonicalStatus &&
      current?.title === canonicalTitle
    ) {
      return {
        refreshed: false,
        revisionId: opportunity.currentRevisionId,
        liveMemberCount: members.length,
      };
    }
  }

  // An opportunity with no live members keeps its last revision as the record
  // of what it was; there is nothing to resolve from, and inventing an empty
  // revision would assert content no source supports.
  if (members.length === 0) {
    await tx
      .update(opportunities)
      .set({ canonicalStatus, updatedAt: now })
      .where(eq(opportunities.id, opportunityId));
    return {
      refreshed: false,
      revisionId: opportunity.currentRevisionId,
      liveMemberCount: 0,
    };
  }

  const revisionId = randomUUID();
  await tx.insert(opportunityRevisions).values({
    id: revisionId,
    opportunityId,
    canonicalTitle: canonicalTitle ?? '',
    canonicalStatus,
    organizationId: null,
    // §14.2: surface disagreements rather than silently choosing one value.
    // Every member's value is kept alongside the others.
    resolvedFields: {
      title: members.map((member) => ({
        sourceListingId: member.sourceListingId,
        value: member.title,
      })),
      organization: members.map((member) => ({
        sourceListingId: member.sourceListingId,
        value: member.organization,
      })),
      status: members.map((member) => ({
        sourceListingId: member.sourceListingId,
        value: member.status,
      })),
    },
    sourceMembershipVersions: expectedVersions,
    resolutionRulesetVersion: CANONICAL_RESOLUTION_VERSION,
    meaningfulContentHash: 'sha256:pending-resolution',
    createdAt: now,
  });

  // The denormalized columns are updated TOGETHER with the pointer. Browsing
  // and ranking read the title and status straight off `opportunities`, so
  // repointing alone would leave a newer revision behind a stale title —
  // the change would be recorded and invisible at the same time.
  await tx
    .update(opportunities)
    .set({
      currentCanonicalRevisionId: revisionId,
      canonicalTitle: canonicalTitle ?? '',
      canonicalStatus,
      updatedAt: now,
    })
    .where(eq(opportunities.id, opportunityId));

  return { refreshed: true, revisionId, liveMemberCount: members.length };
}
