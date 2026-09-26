ALTER TABLE "crawl_runs" ADD COLUMN "skipped_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_listings" ADD COLUMN "discovery_fingerprint" text;--> statement-breakpoint
CREATE INDEX "fetch_attempts_attempted_at_idx" ON "fetch_attempts" USING btree ("attempted_at");--> statement-breakpoint
CREATE INDEX "source_listings_open_by_source_idx" ON "source_listings" USING btree ("source_id") WHERE "source_listings"."status" in ('discovered', 'active', 'missing_suspected');