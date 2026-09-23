CREATE TYPE "public"."audit_action" AS ENUM('draft_generated', 'draft_edited', 'draft_approved', 'approval_invalidated', 'draft_deleted');--> statement-breakpoint
CREATE TYPE "public"."outreach_approval_invalidation" AS ENUM('edited', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."outreach_draft_kind" AS ENUM('email', 'cover_letter');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" "audit_action" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" "outreach_approval_invalidation"
);
--> statement-breakpoint
CREATE TABLE "outreach_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"opportunity_revision_id" uuid NOT NULL,
	"source_listing_id" uuid NOT NULL,
	"source_listing_revision_id" uuid NOT NULL,
	"kind" "outreach_draft_kind" NOT NULL,
	"recipient" text,
	"subject" text,
	"body" text NOT NULL,
	"language" text NOT NULL,
	"generator" text NOT NULL,
	"claim_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "outreach_approvals" ADD CONSTRAINT "outreach_approvals_draft_id_outreach_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."outreach_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_opportunity_revision_id_opportunity_revisions_id_fk" FOREIGN KEY ("opportunity_revision_id") REFERENCES "public"."opportunity_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_source_listing_id_source_listings_id_fk" FOREIGN KEY ("source_listing_id") REFERENCES "public"."source_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_source_listing_revision_id_source_listing_revisions_id_fk" FOREIGN KEY ("source_listing_revision_id") REFERENCES "public"."source_listing_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_approvals_one_live_per_draft_idx" ON "outreach_approvals" USING btree ("draft_id") WHERE "outreach_approvals"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "outreach_drafts_profile_idx" ON "outreach_drafts" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "outreach_drafts_opportunity_idx" ON "outreach_drafts" USING btree ("opportunity_id");