CREATE TYPE "public"."matching_bundle_build_state" AS ENUM('building', 'verified', 'failed');--> statement-breakpoint
CREATE TYPE "public"."matching_bundle_publication_reason" AS ENUM('build', 'rollback');--> statement-breakpoint
CREATE TABLE "matching_bundle_builds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"schema_version" integer NOT NULL,
	"feature_contract" text NOT NULL,
	"state" "matching_bundle_build_state" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"corpus_watermark" timestamp with time zone,
	"opportunity_count" integer,
	"exclusions" jsonb,
	"artifacts" jsonb,
	"manifest_sha256" text,
	"error_code" text,
	"health_gate_overridden" boolean DEFAULT false NOT NULL,
	"artifacts_removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "matching_bundle_publications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"build_id" uuid NOT NULL,
	"reason" "matching_bundle_publication_reason" NOT NULL,
	"previous_publication_id" uuid,
	"activated_by" text NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "matching_bundle_publications" ADD CONSTRAINT "matching_bundle_publications_build_id_matching_bundle_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."matching_bundle_builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_bundle_publications" ADD CONSTRAINT "matching_bundle_publications_previous_publication_id_matching_bundle_publications_id_fk" FOREIGN KEY ("previous_publication_id") REFERENCES "public"."matching_bundle_publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matching_bundle_builds_channel_started_idx" ON "matching_bundle_builds" USING btree ("channel","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "matching_bundle_publications_one_active_idx" ON "matching_bundle_publications" USING btree ("channel") WHERE "matching_bundle_publications"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "matching_bundle_publications_build_idx" ON "matching_bundle_publications" USING btree ("build_id");--> statement-breakpoint
CREATE VIEW "public"."public_active_matching_bundle" AS (
  select
    "matching_bundle_builds"."id" as build_id,
    "matching_bundle_builds"."schema_version" as schema_version,
    "matching_bundle_builds"."feature_contract" as feature_contract,
    "matching_bundle_builds"."manifest_sha256" as manifest_sha256,
    "matching_bundle_publications"."activated_at" as activated_at
  from "matching_bundle_publications"
  inner join "matching_bundle_builds" on "matching_bundle_builds"."id" = "matching_bundle_publications"."build_id"
  where "matching_bundle_publications"."channel" = 'public'
    and "matching_bundle_publications"."retired_at" is null
    and "matching_bundle_builds"."state" = 'verified'
);