CREATE TYPE "public"."admin_audit_action" AS ENUM('duplicate_accept', 'duplicate_reject', 'taxonomy_confirm', 'taxonomy_reject', 'taxonomy_undo');--> statement-breakpoint
CREATE TYPE "public"."admin_audit_outcome" AS ENUM('succeeded', 'refused', 'failed');--> statement-breakpoint
CREATE TABLE "admin_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_github_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"action" "admin_audit_action" NOT NULL,
	"outcome" "admin_audit_outcome" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "admin_audit_events_entity_idx" ON "admin_audit_events" USING btree ("entity_type","entity_id");