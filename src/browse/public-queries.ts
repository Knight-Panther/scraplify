import { and, eq, gte, ilike, inArray, lte, or, type SQL, sql } from 'drizzle-orm';
import {
  publicOpportunities,
  publicOpportunityMembers,
  publicSourceListings,
} from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import { sourcePolicies } from '../policies/index.js';
import type { ListingView, OpportunityView, SearchListingsFilters } from './queries.js';
import type { SearchOpportunitiesFilters } from './queries.js';

/**
 * The public-surface query boundary (Phase 8B Stage 4, concept §30.2/§30.4).
 *
 * Every function here queries `public_opportunities`/`public_opportunity_members`/
 * `public_source_listings` (Stage 3's views, plus `public_source_listings` added
 * in Stage 4 round 3) ONLY — never a base table directly, and never a table
 * those views don't expose (`opportunity_decisions`, `duplicate_candidates`,
 * `crawl_runs`, `parser_incidents`, …). That is not a style preference: the
 * `scraplify_public` database role has no grant on anything else, so a query
 * here that touched a base table would work under this repo's own full-access
 * `DATABASE_URL` during development and testing, then fail outright — or
 * worse, if some future grant ever widened, silently succeed and leak — under
 * the actual public deployment. Every WHERE clause and correlated subquery
 * below is written against these public views specifically for this reason.
 *
 * Return shapes are deliberately assignable to `OpportunityView`/`ListingView`
 * (from `./queries.js`) rather than inventing new ones, so the entire existing
 * rendering pipeline (`web/lib/opportunity-row.ts`'s `toRow`, the hero ticker,
 * the opportunities/listings tables) renders public data with no changes at
 * all — only the query call itself differs by `XTELO_SURFACE`.
 *
 * Two features present in the local query layer have no public equivalent,
 * stated here rather than silently dropped:
 * - `SearchListingsFilters.changedOnly` needs revision history
 *   (`source_listing_revisions`), which `public_source_listings` does not
 *   expose (it only carries a listing's CURRENT revision). `publicSearchListings`/
 *   `publicCountListings` return zero results for this filter rather than
 *   silently ignoring it and returning an unfiltered set under a URL that
 *   claims to show "changed" listings.
 * - The detail view has no `revision`/`formerMembers`/`canonicalIsStale` —
 *   those come from `opportunity_revisions` and superseded memberships, which
 *   the public views don't carry at all (Stage 3's own design).
 */

/** `sourcePolicies[slug].policy.display.mayRepublishFullContent`, defaulting closed. */
function mayRepublishFullContent(sourceSlug: string): boolean {
  const entry = (
    sourcePolicies as Record<
      string,
      { policy: { display: { mayRepublishFullContent: boolean } } } | undefined
    >
  )[sourceSlug];
  return entry?.policy.display.mayRepublishFullContent === true;
}

/**
 * The description a public visitor may actually be shown for this member.
 *
 * Omitted, not truncated, when the owning source's policy has not cleared
 * full-content republishing (`src/policies/jobs-ge.ts` and `hr-ge.ts` both
 * currently set this `false`): an omitted description reads to the existing
 * "no description on this board" rendering path
 * (`web/lib/opportunity-detail.ts`'s `Descriptions` filters out blank text),
 * so no new UI branch is needed to enforce this — the policy is enforced
 * once, here, rather than trusted to every future caller.
 */
function publicDescription(sourceSlug: string, description: string): string {
  return mayRepublishFullContent(sourceSlug) ? description : '';
}

function searchPattern(text: string): string {
  return `%${text.trim().normalize('NFC')}%`;
}

/* ---------------------------------------------------------------------- */
/* Listings ("what one board said") — from public_source_listings, which   */
/* carries every non-quarantined listing regardless of dedupe/membership   */
/* state, same as local's searchListings/countListings against the base    */
/* tables directly (Codex, 2026-09-24: public_opportunity_members requires */
/* a LIVE opportunity_source_memberships row via an inner join, so a       */
/* listing dedupe hasn't clustered yet — the normal, expected gap          */
/* getSourceHealth's own unlinkedRows tracks, not a rare edge case — was   */
/* silently invisible here, contradicting change.md §5's own "/listings —  */
/* Separate raw source postings" contract).                                */
/* ---------------------------------------------------------------------- */

