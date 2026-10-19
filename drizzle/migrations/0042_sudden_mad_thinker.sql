CREATE TABLE "realestate"."listing_groups" (
	"group_key" text PRIMARY KEY NOT NULL,
	"member_count" integer NOT NULL,
	"formed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "listings_group_key_idx" ON "realestate"."listings" USING btree ("group_key");--> statement-breakpoint
-- create or replace, not drop and create: group_key is added at the end, so the
-- existing columns and the grant to scraplify_public stay.
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
      "realestate"."listings"."group_key" as group_key
    from "realestate"."listings"
    where "realestate"."listings"."status" = 'active'
  );