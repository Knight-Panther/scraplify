CREATE TABLE "crawl_cursors" (
	"source_id" uuid PRIMARY KEY NOT NULL,
	"next_source_record_id" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crawl_cursors" ADD CONSTRAINT "crawl_cursors_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;