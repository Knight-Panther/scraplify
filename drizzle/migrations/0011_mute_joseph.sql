DROP INDEX "crawl_runs_one_running_per_source_idx";--> statement-breakpoint
ALTER TABLE "crawl_runs" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
-- Backfill BEFORE creating the unique index below: every existing row would
-- otherwise get reconciled_at = NULL (the column's implicit default), and a
-- source with more than one historical row would make the index creation
-- itself fail outright on the duplicate NULL keys — or, with exactly one
-- historical row, silently leave that source permanently locked against any
-- future crawl. Any row already in a terminal (non-'running') state settled
-- before this column existed, so finished_at is the correct settled time to
-- backfill; a genuinely 'running' row is left untouched (reconciled_at stays
-- NULL), since it may still be legitimately in progress.
UPDATE "crawl_runs" SET "reconciled_at" = "finished_at" WHERE "status" != 'running' AND "finished_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "crawl_runs_one_unsettled_per_source_idx" ON "crawl_runs" USING btree ("source_id") WHERE "crawl_runs"."reconciled_at" is null;