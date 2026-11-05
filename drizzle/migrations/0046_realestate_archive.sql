-- Phase 13A: real-estate history. A new schema, so live listings and history
-- never mix and grants can tell them apart: the archive of deleted listings and
-- their price changes, and a view of the gone listings not yet archived.
-- Additive only: nothing in realestate or public changes. Grants (scraplify_worker
-- writes, scraplify_public reads) come from deploy/apply-db-roles.sh grants, run
-- after this migration.
CREATE SCHEMA "realestate_archive";
--> statement-breakpoint
CREATE TABLE "realestate_archive"."listings" (
	"listing_id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"source_listing_key" text NOT NULL,
	"deal_type" "realestate"."deal_type" NOT NULL,
	"property_type" "realestate"."property_type" NOT NULL,
	"commercial_type" smallint,
	"land_type" smallint,
	"rooms" smallint,
	"bedrooms" smallint,
	"area_m2" numeric(10, 2),
	"floor" smallint,
	"total_floors" smallint,
	"price_gel" numeric(14, 2),
	"price_usd" numeric(14, 2),
	"price_per_m2_usd" numeric(12, 2),
	"price_per_m2_gel" numeric(12, 2),
	"currency_posted" "realestate"."currency",
	"city_ref" integer,
	"city_name" text,
	"district_ref" integer,
	"district_name" text,
	"subdistrict_ref" integer,
	"subdistrict_name" text,
	"municipality_ref" integer,
	"municipality_name" text,
	"street_name" text,
	"street_number" text,
	"poster_type" "realestate"."poster_type" NOT NULL,
	"poster_entity" text,
	"image_count" smallint,
	"has_furniture" boolean,
	"has_built_in_kitchen" boolean,
	"building_status" text,
	"condition" text,
	"project" text,
	"floor_type" text,
	"bathrooms" smallint,
	"balconies" smallint,
	"kitchen_area" numeric(8, 2),
	"house_area" numeric(10, 2),
	"yard_area" numeric(12, 2),
	"amenities" text[] DEFAULT '{}'::text[] NOT NULL,
	"details_read_at" timestamp with time zone,
	"similarity_group" text,
	"source_created_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"gone_at" timestamp with time zone NOT NULL,
	"gone_reason" text,
	"implausible" boolean NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realestate_archive"."price_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"listing_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"old_price_gel" numeric(14, 2),
	"new_price_gel" numeric(14, 2),
	"old_price_usd" numeric(14, 2),
	"new_price_usd" numeric(14, 2)
);
--> statement-breakpoint
ALTER TABLE "realestate_archive"."listings" ADD CONSTRAINT "listings_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_archive"."price_changes" ADD CONSTRAINT "price_changes_listing_id_listings_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "realestate_archive"."listings"("listing_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archive_listings_source_key_idx" ON "realestate_archive"."listings" USING btree ("source_id","source_listing_key");--> statement-breakpoint
CREATE INDEX "archive_listings_gone_idx" ON "realestate_archive"."listings" USING btree ("gone_at");--> statement-breakpoint
CREATE INDEX "archive_price_changes_listing_idx" ON "realestate_archive"."price_changes" USING btree ("listing_id","observed_at");--> statement-breakpoint
CREATE VIEW "realestate_archive"."recently_gone" AS (select "id" as "listing_id", "source_id" as "source_id", "source_listing_key" as "source_listing_key", "deal_type" as "deal_type", "property_type" as "property_type", "commercial_type" as "commercial_type", "land_type" as "land_type", "rooms" as "rooms", "bedrooms" as "bedrooms", "area_m2" as "area_m2", "floor" as "floor", "total_floors" as "total_floors", "price_gel" as "price_gel", "price_usd" as "price_usd", "price_per_m2_usd" as "price_per_m2_usd", "price_per_m2_gel" as "price_per_m2_gel", "currency_posted" as "currency_posted", "city_ref" as "city_ref", "city_name" as "city_name", "district_ref" as "district_ref", "district_name" as "district_name", "subdistrict_ref" as "subdistrict_ref", "subdistrict_name" as "subdistrict_name", "municipality_ref" as "municipality_ref", "municipality_name" as "municipality_name", "street_name" as "street_name", "street_number" as "street_number", "poster_type" as "poster_type", "poster_entity" as "poster_entity", "image_count" as "image_count", "has_furniture" as "has_furniture", "has_built_in_kitchen" as "has_built_in_kitchen", "building_status" as "building_status", "condition" as "condition", "project" as "project", "floor_type" as "floor_type", "bathrooms" as "bathrooms", "balconies" as "balconies", "kitchen_area" as "kitchen_area", "house_area" as "house_area", "yard_area" as "yard_area", "amenities" as "amenities", "details_read_at" as "details_read_at", "similarity_group" as "similarity_group", "source_created_at" as "source_created_at", "source_updated_at" as "source_updated_at", "first_seen_at" as "first_seen_at", "last_seen_at" as "last_seen_at", "gone_at" as "gone_at", "gone_reason" as "gone_reason", coalesce(
  "area_m2" < 10
  or ("property_type" <> 'land'
      and "area_m2" > case when "property_type" = 'flat' then 1000 else 10000 end
      and "price_per_m2_usd" < 100)
  or ("deal_type" = 'sale' and "price_usd" < 5000)
  or ("deal_type" = 'pledge' and "price_usd" < 1000)
  or ("deal_type" = 'rent' and ("price_usd" > 50000 or "price_usd" < 50))
  or ("deal_type" = 'daily' and ("price_usd" > 5000 or "price_usd" < 5)),
  false) as "implausible", null::timestamptz as "archived_at" from "realestate"."listings" where "realestate"."listings"."status" = 'gone');