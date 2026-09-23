CREATE VIEW "public"."public_source_listings" AS (
  select
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
    "source_listing_revisions"."application_method" as application_method
  from "source_listings"
  inner join "sources" on "sources"."id" = "source_listings"."source_id"
  inner join "source_listing_revisions" on "source_listing_revisions"."id" = "source_listings"."current_revision_id"
  where "source_listings"."status" <> 'quarantined'
);