ALTER TABLE "crawl_cursors" ADD COLUMN "next_fetch_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_policies" ADD COLUMN "allowed_hosts" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
-- Backfill only the two recorded source policies; unknown policies stay fail-closed.
UPDATE "source_policies" SET "allowed_hosts" = '["www.jobs.ge"]'::jsonb
WHERE "source_id" = '8c3b7cbf-159a-4e13-9d9f-1b50597e4ae9';
--> statement-breakpoint
UPDATE "source_policies" SET "allowed_hosts" = '["www.hr.ge", "api.p.hr.ge"]'::jsonb
WHERE "source_id" = '0c0495e8-0c3c-47a3-9f82-f8509aedf507';
