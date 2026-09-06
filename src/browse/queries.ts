import { and, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  crawlRuns,
  duplicateCandidates,
  opportunities,
  opportunitySourceMemberships,
  parserIncidents,
  sourceListingRevisions,
  sourceListings,
  sources,
} from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';

/**
 * Read-only queries backing Phase 3's exit gate: "the stored corpus can be
 * inspected and corrected without direct database access."
 *
 * Deliberately headless. The gate is about the corpus being *reachable*
 * without psql, not about HTML existing — so the query layer is built and
 * tested on its own first, and a UI later consumes it rather than embedding
 * its own SQL. That also means the CV ranking work in §17 has a supported way
 * to enumerate opportunities without reaching into tables directly.
 *
 * Everything here reads. Corrections go through the dedicated operations in
 * src/dedupe/membership-review.ts, which carry the audit trail §12.5 requires;
 * mixing a mutation into a browse query would route a cluster change around
 * that record.
 */

/** A source listing with the fields a human needs to judge it. */
export interface ListingView {
  sourceListingId: string;
  sourceSlug: string;
  status: string;
  title: string;
  organization: string | null;
  canonicalUrl: string;
  publishedAt: string | null;
  deadlineAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  applicationMethod: unknown;
}

export interface SearchListingsFilters {
  /** Case-insensitive substring over title and organization. */
  text?: string | undefined;
  sourceSlug?: string | undefined;
  /** §13 lifecycle states; omitted means every state. */
  statuses?: readonly string[] | undefined;
  /** Deadline on or after this instant — "still open as of". */
  deadlineFrom?: string | undefined;
  /** Deadline on or before this instant — powers the "closing soon" view. */
  deadlineTo?: string | undefined;
  /** First seen on or after this instant — powers the "new" view. */
  firstSeenFrom?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/**
 * Searches source listings — the raw per-source observations, not canonical
 * opportunities. Both views matter: a human checking whether a crawl is
 * healthy wants to see exactly what a source said, undeduplicated.
 */
export async function searchListings(
  db: DatabaseOrTransaction,
  filters: SearchListingsFilters = {},
): Promise<ListingView[]> {
  const conditions = [];
  if (filters.text !== undefined && filters.text.trim().length > 0) {
    const pattern = `%${filters.text.trim()}%`;
    conditions.push(
      or(
        ilike(sourceListingRevisions.titleRaw, pattern),
        ilike(sourceListingRevisions.organizationRaw, pattern),
      ),
    );
  }
  if (filters.sourceSlug !== undefined) conditions.push(eq(sources.slug, filters.sourceSlug));
  if (filters.statuses !== undefined && filters.statuses.length > 0) {
    conditions.push(
      inArray(
        sourceListings.status,
        filters.statuses as unknown as typeof sourceListings.status.enumValues,
      ),
    );
  }
  if (filters.deadlineFrom !== undefined)
    conditions.push(gte(sourceListings.sourceDeadlineAt, filters.deadlineFrom));
  if (filters.deadlineTo !== undefined)
    conditions.push(lte(sourceListings.sourceDeadlineAt, filters.deadlineTo));
  if (filters.firstSeenFrom !== undefined)
    conditions.push(gte(sourceListings.firstSeenAt, filters.firstSeenFrom));

  const rows = await db
    .select({
      sourceListingId: sourceListings.id,
      sourceSlug: sources.slug,
      status: sourceListings.status,
      title: sourceListingRevisions.titleRaw,
      organization: sourceListingRevisions.organizationRaw,
      canonicalUrl: sourceListings.canonicalSourceUrl,
      publishedAt: sourceListings.sourcePublishedAt,
      deadlineAt: sourceListings.sourceDeadlineAt,
      firstSeenAt: sourceListings.firstSeenAt,
      lastSeenAt: sourceListings.lastSeenAt,
      applicationMethod: sourceListingRevisions.applicationMethod,
    })
    .from(sourceListings)
    .innerJoin(sources, eq(sources.id, sourceListings.sourceId))
    .innerJoin(
      sourceListingRevisions,
      eq(sourceListingRevisions.id, sourceListings.currentRevisionId),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(sourceListings.firstSeenAt))
    .limit(clampLimit(filters.limit))
    .offset(filters.offset ?? 0);

  return rows;
}

export interface OpportunityView {
  opportunityId: string;
  canonicalTitle: string;
  canonicalStatus: string;
  type: string;
  /** Every source listing currently clustered into this opportunity. */
  members: ListingView[];
}

/**
 * Canonical opportunities with their contributing source listings — the
 * deduplicated view a user should actually browse.
 *
 * Only LIVE memberships are followed (`supersededAt is null`), so a listing
 * detached by review disappears from its old cluster immediately while its
 * retired membership row survives for audit.
 */
export async function searchOpportunities(
  db: DatabaseOrTransaction,
  filters: {
    text?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  } = {},
): Promise<OpportunityView[]> {
  const conditions = [];
  if (filters.text !== undefined && filters.text.trim().length > 0) {
    conditions.push(ilike(opportunities.canonicalTitle, `%${filters.text.trim()}%`));
  }

  const opportunityRows = await db
    .select({
      opportunityId: opportunities.id,
      canonicalTitle: opportunities.canonicalTitle,
      canonicalStatus: opportunities.canonicalStatus,
      type: opportunities.type,
    })
    .from(opportunities)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(opportunities.updatedAt))
    .limit(clampLimit(filters.limit))
    .offset(filters.offset ?? 0);

