ALTER TYPE "realestate"."deal_type" ADD VALUE 'daily';--> statement-breakpoint
ALTER TYPE "realestate"."deal_type" ADD VALUE 'pledge';--> statement-breakpoint
ALTER TYPE "realestate"."property_type" ADD VALUE 'commercial';--> statement-breakpoint
ALTER TYPE "realestate"."property_type" ADD VALUE 'land';--> statement-breakpoint
ALTER TYPE "realestate"."property_type" ADD VALUE 'hotel';--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "commercial_type" smallint;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "land_type" smallint;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "image_count" smallint;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "has_furniture" boolean;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "has_built_in_kitchen" boolean;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "exclusive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "video_viewing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "price_per_m2_gel" numeric(12, 2);--> statement-breakpoint
-- create or replace, not drop and create: the eight new columns are added at the
-- end, so the existing columns and the grant to scraplify_public stay (as 0042).
-- Nothing in this migration uses the new enum values, which Postgres allows
-- only after the transaction that adds them commits.
CREATE OR REPLACE VIEW "realestate"."public_listings" AS (
    select
      "realestate"."listings"."id" as id,
      "realestate"."listings"."source_id" as source_id,
      "realestate"."listings"."canonical_url" as canonical_url,
      "realestate"."listings"."deal_type" as deal_type,
      "realestate"."listings"."property_type" as property_type,
      "realestate"."listings"."rooms" as rooms,
      "realestate"."listings"."bedrooms" as bedrooms,
      "realestate"."listings"."area_m2" as area_m2,
      "realestate"."listings"."floor" as floor,
      "realestate"."listings"."total_floors" as total_floors,
      "realestate"."listings"."price_gel" as price_gel,
      "realestate"."listings"."price_usd" as price_usd,
      "realestate"."listings"."price_per_m2_usd" as price_per_m2_usd,
      "realestate"."listings"."currency_posted" as currency_posted,
      "realestate"."listings"."city_ref" as city_ref,
      "realestate"."listings"."city_name" as city_name,
      "realestate"."listings"."district_ref" as district_ref,
      "realestate"."listings"."district_name" as district_name,
      "realestate"."listings"."subdistrict_ref" as subdistrict_ref,
      "realestate"."listings"."subdistrict_name" as subdistrict_name,
      "realestate"."listings"."street_name" as street_name,
      "realestate"."listings"."street_number" as street_number,
      "realestate"."listings"."poster_type" as poster_type,
      "realestate"."listings"."promoted" as promoted,
      "realestate"."listings"."source_updated_at" as source_updated_at,
      "realestate"."listings"."expected_end_at" as expected_end_at,
      "realestate"."listings"."first_seen_at" as first_seen_at,
      "realestate"."listings"."last_seen_at" as last_seen_at,
      "realestate"."listings"."search" as search,
      "realestate"."listings"."group_key" as group_key,
      "realestate"."listings"."commercial_type" as commercial_type,
      "realestate"."listings"."land_type" as land_type,
      "realestate"."listings"."image_count" as image_count,
      "realestate"."listings"."has_furniture" as has_furniture,
      "realestate"."listings"."has_built_in_kitchen" as has_built_in_kitchen,
      "realestate"."listings"."exclusive" as exclusive,
      "realestate"."listings"."video_viewing" as video_viewing,
      "realestate"."listings"."price_per_m2_gel" as price_per_m2_gel
    from "realestate"."listings"
    where "realestate"."listings"."status" = 'active'
  );