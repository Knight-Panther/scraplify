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
import { sources } from './sources.js';

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
    ${sourceListingRevisions.description} as description,
    ${sourceListingRevisions.locations} as locations,
    ${sourceListingRevisions.salaryRaw} as salary_raw,
    ${sourceListingRevisions.sourceCategories} as source_categories,
    ${sourceListingRevisions.structuredAttributes} as structured_attributes
  from ${opportunitySourceMemberships}
  inner join ${sourceListings} on ${sourceListings.id} = ${opportunitySourceMemberships.sourceListingId}
  inner join ${sources} on ${sources.id} = ${sourceListings.sourceId}
  inner join ${sourceListingRevisions} on ${sourceListingRevisions.id} = ${sourceListings.currentRevisionId}
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
