-- Phase 17A: permanent real-estate history (docs/PHASE_17_PLAN.md). New tables in
-- realestate_archive only: each listing's versions, its spells on show, its look-alike
-- groups by night, one row per nightly history step, and the archive's private part
-- (pin, description, cadastral code), plus a view of each crawl run's quality. Nothing
-- on the live realestate.listings table changes. The archive gains three nullable
-- columns, so no table is rewritten; recently_gone is replaced with CREATE OR REPLACE,
-- not dropped (drizzle-kit wrote DROP and CREATE): every old column keeps its name, type
-- and order and the new ones are appended, so scraplify_public keeps its grant. Grants
-- on the new tables (scraplify_worker writes; scraplify_public reads all but
-- listing_private and history_steps) come from deploy/apply-db-roles.sh grants, run
-- after this migration. A lock held by a long read makes this fail in 10 s instead of
-- queuing every reader behind it; deploy outside the ss.ge crawl.
SET lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE "realestate_archive"."listing_private" (
	"listing_id" uuid PRIMARY KEY NOT NULL,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"pin_manual" boolean,
	"description" text,
	"cadastral_code" text
);
--> statement-breakpoint
CREATE TABLE "realestate_archive"."history_steps" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "realestate_archive"."history_steps_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_id" uuid NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"crawl_run_id" uuid,
	"versions_opened" integer DEFAULT 0 NOT NULL,
	"versions_closed" integer DEFAULT 0 NOT NULL,
	"spells_opened" integer DEFAULT 0 NOT NULL,
	"spells_closed" integer DEFAULT 0 NOT NULL,
	"group_days" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "realestate_archive"."listing_group_days" (
	"listing_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"group_key" text NOT NULL,
	"first_day" date NOT NULL,
	"last_day" date NOT NULL,
	"nights" integer NOT NULL,
	CONSTRAINT "listing_group_days_pk" PRIMARY KEY("listing_id","group_key")
);
--> statement-breakpoint
CREATE TABLE "realestate_archive"."listing_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "realestate_archive"."listing_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"listing_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"source_listing_key" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"version_hash" text NOT NULL,
	"approximate" boolean DEFAULT false NOT NULL,
	"deal_type" "realestate"."deal_type" NOT NULL,
	"property_type" "realestate"."property_type" NOT NULL,
	"commercial_type" smallint,
	"land_type" smallint,
	"rooms" smallint,
	"bedrooms" smallint,
	"area_m2" numeric(10, 2),
	"floor" smallint,
	"total_floors" smallint,
	"floor_low" smallint,
	"floor_high" smallint,
	"currency_posted" "realestate"."currency",
	"price_posted" numeric(14, 2),
	"price_usd" numeric(14, 2),
	"price_gel" numeric(14, 2),
	"city_ref" integer,
	"city_name" text,
	"district_ref" integer,
	"district_name" text,
	"subdistrict_ref" integer,
	"subdistrict_name" text,
	"municipality_ref" integer,
	"municipality_name" text,
	"street_ref" integer,
	"street_name" text,
	"street_number" text,
	"house_number" integer,
	"house_suffix" text,
	"condition" text,
	"building_status" text,
	"poster_type" "realestate"."poster_type" NOT NULL,
	"poster_entity" text,
	"similarity_group" text,
	"promoted" boolean NOT NULL,
	"status" "realestate"."listing_status" NOT NULL,
	"source_created_at" timestamp with time zone,
	CONSTRAINT "listing_versions_valid_check" CHECK ("realestate_archive"."listing_versions"."valid_to" is null or "realestate_archive"."listing_versions"."valid_to" >= "realestate_archive"."listing_versions"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "realestate_archive"."show_spells" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "realestate_archive"."show_spells_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"listing_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"source_listing_key" text NOT NULL,
	"shown_from" timestamp with time zone NOT NULL,
	"shown_until" timestamp with time zone,
	"group_key" text,
	CONSTRAINT "show_spells_valid_check" CHECK ("realestate_archive"."show_spells"."shown_until" is null or "realestate_archive"."show_spells"."shown_until" >= "realestate_archive"."show_spells"."shown_from")
);
--> statement-breakpoint
ALTER TABLE "realestate_archive"."listings" ADD COLUMN "expected_end_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "realestate_archive"."listings" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "realestate_archive"."listings" ADD COLUMN "first_source_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "realestate_archive"."listing_private" ADD CONSTRAINT "listing_private_listing_id_listings_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "realestate_archive"."listings"("listing_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_archive"."history_steps" ADD CONSTRAINT "history_steps_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_archive"."listing_group_days" ADD CONSTRAINT "listing_group_days_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_archive"."listing_versions" ADD CONSTRAINT "listing_versions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_archive"."show_spells" ADD CONSTRAINT "show_spells_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "history_steps_source_idx" ON "realestate_archive"."history_steps" USING btree ("source_id","taken_at");--> statement-breakpoint
CREATE INDEX "listing_group_days_group_idx" ON "realestate_archive"."listing_group_days" USING btree ("group_key");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_versions_open_idx" ON "realestate_archive"."listing_versions" USING btree ("source_id","listing_id") WHERE "realestate_archive"."listing_versions"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "listing_versions_listing_idx" ON "realestate_archive"."listing_versions" USING btree ("listing_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "show_spells_open_idx" ON "realestate_archive"."show_spells" USING btree ("source_id","listing_id") WHERE "realestate_archive"."show_spells"."shown_until" is null;--> statement-breakpoint
CREATE VIEW "realestate_archive"."run_quality" AS (
    select
      runs.id as crawl_run_id,
      runs.source_id as source_id,
      ((coalesce(runs.finished_at, runs.started_at) at time zone 'UTC') + interval '4 hours')::date as day,
      runs.mode as mode,
      runs.status as status,
      runs.started_at as started_at,
      runs.finished_at as finished_at,
      runs.request_count as request_count,
      runs.failed_request_count as failed_request_count,
      runs.page_count as page_count,
      runs.row_count as row_count,
      runs.new_count as new_count,
      runs.changed_count as changed_count,
      runs.gone_count as gone_count,
      runs.details_count as details_count,
      runs.notes as notes,
      (select steps.ok from "realestate_archive"."history_steps" steps
        where steps.crawl_run_id = runs.id
        order by steps.taken_at desc limit 1) as history_ok
    from "realestate"."crawl_runs" runs
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
  false) as "implausible", null::timestamptz as "archived_at", "street_ref" as "street_ref", "house_number" as "house_number", "house_suffix" as "house_suffix", "floor_low" as "floor_low", "floor_high" as "floor_high", "district_inferred" as "district_inferred", "complex_ref" as "complex_ref", "complex_name" as "complex_name", "developer_ref" as "developer_ref", "developer_name" as "developer_name", "official_district_ref" as "official_district_ref", "official_district_basis" as "official_district_basis", "location_precision" as "location_precision", "location_uncertain" as "location_uncertain", "location_flags" as "location_flags", "metro_station" as "metro_station", "metro_minutes" as "metro_minutes", "metro_basis" as "metro_basis", "metro_nearby" as "metro_nearby", "building_key" as "building_key", "location_rules" as "location_rules", "metro_nearby_minutes" as "metro_nearby_minutes", "expected_end_at" as "expected_end_at", "verified_at" as "verified_at", least("realestate"."listings".source_created_at, (
    select min(versions.source_created_at) from realestate_archive.listing_versions versions
     where versions.listing_id = "realestate"."listings".id)) as "first_source_created_at" from "realestate"."listings" where "realestate"."listings"."status" = 'gone');