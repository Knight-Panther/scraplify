ALTER TABLE "realestate"."listings" ADD COLUMN "missed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "listings_missed_idx" ON "realestate"."listings" USING btree ("source_id","missed_at") WHERE "realestate"."listings"."missed_at" is not null;--> statement-breakpoint
-- Price changes that were only the source's currency conversion following the exchange rate: the
-- amount in the currency the listing was posted in did not move (3,979 of 5,440 rows on 2026-10-27).
-- src/realestate/ingest.ts no longer records them.
DELETE FROM "realestate"."price_changes" pc USING "realestate"."listings" l WHERE l."id" = pc."listing_id" AND ((l."currency_posted" = 'usd' AND pc."old_price_usd" IS NOT DISTINCT FROM pc."new_price_usd") OR (l."currency_posted" = 'gel' AND pc."old_price_gel" IS NOT DISTINCT FROM pc."new_price_gel"));
