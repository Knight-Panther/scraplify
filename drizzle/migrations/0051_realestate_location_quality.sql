-- Phase 14C: location quality (docs/STATUS.md, docs/PHASE_14_PLAN.md 14C).
-- Every column added is nullable or has a constant default, so no table is rewritten.
-- The three checks on realestate.listings are NOT VALID: every existing row has the
-- new columns null, and validating would scan the table under its lock; new and
-- updated rows are checked. The views are replaced with CREATE OR REPLACE, not
-- dropped (drizzle-kit wrote DROP and CREATE): the old columns keep their names,
-- types and order and the new ones are appended, so scraplify_public keeps its
-- grants and Hermes' reads never fail. A lock held by a long read makes this fail
-- in 10 s instead of queuing every reader behind it; deploy outside the ss.ge crawl.
SET lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "official_district_ref" integer;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "official_district_basis" text;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "location_precision" text;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "location_uncertain" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "location_flags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "metro_station" text;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "metro_minutes" smallint;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "metro_basis" text;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "metro_nearby" text[];--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "building_key" text;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "location_rules" smallint;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "pin_trusted" boolean;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "pin_street_m" integer;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "pin_official_district_ref" integer;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD COLUMN "metro_distance_m" integer;--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD COLUMN "located_latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD COLUMN "located_longitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD COLUMN "located_basis" text;--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD COLUMN "located_pins" integer;--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD COLUMN "official_source" text;--> statement-breakpoint
ALTER TABLE "realestate_archive"."listings" ADD COLUMN "official_district_ref" integer;--> statement-breakpoint
ALTER TABLE "realestate_archive"."listings" ADD COLUMN "official_district_basis" text;--> statement-breakpoint
ALTER TABLE "realestate_archive"."listings" ADD COLUMN "location_precision" text;--> statement-breakpoint
ALTER TABLE "realestate_archive"."listings" ADD COLUMN "location_uncertain" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "realestate_archive"."listings" ADD COLUMN "location_flags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "realestate_archive"."listings" ADD COLUMN "metro_station" text;--> statement-breakpoint
ALTER TABLE "realestate_archive"."listings" ADD COLUMN "metro_minutes" smallint;--> statement-breakpoint
ALTER TABLE "realestate_archive"."listings" ADD COLUMN "metro_basis" text;--> statement-breakpoint
ALTER TABLE "realestate_archive"."listings" ADD COLUMN "metro_nearby" text[];--> statement-breakpoint
ALTER TABLE "realestate_archive"."listings" ADD COLUMN "building_key" text;--> statement-breakpoint
ALTER TABLE "realestate_archive"."listings" ADD COLUMN "location_rules" smallint;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD CONSTRAINT "listings_official_district_basis_check" CHECK ("realestate"."listings"."official_district_basis" in ('pin', 'street', 'area')) NOT VALID;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD CONSTRAINT "listings_location_precision_check" CHECK ("realestate"."listings"."location_precision" in ('none', 'municipality', 'city', 'district', 'subdistrict', 'street', 'house', 'pin')) NOT VALID;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD CONSTRAINT "listings_metro_basis_check" CHECK ("realestate"."listings"."metro_basis" in ('pin', 'building', 'street')) NOT VALID;--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD CONSTRAINT "places_located_basis_check" CHECK ("realestate"."places"."located_basis" in ('pins', 'ss.ge'));--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD CONSTRAINT "places_official_source_check" CHECK ("realestate"."places"."official_source" in ('pins', 'ss.ge'));--> statement-breakpoint
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
      "realestate"."listings"."details_read_at" as details_read_at,
      "realestate"."listings"."street_ref" as street_ref,
      "realestate"."listings"."house_number" as house_number,
      "realestate"."listings"."house_suffix" as house_suffix,
      "realestate"."listings"."floor_low" as floor_low,
      "realestate"."listings"."floor_high" as floor_high,
      "realestate"."listings"."district_inferred" as district_inferred,
      "realestate"."listings"."complex_ref" as complex_ref,
      "realestate"."listings"."complex_name" as complex_name,
      "realestate"."listings"."developer_ref" as developer_ref,
      "realestate"."listings"."developer_name" as developer_name,
      "realestate"."listings"."official_district_ref" as official_district_ref,
      "realestate"."listings"."official_district_basis" as official_district_basis,
      "realestate"."listings"."location_precision" as location_precision,
      "realestate"."listings"."location_uncertain" as location_uncertain,
      "realestate"."listings"."location_flags" as location_flags,
      "realestate"."listings"."metro_station" as metro_station,
      "realestate"."listings"."metro_minutes" as metro_minutes,
      "realestate"."listings"."metro_basis" as metro_basis,
      "realestate"."listings"."metro_nearby" as metro_nearby,
      "realestate"."listings"."building_key" as building_key,
      "realestate"."listings"."location_rules" as location_rules
    from "realestate"."listings"
    where "realestate"."listings"."status" = 'active'
  );--> statement-breakpoint