function publicListingConditions(filters: SearchListingsFilters): SQL[] {
  const conditions: SQL[] = [];
  // No public equivalent exists — see this file's own header comment. Rather
  // than ignore the filter (which would silently return an unfiltered set
  // under a URL claiming to show only changed listings), force zero rows.
  if (filters.changedOnly === true) conditions.push(sql`false`);
  if (filters.text !== undefined && filters.text.trim().length > 0) {
    const pattern = searchPattern(filters.text);
    const match = or(
      ilike(publicSourceListings.title, pattern),
      ilike(publicSourceListings.organization, pattern),
    );
    if (match !== undefined) conditions.push(match);
  }
  if (filters.sourceSlug !== undefined) {
    conditions.push(eq(publicSourceListings.sourceSlug, filters.sourceSlug));
  }
  if (filters.statuses !== undefined && filters.statuses.length > 0) {
    conditions.push(
      inArray(
        publicSourceListings.status,
        filters.statuses as unknown as (typeof publicSourceListings.status.enumValues)[number][],
      ),
    );
  }
  if (filters.deadlineFrom !== undefined)
    conditions.push(gte(publicSourceListings.deadlineAt, filters.deadlineFrom));
  if (filters.deadlineTo !== undefined)
    conditions.push(lte(publicSourceListings.deadlineAt, filters.deadlineTo));
  if (filters.firstSeenFrom !== undefined)
    conditions.push(gte(publicSourceListings.firstSeenAt, filters.firstSeenFrom));
  return conditions;
}

