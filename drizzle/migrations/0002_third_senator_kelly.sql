ALTER TABLE "source_listing_revisions" ADD COLUMN "provenance_resource_id" uuid;--> statement-breakpoint
ALTER TABLE "source_listing_revisions" ADD COLUMN "provenance_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_listing_revisions" ADD COLUMN "provenance_notes" text;--> statement-breakpoint
ALTER TABLE "source_listing_revisions" ADD CONSTRAINT "source_listing_revisions_provenance_resource_id_resources_id_fk" FOREIGN KEY ("provenance_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_listing_revisions_content_idx" ON "source_listing_revisions" USING btree ("source_listing_id","meaningful_content_hash");