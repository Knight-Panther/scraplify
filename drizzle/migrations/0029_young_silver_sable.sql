DROP VIEW "public"."public_opportunity_members";--> statement-breakpoint
ALTER TABLE "source_policies" ADD COLUMN "revision_seq" bigserial NOT NULL;--> statement-breakpoint
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
      when (current_policy.display->>'mayRepublishFullContent')::boolean is true
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
  left join lateral (
    select "source_policies"."display" as display
    from "source_policies"
    where "source_policies"."source_id" = "sources"."id"
    order by "source_policies"."review_date" desc, "source_policies"."revision_seq" desc
    limit 1
  ) as current_policy on true
  where "opportunity_source_memberships"."superseded_at" is null
    and "source_listings"."status" <> 'quarantined'
);