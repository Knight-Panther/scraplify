CREATE SCHEMA "realestate";
--> statement-breakpoint
CREATE TYPE "realestate"."currency" AS ENUM('gel', 'usd');--> statement-breakpoint
CREATE TYPE "realestate"."deal_type" AS ENUM('sale', 'rent');--> statement-breakpoint
CREATE TYPE "realestate"."listing_status" AS ENUM('active', 'gone');--> statement-breakpoint
CREATE TYPE "realestate"."poster_type" AS ENUM('owner', 'agent', 'developer', 'unknown');--> statement-breakpoint
CREATE TYPE "realestate"."property_type" AS ENUM('flat', 'house', 'cottage');--> statement-breakpoint
CREATE TYPE "realestate"."run_status" AS ENUM('running', 'completed', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "realestate"."crawl_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "realestate"."run_status" DEFAULT 'running' NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"failed_request_count" integer DEFAULT 0 NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"changed_count" integer DEFAULT 0 NOT NULL,
	"bumped_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"reopened_count" integer DEFAULT 0 NOT NULL,
	"gone_count" integer DEFAULT 0 NOT NULL,
	"verified_count" integer DEFAULT 0 NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "realestate"."listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_listing_key" text NOT NULL,
	"canonical_url" text NOT NULL,
	"deal_type" "realestate"."deal_type" NOT NULL,
	"property_type" "realestate"."property_type" NOT NULL,
	"rooms" smallint,
	"bedrooms" smallint,
	"area_m2" numeric(10, 2),
	"floor" smallint,
	"total_floors" smallint,
	"price_gel" numeric(14, 2),
	"price_usd" numeric(14, 2),
	"price_per_m2_usd" numeric(12, 2),
	"currency_posted" "realestate"."currency",
	"city_ref" integer,
	"city_name" text,
	"district_ref" integer,
	"district_name" text,
	"subdistrict_ref" integer,
	"subdistrict_name" text,
	"street_name" text,
	"street_number" text,
	"poster_type" "realestate"."poster_type" DEFAULT 'unknown' NOT NULL,
	"promoted" boolean DEFAULT false NOT NULL,
	"description" text,
	"similarity_group" text,
	"group_key" text,
	"source_updated_at" timestamp with time zone NOT NULL,
	"source_created_at" timestamp with time zone,
	"expected_end_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"status" "realestate"."listing_status" DEFAULT 'active' NOT NULL,
	"gone_at" timestamp with time zone,
	"gone_reason" text,
	"content_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realestate"."price_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"old_price_gel" numeric(14, 2),
	"new_price_gel" numeric(14, 2),
	"old_price_usd" numeric(14, 2),
	"new_price_usd" numeric(14, 2)
);
--> statement-breakpoint
ALTER TABLE "realestate"."crawl_runs" ADD CONSTRAINT "crawl_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate"."listings" ADD CONSTRAINT "listings_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate"."price_changes" ADD CONSTRAINT "price_changes_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "realestate"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crawl_runs_source_started_idx" ON "realestate"."crawl_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_source_key_idx" ON "realestate"."listings" USING btree ("source_id","source_listing_key");--> statement-breakpoint
CREATE INDEX "listings_browse_idx" ON "realestate"."listings" USING btree ("status","deal_type","property_type","city_ref","subdistrict_ref");--> statement-breakpoint
CREATE INDEX "listings_source_updated_idx" ON "realestate"."listings" USING btree ("source_updated_at");--> statement-breakpoint
CREATE INDEX "listings_price_usd_idx" ON "realestate"."listings" USING btree ("price_usd");--> statement-breakpoint
CREATE INDEX "listings_area_idx" ON "realestate"."listings" USING btree ("area_m2");--> statement-breakpoint
CREATE INDEX "listings_expected_end_idx" ON "realestate"."listings" USING btree ("status","expected_end_at");--> statement-breakpoint
CREATE INDEX "price_changes_listing_idx" ON "realestate"."price_changes" USING btree ("listing_id","observed_at");