function clampLimit(limit: number | undefined): number {
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 500;
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

export async function publicSearchListings(
  db: DatabaseOrTransaction,
  filters: SearchListingsFilters = {},
): Promise<ListingView[]> {
  const conditions = publicListingConditions(filters);
  const rows = await db
    .select({
      sourceListingId: publicSourceListings.sourceListingId,
      sourceSlug: publicSourceListings.sourceSlug,
      status: publicSourceListings.status,
      title: publicSourceListings.title,
      organization: publicSourceListings.organization,
      canonicalUrl: publicSourceListings.canonicalUrl,
      publishedAt: publicSourceListings.publishedAt,
      deadlineAt: publicSourceListings.deadlineAt,
      firstSeenAt: publicSourceListings.firstSeenAt,
      lastSeenAt: publicSourceListings.lastSeenAt,
      applicationMethod: publicSourceListings.applicationMethod,
    })
    .from(publicSourceListings)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    // Same tiebreak-safe ordering as the local searchListings/OFFSET pairing.
    .orderBy(sql`${publicSourceListings.firstSeenAt} desc`, publicSourceListings.sourceListingId)
    .limit(clampLimit(filters.limit))
    .offset(filters.offset ?? 0);
  return rows;
}

export async function publicCountListings(
  db: DatabaseOrTransaction,
  filters: Omit<SearchListingsFilters, 'limit' | 'offset'> = {},
): Promise<number> {
  const conditions = publicListingConditions(filters);
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(publicSourceListings)
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  return row?.total ?? 0;
}

/* ---------------------------------------------------------------------- */
/* Opportunities (the deduplicated view) — public_opportunities joined      */
/* against public_opportunity_members, mirroring src/browse/queries.ts's   */
/* filter semantics exactly, but against the flattened public view rather  */
/* than the base tables (no join to source_listings/sources is needed —    */
/* the view already carries their columns directly).                       */
/* ---------------------------------------------------------------------- */

function publicLiveMemberExists(inner: SQL): SQL {
  return sql`exists (
    select 1
    from ${publicOpportunityMembers} pom
    where pom.opportunity_id = ${publicOpportunities.id}
      and ${inner}
  )`;
}

const PUBLIC_EARLIEST_MEMBER_FIRST_SEEN = sql`(
  select min(pom.first_seen_at)
  from ${publicOpportunityMembers} pom
  where pom.opportunity_id = ${publicOpportunities.id}
)`;

const PUBLIC_LATEST_OPEN_MEMBER_DEADLINE = sql`(
  select max(pom.deadline_at)
  from ${publicOpportunityMembers} pom
  where pom.opportunity_id = ${publicOpportunities.id}
)`;

/**
 * The one public-eligibility predicate (docs/THREAT_MODEL.md:83): a member a
 * public visitor may be shown as available right now. Applied unconditionally
 * as the baseline of `publicOpportunityConditions` below — never left for a
 * caller to opt into via `genuinelyOpenAsOf`, the way `/opportunities` itself
 * did not, which silently listed closed/expired/past-deadline opportunities
 * by default (Codex, 2026-09-24). Exported so a future consumer (the Phase 8C
 * matching bundle) reuses this one definition instead of maintaining its own
 * lifecycle-status list.
 */
export function publicEligibleMemberSql(asOf: string): SQL {
  return sql`pom.status = 'active' and (pom.deadline_at is null or pom.deadline_at >= ${asOf})`;
}

/**
 * Same test as `publicEligibleMemberSql`, applied in JS against an
 * already-fetched member snapshot rather than in a correlated SQL subquery.
 * Used to RECHECK eligibility from the one, freshest member fetch a caller
 * ends up with — see `deriveCanonicalTitle`/`deriveCanonicalStatus`'s own
 * comment for why re-deriving from a single snapshot, rather than trusting
 * an earlier query's, is the actual fix (Codex, 2026-09-24).
 */
function hasEligibleMember(
  members: readonly { status: string; deadlineAt: string | null }[],
  asOf: string,
): boolean {
  const asOfMs = Date.parse(asOf);
  return members.some(
    (member) =>
      member.status === 'active' &&
      (member.deadlineAt === null || Date.parse(member.deadlineAt) >= asOfMs),
  );
}

/** `resolveStatus`'s own precedence (`src/dedupe/resolve-canonical.ts`), minus `quarantined` — a member this file ever sees is never one. */
const PUBLIC_STATUS_PRECEDENCE = ['active', 'missing_suspected', 'discovered', 'expired'] as const;

/**
 * Derives a cluster's title/status from ONE already-fetched set of visible
 * members — never blended with a separate, earlier query's snapshot.
 *
 * `publicSearchOpportunities` and `publicGetOpportunity` each run two
 * queries: one to find/filter/paginate opportunity ids, a second to fetch
 * their current members. Between the two, a real write (a crawl reopening or
 * quarantining a member, an admin detaching one) can change what's actually
 * true. Computing canonical fields from the FIRST query's snapshot and then
 * only checking `members.length > 0` from the second (this file's own
 * earlier fix) still lets the two disagree — e.g. the first snapshot's title
 * came from a member that the second, more current fetch shows is now
 * quarantined and gone, so the displayed title is unsupported by any member
 * actually rendered. Deriving everything from the member rows the caller is
 * about to render, and re-checking eligibility against that same set, means
 * there is only ever one snapshot in play: the freshest one (Codex,
 * 2026-09-24).
 */
function deriveCanonicalStatus(members: readonly { status: string }[]): string {
  for (const candidate of PUBLIC_STATUS_PRECEDENCE) {
    if (members.some((member) => member.status === candidate)) return candidate;
  }
  return 'closed';
}

/** Same "first member by `source_listing_id`" tie-break `resolveCanonicalOpportunity` uses. Caller guarantees `members.length > 0`. */
function deriveCanonicalTitle(
  members: readonly { sourceListingId: string; title: string }[],
): string {
  return members.reduce((min, member) =>
    member.sourceListingId < min.sourceListingId ? member : min,
  ).title;
}

/**
 * The public-safe canonical title — derived from PUBLIC-VISIBLE members only
 * (the same "first member by source_listing_id" tie-break
 * `resolveCanonicalOpportunity` uses), never from `publicOpportunities.canonicalTitle`
 * directly. That stored column is resolved across EVERY live member of the
 * cluster, including a quarantined one the public views correctly hide — so an
 * active cluster whose lowest-id member happens to be quarantined would
 * otherwise publish a title no visible source supports (Codex, 2026-09-24).
 */
const PUBLIC_CANONICAL_TITLE = sql<string>`(
  select pom.title
  from ${publicOpportunityMembers} pom
  where pom.opportunity_id = ${publicOpportunities.id}
  order by pom.source_listing_id
  limit 1
)`;

/**
 * The public-safe canonical status — derived from PUBLIC-VISIBLE members'
 * CURRENT state (the same precedence `resolveStatus` in
 * `src/dedupe/resolve-canonical.ts` uses, minus `quarantined`, since a
 * visible member is never one), never from `publicOpportunities.canonicalStatus`
 * directly. That stored column only updates the next time
 * `resolveCanonicalOpportunity` runs — a crawl that reopens or newly closes a
 * member changes the LIVE row this expression reads immediately, but the
 * cached column can lag behind it for as long as resolution hasn't caught up
 * yet, showing a stale lifecycle status to a real visitor and letting
 * `?status=` filter on data that no longer matches (Codex, 2026-09-24).
 */
const PUBLIC_CANONICAL_STATUS = sql<string>`(
  case
    when exists (select 1 from ${publicOpportunityMembers} pom where pom.opportunity_id = ${publicOpportunities.id} and pom.status = 'active') then 'active'
    when exists (select 1 from ${publicOpportunityMembers} pom where pom.opportunity_id = ${publicOpportunities.id} and pom.status = 'missing_suspected') then 'missing_suspected'
    when exists (select 1 from ${publicOpportunityMembers} pom where pom.opportunity_id = ${publicOpportunities.id} and pom.status = 'discovered') then 'discovered'
    when exists (select 1 from ${publicOpportunityMembers} pom where pom.opportunity_id = ${publicOpportunities.id} and pom.status = 'expired') then 'expired'
    else 'closed'
  end
)`;

function publicOpportunityConditions(filters: SearchOpportunitiesFilters): SQL[] {
  // Unconditional, not opt-in — see `publicEligibleMemberSql` above. Also
  // still excludes an opportunity whose only live members are quarantined,
  // same as before, since an eligible member is necessarily non-quarantined.
  const asOf = filters.genuinelyOpenAsOf ?? new Date().toISOString();
  const eligible = publicEligibleMemberSql(asOf);
  const conditions: SQL[] = [];
  if (filters.text !== undefined && filters.text.trim().length > 0) {
    conditions.push(ilike(PUBLIC_CANONICAL_TITLE, searchPattern(filters.text)));
  }
  if (filters.statuses !== undefined && filters.statuses.length > 0) {
    conditions.push(
      inArray(
        PUBLIC_CANONICAL_STATUS,
        filters.statuses as unknown as (typeof publicOpportunities.canonicalStatus.enumValues)[number][],
      ),
    );
  }
  if (filters.types !== undefined && filters.types.length > 0) {
    conditions.push(
      inArray(
        publicOpportunities.type,
        filters.types as unknown as (typeof publicOpportunities.type.enumValues)[number][],
      ),
    );
  }
  if (filters.sourceSlug !== undefined) {
    conditions.push(publicLiveMemberExists(sql`pom.source_slug = ${filters.sourceSlug}`));
  }
  // Eligibility and any deadline-window filter must be satisfied by the SAME
  // member, combined into one EXISTS — not two independent ones, which a
  // cross-posted opportunity could satisfy through two DIFFERENT members
  // (one eligible with a deadline outside the window, another inside it but
  // closed/expired), matching "closing in 7 days" for a vacancy whose actual
  // open path doesn't close then at all (Codex, 2026-09-24; same reasoning
  // local's opportunityConditions already applies to deadlineFrom/deadlineTo
  // between themselves). Eligibility alone when no deadline filter applies.
  if (filters.deadlineFrom !== undefined && filters.deadlineTo !== undefined) {
    conditions.push(
      publicLiveMemberExists(
        sql`${eligible} and pom.deadline_at >= ${filters.deadlineFrom} and pom.deadline_at <= ${filters.deadlineTo}`,
      ),
    );
  } else if (filters.deadlineFrom !== undefined) {
    conditions.push(
      publicLiveMemberExists(sql`${eligible} and pom.deadline_at >= ${filters.deadlineFrom}`),
    );
  } else if (filters.deadlineTo !== undefined) {
    conditions.push(
      publicLiveMemberExists(sql`${eligible} and pom.deadline_at <= ${filters.deadlineTo}`),
    );
  } else {
    conditions.push(publicLiveMemberExists(eligible));
  }
  if (filters.firstSeenFrom !== undefined) {
    conditions.push(sql`${PUBLIC_EARLIEST_MEMBER_FIRST_SEEN} >= ${filters.firstSeenFrom}`);
  }
  if (filters.crossPostedOnly === true) {
    conditions.push(sql`(
      select count(distinct pom.source_slug)
      from ${publicOpportunityMembers} pom
      where pom.opportunity_id = ${publicOpportunities.id}
    ) > 1`);
  }
  return conditions;
}

export async function publicSearchOpportunities(
  db: DatabaseOrTransaction,
  filters: SearchOpportunitiesFilters = {},
): Promise<OpportunityView[]> {
  const asOf = filters.genuinelyOpenAsOf ?? new Date().toISOString();
  const conditions = publicOpportunityConditions(filters);
  const orderBy =
    filters.sort === 'title'
      ? sql`${PUBLIC_CANONICAL_TITLE} asc, ${publicOpportunities.id} asc`
      : filters.sort === 'deadline'
        ? sql`${PUBLIC_LATEST_OPEN_MEMBER_DEADLINE} asc nulls last, ${publicOpportunities.id} asc`
        : sql`${PUBLIC_EARLIEST_MEMBER_FIRST_SEEN} desc nulls last, ${publicOpportunities.id} asc`;

  // This query decides WHICH ids match and in what ORDER — it does not
  // decide what is displayed about them. `canonicalTitle`/`canonicalStatus`
  // are deliberately not selected here; see `deriveCanonicalTitle`'s comment
  // for why trusting them from this snapshot, separately from the member
  // fetch below, was the actual defect.
  const opportunityRows = await db
    .select({
      opportunityId: publicOpportunities.id,
      type: publicOpportunities.type,
    })
    .from(publicOpportunities)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(orderBy)
    .limit(clampLimit(filters.limit))
    .offset(filters.offset ?? 0);

  if (opportunityRows.length === 0) return [];

  const memberRows = await db
    .select({
      opportunityId: publicOpportunityMembers.opportunityId,
      sourceListingId: publicOpportunityMembers.sourceListingId,
      sourceSlug: publicOpportunityMembers.sourceSlug,
      status: publicOpportunityMembers.status,
      title: publicOpportunityMembers.title,
      organization: publicOpportunityMembers.organization,
      canonicalUrl: publicOpportunityMembers.canonicalUrl,
      publishedAt: publicOpportunityMembers.publishedAt,
      deadlineAt: publicOpportunityMembers.deadlineAt,
      firstSeenAt: publicOpportunityMembers.firstSeenAt,
      lastSeenAt: publicOpportunityMembers.lastSeenAt,
      applicationMethod: publicOpportunityMembers.applicationMethod,
    })
    .from(publicOpportunityMembers)
    .where(
      inArray(
        publicOpportunityMembers.opportunityId,
        opportunityRows.map((row) => row.opportunityId),
      ),
    );

  const membersByOpportunity = new Map<string, ListingView[]>();
  for (const row of memberRows) {
    const { opportunityId, ...listing } = row;
    const existing = membersByOpportunity.get(opportunityId);
    if (existing) existing.push(listing);
    else membersByOpportunity.set(opportunityId, [listing]);
  }

  // Everything about a row — title, status, and whether it belongs in the
  // result at all — is derived from THIS one member fetch, never blended
  // with the earlier filtering query's snapshot (Codex, 2026-09-24; see
  // `deriveCanonicalTitle`'s comment). A write between the two queries can
  // only ever make a row disappear here (no members, or no longer eligible)
  // or its content reflect whatever is now current — never a mix of two
  // different moments.
  return opportunityRows.flatMap((row) => {
    const members = membersByOpportunity.get(row.opportunityId) ?? [];
    if (members.length === 0 || !hasEligibleMember(members, asOf)) return [];
    return [
      {
        opportunityId: row.opportunityId,
        canonicalTitle: deriveCanonicalTitle(members),
        canonicalStatus: deriveCanonicalStatus(members),
        type: row.type,
        members,
      },
    ];
  });
}

export async function publicCountOpportunities(
  db: DatabaseOrTransaction,
  filters: Omit<SearchOpportunitiesFilters, 'limit' | 'offset' | 'sort'> = {},
): Promise<number> {
  const conditions = publicOpportunityConditions(filters);
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(publicOpportunities)
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  return row?.total ?? 0;
}

/* ---------------------------------------------------------------------- */
/* Opportunity detail — deliberately its own, narrower shape (no revision, */
/* no formerMembers, no dedupe evidence: the public views don't carry any  */
/* of that data at all, so there is nothing to accidentally leak here).    */
/* ---------------------------------------------------------------------- */

export interface PublicOpportunityMemberDetail {
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
  /** Already policy-filtered — see `publicDescription` above. May be `''`. */
  description: string;
  locations: unknown;
  salaryRaw: string | null;
  sourceCategories: unknown;
  structuredAttributes: unknown;
}

export interface PublicOpportunityDetailView {
  opportunityId: string;
  canonicalTitle: string;
  canonicalStatus: string;
  type: string;
  createdAt: string;
  updatedAt: string;
  members: PublicOpportunityMemberDetail[];
}

export async function publicGetOpportunity(
  db: DatabaseOrTransaction,
  opportunityId: string,
  /** Defaults to now — a fixed value lets a caller share one instant with a sibling list query, same reason `publicOpportunityConditions` takes one. */
  asOf: string = new Date().toISOString(),
): Promise<PublicOpportunityDetailView | null> {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(opportunityId)) return null;

  // A pre-check only, not the final gate — see below. It exists to avoid a
  // wasted member fetch for an id that plainly doesn't exist or was never
  // eligible; it does NOT decide the final result, since a write could still
  // land between this query and the member fetch (Codex, 2026-09-24).
  const [opportunity] = await db
    .select({
      opportunityId: publicOpportunities.id,
      type: publicOpportunities.type,
      createdAt: publicOpportunities.createdAt,
      updatedAt: publicOpportunities.updatedAt,
    })
    .from(publicOpportunities)
    .where(
      and(
        eq(publicOpportunities.id, opportunityId),
        publicLiveMemberExists(publicEligibleMemberSql(asOf)),
      ),
    );
  if (opportunity === undefined) return null;

  const memberRows = await db
    .select({
      sourceListingId: publicOpportunityMembers.sourceListingId,
      sourceSlug: publicOpportunityMembers.sourceSlug,
      status: publicOpportunityMembers.status,
      title: publicOpportunityMembers.title,
      organization: publicOpportunityMembers.organization,
      canonicalUrl: publicOpportunityMembers.canonicalUrl,
      publishedAt: publicOpportunityMembers.publishedAt,
      deadlineAt: publicOpportunityMembers.deadlineAt,
      firstSeenAt: publicOpportunityMembers.firstSeenAt,
      lastSeenAt: publicOpportunityMembers.lastSeenAt,
      applicationMethod: publicOpportunityMembers.applicationMethod,
      description: publicOpportunityMembers.description,
      locations: publicOpportunityMembers.locations,
      salaryRaw: publicOpportunityMembers.salaryRaw,
      sourceCategories: publicOpportunityMembers.sourceCategories,
      structuredAttributes: publicOpportunityMembers.structuredAttributes,
    })
    .from(publicOpportunityMembers)
    .where(eq(publicOpportunityMembers.opportunityId, opportunityId))
    .orderBy(publicOpportunityMembers.sourceSlug, publicOpportunityMembers.sourceListingId);

  // The one and only snapshot this function's result is actually derived
  // from (Codex, 2026-09-24; see `deriveCanonicalTitle`'s comment). Both
  // checks below are RE-verified here even though the query above already
  // checked them, since a write between the two queries can invalidate
  // either one: a retained shell with no public-visible member is not a
  // detail page — the same lost-provenance defect AGENTS.md classes P1 for
  // the local surface — and a cluster that is no longer eligible must not
  // resolve just because it was a moment ago.
  if (memberRows.length === 0 || !hasEligibleMember(memberRows, asOf)) return null;

  return {
    ...opportunity,
    canonicalTitle: deriveCanonicalTitle(memberRows),
    canonicalStatus: deriveCanonicalStatus(memberRows),
    members: memberRows.map((member) => ({
      ...member,
      description: publicDescription(member.sourceSlug, member.description),
    })),
  };
}

