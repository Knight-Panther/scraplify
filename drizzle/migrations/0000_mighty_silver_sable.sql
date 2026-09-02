CREATE TYPE "public"."parser_incident_kind" AS ENUM('field_missing', 'count_collapse', 'count_surge', 'access_denied', 'captcha', 'duplicate_spike', 'mass_closure_suspected', 'encoding_error', 'unexpected_mime', 'other');--> statement-breakpoint
CREATE TYPE "public"."parser_incident_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."resource_relationship" AS ENUM('attachment', 'application_link', 'organization_link', 'pagination');--> statement-breakpoint
CREATE TYPE "public"."resource_role" AS ENUM('INDEX', 'OPPORTUNITY', 'ORGANIZATION', 'APPLICATION', 'ATTACHMENT');--> statement-breakpoint
CREATE TYPE "public"."resource_status" AS ENUM('pending', 'fetched', 'quarantined', 'failed');--> statement-breakpoint
CREATE TYPE "public"."crawl_run_status" AS ENUM('running', 'completed', 'failed', 'partial', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."fetch_outcome" AS ENUM('success', 'retry', 'failure', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."extraction_method" AS ENUM('http', 'browser');--> statement-breakpoint
CREATE TYPE "public"."source_listing_status" AS ENUM('discovered', 'active', 'missing_suspected', 'closed', 'expired', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."acquisition_mode" AS ENUM('feed', 'api', 'http', 'browser');--> statement-breakpoint
CREATE TYPE "public"."authentication_scope" AS ENUM('none', 'required');--> statement-breakpoint
CREATE TABLE "parser_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"crawl_run_id" uuid,
	"detected_at" timestamp with time zone NOT NULL,
	"kind" "parser_incident_kind" NOT NULL,
	"severity" "parser_incident_severity" NOT NULL,
	"evidence" jsonb NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "resource_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_resource_id" uuid NOT NULL,
	"child_resource_id" uuid NOT NULL,
	"relationship" "resource_relationship" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"role" "resource_role" NOT NULL,
	"original_url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"final_url" text,
	"status" "resource_status" NOT NULL,
	"fetched_at" timestamp with time zone,
	"content_hash" text,
	"byte_size" integer,
	"mime_type" text
);
--> statement-breakpoint
CREATE TABLE "crawl_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "crawl_run_status" NOT NULL,
	"discovered_count" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"changed_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"missing_count" integer DEFAULT 0 NOT NULL,
	"expired_count" integer DEFAULT 0 NOT NULL,
	"reopened_count" integer DEFAULT 0 NOT NULL,
	"quarantined_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fetch_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crawl_run_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"status_code" integer,
	"duration_ms" integer,
	"outcome" "fetch_outcome" NOT NULL,
	"error_kind" text
);
--> statement-breakpoint
CREATE TABLE "source_listing_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_listing_id" uuid NOT NULL,
	"parser_version" text NOT NULL,
	"extraction_method" "extraction_method" NOT NULL,
	"raw_resource_hash" text NOT NULL,
	"meaningful_content_hash" text NOT NULL,
	"title_raw" text NOT NULL,
	"title_normalized" text NOT NULL,
	"organization_raw" text,
	"description" text NOT NULL,
	"locations" jsonb NOT NULL,
	"salary_raw" text,
	"published_date" jsonb NOT NULL,
	"deadline_date" jsonb NOT NULL,
	"application_method" jsonb,
	"source_categories" jsonb NOT NULL,
	"structured_attributes" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"provenance" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_record_id" text,
	"canonical_source_url" text NOT NULL,
	"current_revision_id" uuid,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"status" "source_listing_status" NOT NULL,
	"missing_streak" integer DEFAULT 0 NOT NULL,
	"source_published_at" timestamp with time zone,
	"source_deadline_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"allowed_acquisition_modes" jsonb NOT NULL,
	"allowed_path_patterns" jsonb NOT NULL,
	"disallowed_path_patterns" jsonb NOT NULL,
	"disallowed_hosts" jsonb NOT NULL,
	"authentication_scope" "authentication_scope" NOT NULL,
	"rate_limit" jsonb NOT NULL,
	"terms_url" text,
	"robots_url" text NOT NULL,
	"retention" jsonb NOT NULL,
	"display" jsonb NOT NULL,
	"linked_resources" jsonb NOT NULL,
	"review_date" timestamp with time zone NOT NULL,
	"evidence" jsonb NOT NULL,
	"notes" text NOT NULL,
	"decision_owner" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"base_url" text NOT NULL,
	CONSTRAINT "sources_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "parser_incidents" ADD CONSTRAINT "parser_incidents_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parser_incidents" ADD CONSTRAINT "parser_incidents_crawl_run_id_crawl_runs_id_fk" FOREIGN KEY ("crawl_run_id") REFERENCES "public"."crawl_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_links" ADD CONSTRAINT "resource_links_parent_resource_id_resources_id_fk" FOREIGN KEY ("parent_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_links" ADD CONSTRAINT "resource_links_child_resource_id_resources_id_fk" FOREIGN KEY ("child_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_runs" ADD CONSTRAINT "crawl_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fetch_attempts" ADD CONSTRAINT "fetch_attempts_crawl_run_id_crawl_runs_id_fk" FOREIGN KEY ("crawl_run_id") REFERENCES "public"."crawl_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fetch_attempts" ADD CONSTRAINT "fetch_attempts_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_listing_revisions" ADD CONSTRAINT "source_listing_revisions_source_listing_id_source_listings_id_fk" FOREIGN KEY ("source_listing_id") REFERENCES "public"."source_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_listings" ADD CONSTRAINT "source_listings_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_policies" ADD CONSTRAINT "source_policies_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;