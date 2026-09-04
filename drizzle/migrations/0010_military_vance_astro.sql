ALTER TABLE "crawl_runs" ADD COLUMN "vip_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crawl_runs" ADD COLUMN "standard_count" integer DEFAULT 0 NOT NULL;