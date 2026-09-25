import { sql } from 'drizzle-orm';
import { jsonb, pgView, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  opportunities,
  opportunitySourceMemberships,
  opportunityTypeEnum,
} from './opportunities.js';
import {
  sourceListingRevisions,
  sourceListingStatusEnum,
  sourceListings,
} from './source-listings.js';
import { sourcePolicies, sources } from './sources.js';

/**
 * The public database role's entire visible surface (concept §30.2, Phase 8B
 * Stage 3, extended Stage 4 round 3 with `public_source_listings`). This role
 * is granted `SELECT` on these three views ONLY — never on any base table —
 * so the boundary holds even if a future public-surface
 * query has a bug: there is no grant to fall back on for
 * `opportunity_source_memberships.evidence`, `shortlist_decisions`,
 * `duplicate_candidates`, `outreach_drafts`, `candidate_profiles`,
 * `audit_events`, `crawl_runs`, `parser_incidents`, or any other table this
 * role was never given access to.
 *
 * This is a coarse, static boundary — which tables/columns exist at all —
 * not the full public-safe query logic. Row-level filtering that depends on
 * "now" (genuinely-open-as-of) or per-source policy
 * (`display.mayRepublishFullContent`, which lives in `src/policies/*.ts`,
 * not the database) still belongs to Stage 4's TypeScript query module,
 * built against these views instead of the base tables. `quarantined` is
 * excluded here regardless, since that condition is static rather than
 * time-dependent and Stage 4's own plan calls for excluding it "by
 * construction".
 */

export const publicOpportunities = pgView('public_opportunities', {
  id: uuid('id').notNull(),
  canonicalTitle: text('canonical_title').notNull(),
  canonicalStatus: sourceListingStatusEnum('canonical_status').notNull(),
  type: opportunityTypeEnum('type').notNull(),
  createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true }).notNull(),
}).as(sql`
  select
    ${opportunities.id} as id,
    ${opportunities.canonicalTitle} as canonical_title,
    ${opportunities.canonicalStatus} as canonical_status,
    ${opportunities.type} as type,
    ${opportunities.createdAt} as created_at,
    ${opportunities.updatedAt} as updated_at
  from ${opportunities}
  where ${opportunities.canonicalStatus} <> 'quarantined'
`);

