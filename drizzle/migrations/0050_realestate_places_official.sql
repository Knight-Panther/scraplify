-- Phase 14B: Tbilisi's official map, English names and Hermes's place catalogue
-- (contract C6, docs/STATUS.md). `places` only gains columns that are nullable or have a
-- constant default, so it is not rewritten, and its two level checks are replaced by wider
-- ones (a few thousand rows, re-checked at once). The view is new, so nothing reads it yet.
-- A lock held by a long read makes this fail in 10 s instead of queuing every reader
-- behind it; deploy outside the ss.ge crawl (13:30-21:30 UTC).
SET lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "realestate"."places" DROP CONSTRAINT "places_level_check";--> statement-breakpoint
ALTER TABLE "realestate"."places" DROP CONSTRAINT "places_parent_level_check";--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD COLUMN "origin" text DEFAULT 'ss.ge' NOT NULL;--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD COLUMN "name_en" text;--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD COLUMN "match_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD COLUMN "official_district_ref" integer;--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD COLUMN "official_basis" text;--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD COLUMN "official_shares" jsonb;--> statement-breakpoint
CREATE INDEX "places_match_keys_idx" ON "realestate"."places" USING gin ("match_keys");--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD CONSTRAINT "places_origin_check" CHECK ("realestate"."places"."origin" in ('ss.ge', 'osm', 'owner'));--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD CONSTRAINT "places_official_basis_check" CHECK ("realestate"."places"."official_basis" in ('inside', 'border'));--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD CONSTRAINT "places_level_check" CHECK ("realestate"."places"."level" in ('municipality', 'city', 'district', 'subdistrict', 'street', 'official_district', 'metro_station', 'neighbourhood'));--> statement-breakpoint
ALTER TABLE "realestate"."places" ADD CONSTRAINT "places_parent_level_check" CHECK ("realestate"."places"."parent_level" in ('municipality', 'city', 'district', 'subdistrict', 'official_district'));--> statement-breakpoint
CREATE VIEW "realestate"."public_places" AS (
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
      "realestate"."places"."last_seen_at" as last_seen_at
    from "realestate"."places"
  );