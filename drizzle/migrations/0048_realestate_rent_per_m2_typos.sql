-- A monthly rent of $200 a m² or more is a typo too (src/realestate/plausibility.ts).
-- recently_gone works its `implausible` column out with that rule, so the view is
-- replaced with the new one: CREATE OR REPLACE (drizzle-kit wrote DROP and CREATE),
-- so scraplify_public keeps its grant and Hermes' reads never fail. Same columns,
-- same types, same order. Nothing else changes.
CREATE OR REPLACE VIEW "realestate_archive"."recently_gone" AS (select "id" as "listing_id", "source_id" as "source_id", "source_listing_key" as "source_listing_key", "deal_type" as "deal_type", "property_type" as "property_type", "commercial_type" as "commercial_type", "land_type" as "land_type", "rooms" as "rooms", "bedrooms" as "bedrooms", "area_m2" as "area_m2", "floor" as "floor", "total_floors" as "total_floors", "price_gel" as "price_gel", "price_usd" as "price_usd", "price_per_m2_usd" as "price_per_m2_usd", "price_per_m2_gel" as "price_per_m2_gel", "currency_posted" as "currency_posted", "city_ref" as "city_ref", "city_name" as "city_name", "district_ref" as "district_ref", "district_name" as "district_name", "subdistrict_ref" as "subdistrict_ref", "subdistrict_name" as "subdistrict_name", "municipality_ref" as "municipality_ref", "municipality_name" as "municipality_name", "street_name" as "street_name", "street_number" as "street_number", "poster_type" as "poster_type", "poster_entity" as "poster_entity", "image_count" as "image_count", "has_furniture" as "has_furniture", "has_built_in_kitchen" as "has_built_in_kitchen", "building_status" as "building_status", "condition" as "condition", "project" as "project", "floor_type" as "floor_type", "bathrooms" as "bathrooms", "balconies" as "balconies", "kitchen_area" as "kitchen_area", "house_area" as "house_area", "yard_area" as "yard_area", "amenities" as "amenities", "details_read_at" as "details_read_at", "similarity_group" as "similarity_group", "source_created_at" as "source_created_at", "source_updated_at" as "source_updated_at", "first_seen_at" as "first_seen_at", "last_seen_at" as "last_seen_at", "gone_at" as "gone_at", "gone_reason" as "gone_reason", coalesce(
  "area_m2" < 10
  or ("property_type" <> 'land'
      and "area_m2" > case when "property_type" = 'flat' then 1000 else 10000 end
      and "price_per_m2_usd" < 100)
  or ("deal_type" = 'sale' and "price_usd" < 5000)
  or ("deal_type" = 'pledge' and "price_usd" < 1000)
  or ("deal_type" = 'rent' and ("price_usd" > 50000 or "price_usd" < 50 or "price_usd" >= 200 * "area_m2"))
  or ("deal_type" = 'daily' and ("price_usd" > 5000 or "price_usd" < 5)),
  false) as "implausible", null::timestamptz as "archived_at" from "realestate"."listings" where "realestate"."listings"."status" = 'gone');