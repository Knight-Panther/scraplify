DROP VIEW "public"."public_opportunity_members";--> statement-breakpoint
ALTER TABLE "source_policies" DROP CONSTRAINT "source_policies_source_id_unique";--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "current_policy_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_current_policy_revision_id_source_policies_id_fk" FOREIGN KEY ("current_policy_revision_id") REFERENCES "public"."source_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Backfill: round 5's migrations (0029-0030) left each source with exactly
-- one source_policies row, orphaned by this migration's own DROP
-- CONSTRAINT above until something points sources.current_policy_revision_id
-- at it. Without this UPDATE, both real sources' descriptions would go
-- from "correctly redacted because mayRepublishFullContent is false" to
-- "redacted because there is no current revision to find at all" -- the
-- same VISIBLE result today only because both real policies already
-- redact, but wrong by construction, and would stay wrong until the next
-- crawl's syncSourcePolicy() call created a brand new revision rather than
-- reusing the perfectly good one already there. One source_policies row
-- per source_id is exactly what round 5 guaranteed still holds at this
-- exact point in the migration (the DROP CONSTRAINT above just ran, but
-- nothing has inserted a second row for any source yet), so this
-- correlated subquery is unambiguous.
UPDATE "sources"
SET "current_policy_revision_id" = (
  SELECT "id" FROM "source_policies" WHERE "source_policies"."source_id" = "sources"."id"
)
WHERE EXISTS (
  SELECT 1 FROM "source_policies" WHERE "source_policies"."source_id" = "sources"."id"
);--> statement-breakpoint
CREATE VIEW "public"."public_opportunity_members" AS (
  select
    "opportunity_source_memberships"."opportunity_id" as opportunity_id,
    "source_listings"."id" as source_listing_id,
    "sources"."slug" as source_slug,
    "source_listings"."status" as status,
    "source_listing_revisions"."title_raw" as title,
    "source_listing_revisions"."organization_raw" as organization,
    "source_listings"."canonical_source_url" as canonical_url,
    "source_listings"."source_published_at" as published_at,
    "source_listings"."source_deadline_at" as deadline_at,
    "source_listings"."first_seen_at" as first_seen_at,
    "source_listings"."last_seen_at" as last_seen_at,
    "source_listing_revisions"."application_method" as application_method,
    case
      when ("source_policies"."display"->>'mayRepublishFullContent')::boolean is true
        then "source_listing_revisions"."description"
      else ''
    end as description,
    "source_listing_revisions"."locations" as locations,
    "source_listing_revisions"."salary_raw" as salary_raw,
    "source_listing_revisions"."source_categories" as source_categories,
    "source_listing_revisions"."structured_attributes" as structured_attributes
  from "opportunity_source_memberships"
  inner join "source_listings" on "source_listings"."id" = "opportunity_source_memberships"."source_listing_id"
  inner join "sources" on "sources"."id" = "source_listings"."source_id"
  inner join "source_listing_revisions" on "source_listing_revisions"."id" = "source_listings"."current_revision_id"
  left join "source_policies" on "source_policies"."id" = "sources"."current_policy_revision_id"
  where "opportunity_source_memberships"."superseded_at" is null
    and "source_listings"."status" <> 'quarantined'
);