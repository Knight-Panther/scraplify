CREATE TYPE "public"."dedupe_decided_by" AS ENUM('ruleset', 'model', 'human');--> statement-breakpoint
CREATE TYPE "public"."dedupe_decision" AS ENUM('confirmed_same', 'probable_same', 'needs_review', 'distinct');--> statement-breakpoint
CREATE TYPE "public"."duplicate_candidate_status" AS ENUM('pending', 'evaluated');--> statement-breakpoint
CREATE TYPE "public"."duplicate_generation_method" AS ENUM('pg_trgm', 'deterministic_match', 'other');--> statement-breakpoint
CREATE TYPE "public"."opportunity_type" AS ENUM('job', 'summer_school', 'scholarship', 'grant', 'event');--> statement-breakpoint
CREATE TYPE "public"."organization_alias_evidence" AS ENUM('source_display_name', 'domain_match', 'contact_match', 'reviewed');--> statement-breakpoint
CREATE TYPE "public"."organization_kind" AS ENUM('employer', 'staffing_agency');--> statement-breakpoint
CREATE TABLE "duplicate_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_listing_id_a" uuid NOT NULL,
	"source_listing_id_b" uuid NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"generation_method" "duplicate_generation_method" NOT NULL,
	"similarity_score" double precision NOT NULL,
	"status" "duplicate_candidate_status" NOT NULL,
	"resulting_decision" "dedupe_decision",
	CONSTRAINT "duplicate_candidates_pair_unique" UNIQUE("source_listing_id_a","source_listing_id_b")
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "opportunity_type" NOT NULL,
	"canonical_title" text NOT NULL,
	"organization_id" uuid,
	"canonical_status" "source_listing_status" NOT NULL,
	"current_canonical_revision_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"canonical_title" text NOT NULL,
	"canonical_status" "source_listing_status" NOT NULL,
	"organization_id" uuid,
	"resolved_fields" jsonb NOT NULL,
	"source_membership_versions" jsonb NOT NULL,
	"resolution_ruleset_version" text NOT NULL,
	"meaningful_content_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "opportunity_revisions_opportunity_id_id_unique" UNIQUE("opportunity_id","id")
);
--> statement-breakpoint
CREATE TABLE "opportunity_source_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"source_listing_id" uuid NOT NULL,
	"decision" "dedupe_decision" NOT NULL,
	"confidence" double precision NOT NULL,
	"evidence" jsonb NOT NULL,
	"decided_by" "dedupe_decided_by" NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"dedupe_model_or_ruleset_version" text NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organization_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"raw_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"evidence_type" "organization_alias_evidence" NOT NULL,
	"source_listing_id" uuid,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"normalizer_version" text NOT NULL,
	"kind" "organization_kind" NOT NULL,
	"domain" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_source_listing_id_a_source_listings_id_fk" FOREIGN KEY ("source_listing_id_a") REFERENCES "public"."source_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_source_listing_id_b_source_listings_id_fk" FOREIGN KEY ("source_listing_id_b") REFERENCES "public"."source_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_current_revision_ownership_fk" FOREIGN KEY ("id","current_canonical_revision_id") REFERENCES "public"."opportunity_revisions"("opportunity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_revisions" ADD CONSTRAINT "opportunity_revisions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_revisions" ADD CONSTRAINT "opportunity_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_source_memberships" ADD CONSTRAINT "opportunity_source_memberships_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_source_memberships" ADD CONSTRAINT "opportunity_source_memberships_source_listing_id_source_listings_id_fk" FOREIGN KEY ("source_listing_id") REFERENCES "public"."source_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_aliases" ADD CONSTRAINT "organization_aliases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_aliases" ADD CONSTRAINT "organization_aliases_source_listing_id_source_listings_id_fk" FOREIGN KEY ("source_listing_id") REFERENCES "public"."source_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "duplicate_candidates_status_idx" ON "duplicate_candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "opportunities_organization_idx" ON "opportunities" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_source_memberships_one_live_per_listing_idx" ON "opportunity_source_memberships" USING btree ("source_listing_id") WHERE "opportunity_source_memberships"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "opportunity_source_memberships_opportunity_idx" ON "opportunity_source_memberships" USING btree ("opportunity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_aliases_org_raw_name_idx" ON "organization_aliases" USING btree ("organization_id","raw_name");--> statement-breakpoint
CREATE INDEX "organizations_normalized_name_idx" ON "organizations" USING btree ("normalized_name","normalizer_version");