import { and, desc, eq, gte, ilike, inArray, isNull, lte, or, type SQL, sql } from 'drizzle-orm';
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
/**
 * Search text, normalized.
 *
 * NFC because Georgian text pasted from a browser and Georgian text typed into
 * an input can carry different Unicode normalizations for the same word, and
 * `ilike` compares bytes. Case folding is a no-op for Mkhedruli, which has no
 * capitals, but it still matters for the Latin employer names in the corpus.
 */
function searchPattern(text: string): string {
  return `%${text.trim().normalize('NFC')}%`;
}

/**
 * The WHERE clauses for a listing search.
 *
 * Extracted so `searchListings` and `countListings` cannot disagree. A count
 * with a hand-copied filter set is the classic pagination bug — page 3 of a
 * 2-page result — and the only reliable fix is one builder with two callers.
 */
function listingConditions(filters: SearchListingsFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.text !== undefined && filters.text.trim().length > 0) {
    const pattern = searchPattern(filters.text);
    const match = or(
      ilike(sourceListingRevisions.titleRaw, pattern),
      ilike(sourceListingRevisions.organizationRaw, pattern),
    );
    if (match !== undefined) conditions.push(match);
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
  return conditions;
}

export async function searchListings(
  db: DatabaseOrTransaction,
  filters: SearchListingsFilters = {},
): Promise<ListingView[]> {
  const conditions = listingConditions(filters);

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

/** How many listings a search matches, for pagination. Same filters, same builder. */
export async function countListings(
  db: DatabaseOrTransaction,
  filters: Omit<SearchListingsFilters, 'limit' | 'offset'> = {},
): Promise<number> {
  const conditions = listingConditions(filters);
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(sourceListings)
    .innerJoin(sources, eq(sources.id, sourceListings.sourceId))
    .innerJoin(
      sourceListingRevisions,
      eq(sourceListingRevisions.id, sourceListings.currentRevisionId),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  return row?.total ?? 0;
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
 * retired membership row survives for audit. An opportunity left with NO live
 * member is excluded entirely — see `opportunityConditions`.
 */
export interface SearchOpportunitiesFilters {
  /** Case-insensitive substring over the canonical title. */
  text?: string | undefined;
  /** §13 canonical states; omitted means every state. */
  statuses?: readonly string[] | undefined;
  /** Has at least one LIVE member from this source. */
  sourceSlug?: string | undefined;
  /** Only clusters with more than one live member — the cross-posted ones. */
  crossPostedOnly?: boolean | undefined;
  /** Any live member's deadline on or after this instant. */
  deadlineFrom?: string | undefined;
  /** Any live member's deadline on or before this — the "closing soon" view. */
  deadlineTo?: string | undefined;
  /**
   * The vacancy first appeared on or after this instant — the "new" view.
   *
   * Compared against the EARLIEST live member, the same value the 'recent' sort
   * orders by, so this agrees with what a row displays.
   */
  firstSeenFrom?: string | undefined;
  /** Default 'recent'. See ORDER_BY below for why that is not updatedAt. */
  sort?: 'recent' | 'deadline' | 'title' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * Correlated subquery over an opportunity's LIVE members.
 *
 * Every member-based filter is an EXISTS rather than a join, and that is not a
 * style preference: joining memberships to `opportunities` multiplies the
 * opportunity row by its member count, so LIMIT and OFFSET would silently
 * paginate over duplicates and a cross-posted opportunity would consume two
 * slots on the page.
 */
function liveMemberExists(inner: SQL): SQL {
  return sql`exists (
    select 1
    from ${opportunitySourceMemberships} m
    join ${sourceListings} sl on sl.id = m.source_listing_id
    join ${sources} s on s.id = sl.source_id
    where m.opportunity_id = ${opportunities.id}
      and m.superseded_at is null
      and ${inner}
  )`;
}

/** The earliest instant any live member of this cluster was first seen. */
const EARLIEST_MEMBER_FIRST_SEEN = sql`(
  select min(sl.first_seen_at)
  from ${opportunitySourceMemberships} m
  join ${sourceListings} sl on sl.id = m.source_listing_id
  where m.opportunity_id = ${opportunities.id} and m.superseded_at is null
)`;

/** The latest deadline among live members that are still open. */
const LATEST_OPEN_MEMBER_DEADLINE = sql`(
  select max(sl.source_deadline_at)
  from ${opportunitySourceMemberships} m
  join ${sourceListings} sl on sl.id = m.source_listing_id
  where m.opportunity_id = ${opportunities.id} and m.superseded_at is null
)`;

/**
 * WHERE clauses for an opportunity search, shared with `countOpportunities`
 * for the same reason `listingConditions` is shared.
 */
function opportunityConditions(filters: SearchOpportunitiesFilters): SQL[] {
  // Unconditional, not a filter: an opportunity with no LIVE member is a
  // retained shell, not a browsable vacancy. `detachListing` and reassignment
  // deliberately keep the row for audit after emptying it, so without this the
  // list shows a record with no route to any source and counts it toward a
  // total that claims to be one row per vacancy. Its history stays reachable
  // through the membership tombstones, which is where audit belongs.
  const conditions: SQL[] = [liveMemberExists(sql`true`)];
  if (filters.text !== undefined && filters.text.trim().length > 0) {
    conditions.push(ilike(opportunities.canonicalTitle, searchPattern(filters.text)));
  }
  if (filters.statuses !== undefined && filters.statuses.length > 0) {
    conditions.push(
      inArray(
        opportunities.canonicalStatus,
        filters.statuses as unknown as typeof opportunities.canonicalStatus.enumValues,
      ),
    );
  }
  if (filters.sourceSlug !== undefined) {
    conditions.push(liveMemberExists(sql`s.slug = ${filters.sourceSlug}`));
  }
  if (filters.deadlineFrom !== undefined) {
    conditions.push(liveMemberExists(sql`sl.source_deadline_at >= ${filters.deadlineFrom}`));
  }
  if (filters.deadlineTo !== undefined) {
    conditions.push(liveMemberExists(sql`sl.source_deadline_at <= ${filters.deadlineTo}`));
  }
  if (filters.firstSeenFrom !== undefined) {
    // Against the EARLIEST live member, not "any member" as this used to be.
    // An any-member EXISTS made a months-old vacancy match "first seen in the
    // last day" as soon as a second board picked it up — while the row itself
    // displayed, and the 'recent' sort ordered by, the earliest member. Filter,
    // sort and displayed value now all mean the same thing: when this vacancy
    // first appeared anywhere.
    conditions.push(sql`${EARLIEST_MEMBER_FIRST_SEEN} >= ${filters.firstSeenFrom}`);
  }
  if (filters.crossPostedOnly === true) {
    conditions.push(sql`(
      select count(*)
      from ${opportunitySourceMemberships} m
      where m.opportunity_id = ${opportunities.id} and m.superseded_at is null
    ) > 1`);
  }
  return conditions;
}

export async function searchOpportunities(
  db: DatabaseOrTransaction,
  filters: SearchOpportunitiesFilters = {},
): Promise<OpportunityView[]> {
  const conditions = opportunityConditions(filters);

  // NOT opportunities.updatedAt, which is what this used to sort by.
  // resolveCanonicalOpportunity stamps updatedAt on every cluster it touches
  // during a dedupe pass, so that ordering reshuffled the whole list after each
  // crawl and never meant "newest job". The earliest instant any live member
  // was first seen is what a triager actually means by recent: when this
  // vacancy first appeared anywhere.
  // Every ordering ends in the primary key, and that is a correctness
  // requirement rather than tidiness. None of the three sort keys is unique —
  // 174 opportunities in the corpus share one deadline, and titles repeat — and
  // Postgres is free to return tied rows in a different order on each query.
  // With LIMIT/OFFSET on top, a tie straddling a page boundary silently
  // duplicates some opportunities onto page 2 and drops others entirely.
  const orderBy =
    filters.sort === 'title'
      ? sql`${opportunities.canonicalTitle} asc, ${opportunities.id} asc`
      : filters.sort === 'deadline'
        ? sql`${LATEST_OPEN_MEMBER_DEADLINE} asc nulls last, ${opportunities.id} asc`
        : sql`${EARLIEST_MEMBER_FIRST_SEEN} desc nulls last, ${opportunities.id} asc`;

  const opportunityRows = await db
    .select({
      opportunityId: opportunities.id,
      canonicalTitle: opportunities.canonicalTitle,
      canonicalStatus: opportunities.canonicalStatus,
      type: opportunities.type,
    })
    .from(opportunities)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(orderBy)
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

/**
 * Live members for a set of opportunities, keyed by opportunity id.
 *
 * Extracted so the ranked-results screen can attach members without repeating
 * this join — and, importantly, as a SECOND query keyed by id rather than a
 * join onto the opportunity list, for the row-multiplication reason
 * `liveMemberExists` documents.
 */
export async function listLiveMembersByOpportunity(
  db: DatabaseOrTransaction,
  opportunityIds: readonly string[],
): Promise<Map<string, ListingView[]>> {
  const byOpportunity = new Map<string, ListingView[]>();
  if (opportunityIds.length === 0) return byOpportunity;

  const rows = await db
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
        inArray(opportunitySourceMemberships.opportunityId, [...opportunityIds]),
        isNull(opportunitySourceMemberships.supersededAt),
      ),
    );

  for (const row of rows) {
    const { opportunityId, ...listing } = row;
    const existing = byOpportunity.get(opportunityId);
    if (existing) existing.push(listing);
    else byOpportunity.set(opportunityId, [listing]);
  }
  return byOpportunity;
}

/** How many opportunities a search matches. Same filters, same builder. */
export async function countOpportunities(
  db: DatabaseOrTransaction,
  filters: Omit<SearchOpportunitiesFilters, 'limit' | 'offset' | 'sort'> = {},
): Promise<number> {
  const conditions = opportunityConditions(filters);
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(opportunities)
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  return row?.total ?? 0;
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

/** How many pairs are waiting for a human verdict. */
export async function countReviewQueue(db: DatabaseOrTransaction): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(duplicateCandidates)
    .where(eq(duplicateCandidates.resultingDecision, 'needs_review'));
  return row?.total ?? 0;
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