/**
 * One row per LIVE (non-superseded), non-quarantined source membership —
 * deliberately the same shape `searchOpportunities`/`listLiveMembersByOpportunity`
 * already select for `ListingView` today, which is itself already free of
 * dedupe internals (no `decision`, `confidence`, `decidedBy`,
 * `dedupeModelOrRulesetVersion`, or `evidence` — those stay on
 * `opportunity_source_memberships`, which this role has no grant on at all),
 * plus the detail-page content fields (`description`, `locations`,
 * `salaryRaw`, `sourceCategories`, `structuredAttributes`) so one view
 * covers both the list and detail routes. `formerMembers` (superseded
 * memberships) is the operator audit trail and is not exposed here.
 *
 * `description` is redacted IN THE VIEW ITSELF, not left to application code
 * (adversarial review, 2026-09-24): `scraplify_public` is granted `SELECT`
 * directly on this view, so a redaction living only in `src/browse/
 * public-queries.ts` would be bypassed by any direct query against the view
 * — a compromised public process, an operator's own ad hoc query, or a
 * future caller that forgets to call the TypeScript helper. The `CASE`
 * below resolves against `source_policies` (the same `display.
 * mayRepublishFullContent` flag `src/policies/*.ts`'s `SourcePolicySchema`
 * defines) and blanks `description` to `''` unless that flag is explicitly
 * `true`.
 *
 * The `CASE` also requires `sources.policyConflictAt IS NULL` (Codex-caught
 * P1, round 12, 2026-09-25): when `syncSourcePolicy()` detects a same-date,
 * differing-content conflict, it flags `policyConflictAt` but deliberately
 * leaves `currentPolicyRevisionId` pointed at whichever revision won the
 * race — which could be the MORE PERMISSIVE one if a stale worker happened
 * to sync first (see `src/db/source-policies.ts`'s own doc comment). Without
 * this condition, a direct query against this view during that unresolved
 * window would still read `mayRepublishFullContent` off whatever the
 * pointer happens to hold and could republish full descriptions the
 * genuinely-intended (but losing) revision meant to keep redacted — exactly
 * the gap `docs/THREAT_MODEL.md`'s source-rights gate exists to close, and
 * one the TypeScript layer alone cannot patch for a direct or compromised
 * caller, since `scraplify_public` is granted `SELECT` on this view
 * directly. Failing closed (redacted) during any unresolved conflict, not
 * just once one is flagged, is deliberate: the whole point of a same-date
 * conflict is that this deployment cannot tell which revision is correct.
 *
 * A plain `LEFT JOIN` through `sources.currentPolicyRevisionId` — an
 * explicit FK to the ONE `source_policies` row currently in effect for
 * that source — not a join on `source_id` at all (round 6 of the same
 * adversarial review, 2026-09-24). `source_policies` is genuinely an
 * append-only revision log again (`src/db/schema/sources.ts`'s own doc
 * comment has the full history: round 5 tried making `source_id`
 * `.unique()` to force exactly one row per source, which round 6 found
 * broke `docs/scraplify-concept.md` §5.3's explicit "versioned policy
 * record" requirement by destroying a prior revision's `evidence`/
 * `decisionOwner` on every overwrite, AND left activation of a policy
 * change coupled to whenever the next crawl happened to run — a real
 * window, since scheduled crawls have silently stopped for a week before
 * per this project's own incident history). `sources.
 * currentPolicyRevisionId` is now the ONLY thing that says which revision
 * is current; nothing about row count, ordering, or a tiebreak column
 * decides it — `src/db/source-policies.ts`'s `syncSourcePolicy()` is the
 * one function that ever moves that pointer, called by every crawl AND
 * standalone (`npm run sync-policies`) so a policy edit activates the
 * moment it's deployed, not whenever a crawl next happens to run. `LEFT
 * JOIN`, not inner: a source with no current revision at all (before its
 * first sync ever runs) must default closed (redacted), the same
 * "defaulting closed" posture `public-queries.ts`'s own
 * `mayRepublishFullContent()` already documents, not open by the absence
 * of a row.
 */