  if (opportunityRows.length === 0) return [];

  const memberRows = await db
    .select({
      opportunityId: opportunitySourceMemberships.opportunityId,
      sourceListingId: sourceListings.id,
      sourceSlug: sources.slug,
      status: sourceListings.status,
      title: sourceListingRevisions.titleRaw,
      organization: sourceListingRevisions.organizationRaw,
      canonicalUrl: sourceListings.canonicalSourceUrl,
      publishedAt: sourceListings.sourcePublishedAt,
      deadlineAt: sourceListings.sourceDeadlineAt,
      firstSeenAt: sourceListings.firstSeenAt,
      lastSeenAt: sourceListings.lastSeenAt,
      applicationMethod: sourceListingRevisions.applicationMethod,
    })
    .from(opportunitySourceMemberships)
    .innerJoin(sourceListings, eq(sourceListings.id, opportunitySourceMemberships.sourceListingId))
    .innerJoin(sources, eq(sources.id, sourceListings.sourceId))
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

  const membersByOpportunity = new Map<string, ListingView[]>();
  for (const row of memberRows) {
    const { opportunityId, ...listing } = row;
    const existing = membersByOpportunity.get(opportunityId);
    if (existing) existing.push(listing);
    else membersByOpportunity.set(opportunityId, [listing]);
  }

  return opportunityRows.map((row) => ({
    ...row,
    members: membersByOpportunity.get(row.opportunityId) ?? [],
  }));
}

export interface ReviewQueueEntry {
  candidateId: string;
  similarityScore: number;
  decision: string | null;
  a: ListingView;
  b: ListingView;
}

/**
 * Duplicate pairs awaiting a human verdict (§14.1 stage 5's `needs_review`),
 * with both sides fully rendered so the reviewer can judge without a second
 * lookup. This is the queue that makes `runDedupe`'s conservatism workable:
 * every pair the ruleset refuses to auto-link lands here rather than being
 * silently dropped or silently merged.
 */