CREATE OR REPLACE VIEW "realestate"."public_places" AS (
    select
      "realestate"."places"."source_id" as source_id,
      "realestate"."places"."level" as level,
      "realestate"."places"."ref" as ref,
      "realestate"."places"."origin" as origin,
      "realestate"."places"."code" as code,
      "realestate"."places"."name_ka" as name_ka,
      "realestate"."places"."name_en" as name_en,
      "realestate"."places"."aliases" as aliases,
      "realestate"."places"."match_keys" as match_keys,
      "realestate"."places"."parent_level" as parent_level,
      "realestate"."places"."parent_ref" as parent_ref,
      "realestate"."places"."latitude" as latitude,
      "realestate"."places"."longitude" as longitude,
      "realestate"."places"."point_status" as point_status,
      "realestate"."places"."official_district_ref" as official_district_ref,
      "realestate"."places"."official_basis" as official_basis,
      "realestate"."places"."official_shares" as official_shares,
      "realestate"."places"."active_listings" as active_listings,
      "realestate"."places"."first_seen_at" as first_seen_at,
      "realestate"."places"."last_seen_at" as last_seen_at,
      "realestate"."places"."name_roman" as name_roman,
      "realestate"."places"."official_source" as official_source
    from "realestate"."places"
  );--> statement-breakpoint
CREATE OR REPLACE VIEW "realestate_archive"."recently_gone" AS (select "id" as "listing_id", "source_id" as "source_id", "source_listing_key" as "source_listing_key", "deal_type" as "deal_type", "property_type" as "property_type", "commercial_type" as "commercial_type", "land_type" as "land_type", "rooms" as "rooms", "bedrooms" as "bedrooms", "area_m2" as "area_m2", "floor" as "floor", "total_floors" as "total_floors", "price_gel" as "price_gel", "price_usd" as "price_usd", "price_per_m2_usd" as "price_per_m2_usd", "price_per_m2_gel" as "price_per_m2_gel", "currency_posted" as "currency_posted", "city_ref" as "city_ref", "city_name" as "city_name", "district_ref" as "district_ref", "district_name" as "district_name", "subdistrict_ref" as "subdistrict_ref", "subdistrict_name" as "subdistrict_name", "municipality_ref" as "municipality_ref", "municipality_name" as "municipality_name", "street_name" as "street_name", "street_number" as "street_number", "poster_type" as "poster_type", "poster_entity" as "poster_entity", "image_count" as "image_count", "has_furniture" as "has_furniture", "has_built_in_kitchen" as "has_built_in_kitchen", "building_status" as "building_status", "condition" as "condition", "project" as "project", "floor_type" as "floor_type", "bathrooms" as "bathrooms", "balconies" as "balconies", "kitchen_area" as "kitchen_area", "house_area" as "house_area", "yard_area" as "yard_area", "amenities" as "amenities", "details_read_at" as "details_read_at", "similarity_group" as "similarity_group", "source_created_at" as "source_created_at", "source_updated_at" as "source_updated_at", "first_seen_at" as "first_seen_at", "last_seen_at" as "last_seen_at", "gone_at" as "gone_at", "gone_reason" as "gone_reason", coalesce(
  "area_m2" < 10
  or ("property_type" <> 'land'
      and "area_m2" > case when "property_type" = 'flat' then 1000 else 10000 end
      and "price_per_m2_usd" < 100)
  or ("deal_type" = 'sale' and "price_usd" < 5000)
  or ("deal_type" = 'pledge' and "price_usd" < 1000)
  or ("deal_type" = 'rent' and ("price_usd" > 50000 or "price_usd" < 50 or "price_usd" >= 200 * "area_m2"))
  or ("deal_type" = 'daily' and ("price_usd" > 5000 or "price_usd" < 5)),
  false) as "implausible", null::timestamptz as "archived_at", "street_ref" as "street_ref", "house_number" as "house_number", "house_suffix" as "house_suffix", "floor_low" as "floor_low", "floor_high" as "floor_high", "district_inferred" as "district_inferred", "complex_ref" as "complex_ref", "complex_name" as "complex_name", "developer_ref" as "developer_ref", "developer_name" as "developer_name", "official_district_ref" as "official_district_ref", "official_district_basis" as "official_district_basis", "location_precision" as "location_precision", "location_uncertain" as "location_uncertain", "location_flags" as "location_flags", "metro_station" as "metro_station", "metro_minutes" as "metro_minutes", "metro_basis" as "metro_basis", "metro_nearby" as "metro_nearby", "building_key" as "building_key", "location_rules" as "location_rules" from "realestate"."listings" where "realestate"."listings"."status" = 'gone');