export const publicOpportunityMembers = pgView('public_opportunity_members', {
  opportunityId: uuid('opportunity_id').notNull(),
  sourceListingId: uuid('source_listing_id').notNull(),
  sourceSlug: text('source_slug').notNull(),
  status: sourceListingStatusEnum('status').notNull(),
  title: text('title').notNull(),
  organization: text('organization'),
  canonicalUrl: text('canonical_url').notNull(),
  publishedAt: timestamp('published_at', { mode: 'string', withTimezone: true }),
  deadlineAt: timestamp('deadline_at', { mode: 'string', withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { mode: 'string', withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { mode: 'string', withTimezone: true }).notNull(),
  applicationMethod: jsonb('application_method'),
  description: text('description').notNull(),
  locations: jsonb('locations').notNull(),
  salaryRaw: text('salary_raw'),
  sourceCategories: jsonb('source_categories').notNull(),
  structuredAttributes: jsonb('structured_attributes').notNull(),
}).as(sql`
  select
    ${opportunitySourceMemberships.opportunityId} as opportunity_id,
    ${sourceListings.id} as source_listing_id,
    ${sources.slug} as source_slug,
    ${sourceListings.status} as status,
    ${sourceListingRevisions.titleRaw} as title,
    ${sourceListingRevisions.organizationRaw} as organization,
    ${sourceListings.canonicalSourceUrl} as canonical_url,
    ${sourceListings.sourcePublishedAt} as published_at,
    ${sourceListings.sourceDeadlineAt} as deadline_at,
    ${sourceListings.firstSeenAt} as first_seen_at,
    ${sourceListings.lastSeenAt} as last_seen_at,
    ${sourceListingRevisions.applicationMethod} as application_method,
    case
      when (${sourcePolicies.display}->>'mayRepublishFullContent')::boolean is true
        and ${sources.policyConflictAt} is null
        then ${sourceListingRevisions.description}
      else ''
    end as description,
    ${sourceListingRevisions.locations} as locations,
    ${sourceListingRevisions.salaryRaw} as salary_raw,
    ${sourceListingRevisions.sourceCategories} as source_categories,
    ${sourceListingRevisions.structuredAttributes} as structured_attributes
  from ${opportunitySourceMemberships}
  inner join ${sourceListings} on ${sourceListings.id} = ${opportunitySourceMemberships.sourceListingId}
  inner join ${sources} on ${sources.id} = ${sourceListings.sourceId}
  inner join ${sourceListingRevisions} on ${sourceListingRevisions.id} = ${sourceListings.currentRevisionId}
  left join ${sourcePolicies} on ${sourcePolicies.id} = ${sources.currentPolicyRevisionId}
  where ${opportunitySourceMemberships.supersededAt} is null
    and ${sourceListings.status} <> 'quarantined'
`);

/**
 * One row per non-quarantined source listing, regardless of dedupe/membership
 * state — the public-safe equivalent of what `src/browse/queries.ts`'s
 * `searchListings`/`countListings` already read directly off `source_listings`
 * (no membership join at all). `public_opportunity_members` above is the wrong
 * base for `/listings` (Codex, 2026-09-24): it requires a LIVE
 * `opportunity_source_memberships` row via an inner join, so any listing a
 * crawl has written but dedupe hasn't clustered yet — the normal, expected gap
 * `getSourceHealth`'s own `unlinkedRows`/`UNLINKED_GRACE_HOURS` tracks as a
 * routine operational state, not a rare edge case — would be silently absent
 * from the public raw-listing view entirely, contradicting change.md §5's own
 * "`/listings` — Separate raw source postings" contract. Same fields as
 * `ListingView` (no dedupe/opportunity linkage of any kind, since a listing
 * here may not have any), same quarantine exclusion as every other public
 * view, deliberately no join to `opportunities`/`opportunity_source_memberships`
 * at all.
 */
export const publicSourceListings = pgView('public_source_listings', {
  sourceListingId: uuid('source_listing_id').notNull(),
  sourceSlug: text('source_slug').notNull(),
  status: sourceListingStatusEnum('status').notNull(),
  title: text('title').notNull(),
  organization: text('organization'),
  canonicalUrl: text('canonical_url').notNull(),
  publishedAt: timestamp('published_at', { mode: 'string', withTimezone: true }),
  deadlineAt: timestamp('deadline_at', { mode: 'string', withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { mode: 'string', withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { mode: 'string', withTimezone: true }).notNull(),
  applicationMethod: jsonb('application_method'),
}).as(sql`
  select
    ${sourceListings.id} as source_listing_id,
    ${sources.slug} as source_slug,
    ${sourceListings.status} as status,
    ${sourceListingRevisions.titleRaw} as title,
    ${sourceListingRevisions.organizationRaw} as organization,
    ${sourceListings.canonicalSourceUrl} as canonical_url,
    ${sourceListings.sourcePublishedAt} as published_at,
    ${sourceListings.sourceDeadlineAt} as deadline_at,
    ${sourceListings.firstSeenAt} as first_seen_at,
    ${sourceListings.lastSeenAt} as last_seen_at,
    ${sourceListingRevisions.applicationMethod} as application_method
  from ${sourceListings}
  inner join ${sources} on ${sources.id} = ${sourceListings.sourceId}
  inner join ${sourceListingRevisions} on ${sourceListingRevisions.id} = ${sourceListings.currentRevisionId}
  where ${sourceListings.status} <> 'quarantined'
`);