export async function listReviewQueue(
  db: DatabaseOrTransaction,
  filters: { limit?: number | undefined; offset?: number | undefined } = {},
): Promise<ReviewQueueEntry[]> {
  const candidates = await db
    .select()
    .from(duplicateCandidates)
    .where(eq(duplicateCandidates.resultingDecision, 'needs_review'))
    .orderBy(desc(duplicateCandidates.similarityScore))
    .limit(clampLimit(filters.limit))
    .offset(filters.offset ?? 0);

  if (candidates.length === 0) return [];

  const listingIds = [
    ...new Set(candidates.flatMap((row) => [row.sourceListingIdA, row.sourceListingIdB])),
  ];
  const listings = await searchListingsByIds(db, listingIds);
  const byId = new Map(listings.map((row) => [row.sourceListingId, row]));

  return candidates.flatMap((candidate) => {
    const a = byId.get(candidate.sourceListingIdA);
    const b = byId.get(candidate.sourceListingIdB);
    // A candidate whose listing lost its current revision cannot be rendered
    // for review; skipping beats emitting a half-populated entry a reviewer
    // would have to interpret.
    if (a === undefined || b === undefined) return [];
    return [
      {
        candidateId: candidate.id,
        similarityScore: candidate.similarityScore,
        decision: candidate.resultingDecision,
        a,
        b,
      },
    ];
  });
}

async function searchListingsByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<ListingView[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      sourceListingId: sourceListings.id,
      sourceSlug: sources.slug,
      status: sourceListings.status,
      title: sourceListingRevisions.titleRaw,
      organization: sourceListingRevisions.organizationRaw,
      canonicalUrl: sourceListings.canonicalSourceUrl,
      publishedAt: sourceListings.sourcePublishedAt,
      deadlineAt: sourceListings.sourceDeadlineAt,
      firstSeenAt: sourceListings.firstSeenAt,
      lastSeenAt: sourceListings.lastSeenAt,
      applicationMethod: sourceListingRevisions.applicationMethod,
    })
    .from(sourceListings)
    .innerJoin(sources, eq(sources.id, sourceListings.sourceId))
    .innerJoin(
      sourceListingRevisions,
      eq(sourceListingRevisions.id, sourceListings.currentRevisionId),
    )
    .where(inArray(sourceListings.id, [...ids]));
}

export interface SourceHealthView {
  sourceSlug: string;
  listingsByStatus: Record<string, number>;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastFullCoverageRunAt: string | null;
  unresolvedIncidents: number;
}

/**
 * Per-source operational health (§21.2's metrics, as a browsable view).
 *
 * `lastFullCoverageRunAt` is surfaced separately from `lastRunAt` on purpose:
 * a source can be polled every hour by bounded incremental runs and still not
 * have had a full-coverage run in weeks, which is precisely the state in which
 * absence reconciliation silently stops happening (§10.2). Showing only "last
 * run" would make that look healthy.
 */
export async function getSourceHealth(db: DatabaseOrTransaction): Promise<SourceHealthView[]> {
  const sourceRows = await db.select({ id: sources.id, slug: sources.slug }).from(sources);

  const statusRows = await db
    .select({
      sourceId: sourceListings.sourceId,
      status: sourceListings.status,
      count: sql<number>`count(*)::int`,
    })
    .from(sourceListings)
    .groupBy(sourceListings.sourceId, sourceListings.status);

  const runRows = await db
    .select({
      sourceId: crawlRuns.sourceId,
      startedAt: crawlRuns.startedAt,
      status: crawlRuns.status,
      fullCoverage: crawlRuns.fullCoverage,
    })
    .from(crawlRuns)
    .orderBy(desc(crawlRuns.startedAt));

  const incidentRows = await db
    .select({ sourceId: parserIncidents.sourceId, count: sql<number>`count(*)::int` })
    .from(parserIncidents)
    .where(eq(parserIncidents.resolved, false))
    .groupBy(parserIncidents.sourceId);

  return sourceRows.map((source) => {
    const listingsByStatus: Record<string, number> = {};
    for (const row of statusRows) {
      if (row.sourceId === source.id) listingsByStatus[row.status] = row.count;
    }
    const runs = runRows.filter((row) => row.sourceId === source.id);
    const lastFullCoverage = runs.find((row) => row.fullCoverage && row.status === 'completed');
    return {
      sourceSlug: source.slug,
      listingsByStatus,
      lastRunAt: runs[0]?.startedAt ?? null,
      lastRunStatus: runs[0]?.status ?? null,
      lastFullCoverageRunAt: lastFullCoverage?.startedAt ?? null,
      unresolvedIncidents: incidentRows.find((row) => row.sourceId === source.id)?.count ?? 0,
    };
  });
}
