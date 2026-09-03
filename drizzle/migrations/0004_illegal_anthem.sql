ALTER TABLE "source_listing_revisions" ALTER COLUMN "provenance_resource_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "source_listing_revisions" ALTER COLUMN "provenance_fetched_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "source_listing_revisions" DROP COLUMN "provenance";