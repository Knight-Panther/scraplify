DROP VIEW "public"."public_opportunity_members";--> statement-breakpoint
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
        and "sources"."policy_conflict_at" is null
        then "source_listing_revisions"."description"
      else ''
    end as description,
    "source_listing_revisions"."locations" as locations,
    "source_listing_revisions"."salary_raw" as salary_raw,
    "source_listing_revisions"."source_categories" as source_categories,
    "source_listing_revisions"."structured_attributes" as structured_attributes,
    (select t.label from listing_classifications lc
       join taxonomy_terms t on t.id = lc.taxonomy_term_id and t.parent_id is null
       where lc.source_listing_revision_id = "source_listing_revisions"."id"
         and lc.axis = 'profession' and lc.superseded_at is null
         and lc.method in ('keyword', 'human_review')
       order by (lc.method = 'human_review') desc, lc.confidence desc, lc.id
       limit 1) as guessed_field,
    (select coalesce(jsonb_agg(t.label order by (lc.evidence->>'order')::int nulls last, t.label), '[]'::jsonb)
       from listing_classifications lc
       join taxonomy_terms t on t.id = lc.taxonomy_term_id
       where lc.source_listing_revision_id = "source_listing_revisions"."id"
         and lc.axis = 'location' and lc.superseded_at is null
         and lc.method in ('keyword', 'human_review')) as read_cities
  from "opportunity_source_memberships"
  inner join "source_listings" on "source_listings"."id" = "opportunity_source_memberships"."source_listing_id"
  inner join "sources" on "sources"."id" = "source_listings"."source_id"
  inner join "source_listing_revisions" on "source_listing_revisions"."id" = "source_listings"."current_revision_id"
  left join "source_policies" on "source_policies"."id" = "sources"."current_policy_revision_id"
  where "opportunity_source_memberships"."superseded_at" is null
    and "source_listings"."status" <> 'quarantined'
);