/* ---------------------------------------------------------------------- */
/* Source overview — the public replacement for getSourceHealth, which    */
/* carries crawl-run diagnostics (lastRunStatus, unresolvedIncidents, …)  */
/* this role has no access to and a public visitor has no reason to see.  */
/* ---------------------------------------------------------------------- */

export interface PublicSourceOverview {
  sourceSlug: string;
  trackedCount: number;
  /** The most recent listing confirmation seen from this source, if any. */
  lastSeenAt: string | null;
}

export async function publicSourceOverview(
  db: DatabaseOrTransaction,
): Promise<PublicSourceOverview[]> {
  const rows = await db
    .select({
      sourceSlug: publicSourceListings.sourceSlug,
      trackedCount: sql<number>`count(*)::int`,
      // Raw SQL aggregates bypass drizzle's column-type mapping, so this
      // comes back as Postgres's own "2026-09-10 00:00:00+00" rather than
      // the ISO-8601 string every other timestamp in this app is — normalized
      // below rather than left to disagree with `web/lib/format.ts`'s
      // `Date.parse`-based helpers (found by this file's own test).
      lastSeenAt: sql<string | null>`max(${publicSourceListings.lastSeenAt})`,
    })
    .from(publicSourceListings)
    .groupBy(publicSourceListings.sourceSlug);
  return rows.map((row) => ({
    ...row,
    lastSeenAt: row.lastSeenAt === null ? null : new Date(row.lastSeenAt).toISOString(),
  }));
}

/**
 * The public equivalent of `web/lib/sync.ts`'s `lastCompletedSync` — same
 * "oldest of each source's own most-recent confirmation, only if every
 * source has one" shape, substituting a listing's `lastSeenAt` (a per-crawl
 * confirmation this role CAN see) for `lastFullCoverageRunAt` (a per-run
 * fact this role cannot, since `crawl_runs` isn't one of its views at all).
 * This is a coarser signal — a source can be re-confirmed by an incremental
 * crawl without a full-coverage pass — stated here rather than presented as
 * the same fact under a shared name.
 */
export function publicLastSeen(overview: readonly PublicSourceOverview[]): string | undefined {
  const values = overview.map((source) => source.lastSeenAt);
  return values.every((value): value is string => value !== null)
    ? values.slice().sort()[0]
    : undefined;
}
