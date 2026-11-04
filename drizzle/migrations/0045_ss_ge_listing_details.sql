ALTER TABLE "realestate"."crawl_runs" ADD COLUMN "details_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "building_status" text;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "condition" text;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "project" text;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "floor_type" text;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "bathrooms" smallint;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "balconies" smallint;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "kitchen_area" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "house_area" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "yard_area" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "poster_entity" text;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "amenities" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "longitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "municipality_ref" integer;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "municipality_name" text;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "details_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "details_wanted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "listings_amenities_idx" ON "realestate"."listings" USING gin ("amenities");--> statement-breakpoint
CREATE INDEX "listings_details_wanted_idx" ON "realestate"."listings" USING btree ("source_id","details_wanted_at") WHERE "realestate"."listings"."details_read_at" is null;--> statement-breakpoint
-- create or replace, not drop and create: the fourteen new columns are added at
-- the end, so the existing columns and the grant to scraplify_public stay (as
-- 0042 and 0044). The coordinates and details_wanted_at stay out of the view.
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
      "realestate"."listings"."price_per_m2_gel" as price_per_m2_gel,
      "realestate"."listings"."building_status" as building_status,
      "realestate"."listings"."condition" as condition,
      "realestate"."listings"."project" as project,
      "realestate"."listings"."floor_type" as floor_type,
      "realestate"."listings"."bathrooms" as bathrooms,
      "realestate"."listings"."balconies" as balconies,
      "realestate"."listings"."kitchen_area" as kitchen_area,
      "realestate"."listings"."house_area" as house_area,
      "realestate"."listings"."yard_area" as yard_area,
      "realestate"."listings"."poster_entity" as poster_entity,
      "realestate"."listings"."amenities" as amenities,
      "realestate"."listings"."municipality_ref" as municipality_ref,
      "realestate"."listings"."municipality_name" as municipality_name,
      "realestate"."listings"."details_read_at" as details_read_at
    from "realestate"."listings"
    where "realestate"."listings"."status" = 'active'
  );