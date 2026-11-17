-- Phase 17C: jobs' and tenders' status timeline (docs/PHASE_17_PLAN.md). One new
-- table, source_listing_status_events: one row per change of source_listings.status,
-- written by the code that makes the change. Nothing on source_listings changes. The
-- two foreign keys take a short SHARE ROW EXCLUSIVE lock on source_listings and
-- crawl_runs, which waits for a running crawl's writes: deploy outside the 16:10 UTC
-- pipelines, and the lock timeout makes it fail in 10 s instead of queuing writers.
-- Rows for listings that predate this table come from `npm run status-events:backfill`,
-- run once after the release (approximate times, idempotent). Grants
-- (scraplify_worker: SELECT, INSERT; no other role) come from
-- deploy/apply-db-roles.sh grants, run after this migration.
SET lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE "source_listing_status_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "source_listing_status_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_listing_id" uuid NOT NULL,
	"from_status" "source_listing_status",
	"to_status" "source_listing_status" NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"crawl_run_id" uuid,
	"approximate" boolean DEFAULT false NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "source_listing_status_events_change_check" CHECK ("source_listing_status_events"."from_status" is null or "source_listing_status_events"."from_status" <> "source_listing_status_events"."to_status")
);
--> statement-breakpoint
ALTER TABLE "source_listing_status_events" ADD CONSTRAINT "source_listing_status_events_source_listing_id_source_listings_id_fk" FOREIGN KEY ("source_listing_id") REFERENCES "public"."source_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_listing_status_events" ADD CONSTRAINT "source_listing_status_events_crawl_run_id_crawl_runs_id_fk" FOREIGN KEY ("crawl_run_id") REFERENCES "public"."crawl_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_listing_status_events_listing_at_idx" ON "source_listing_status_events" USING btree ("source_listing_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_listing_status_events_first_idx" ON "source_listing_status_events" USING btree ("source_listing_id") WHERE "source_listing_status_events"."from_status" is null;