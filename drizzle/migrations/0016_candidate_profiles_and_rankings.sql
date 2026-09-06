CREATE TYPE "public"."candidate_claim_kind" AS ENUM('role', 'skill', 'education', 'certification', 'language', 'location_preference', 'work_mode_preference', 'salary_constraint', 'schedule_constraint', 'preferred_profession', 'excluded_profession');--> statement-breakpoint
CREATE TYPE "public"."candidate_claim_origin" AS ENUM('parsed', 'confirmed', 'manual');--> statement-breakpoint
CREATE TABLE "candidate_profile_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"kind" "candidate_claim_kind" NOT NULL,
	"value" text NOT NULL,
	"value_normalized" text NOT NULL,
	"evidence" text,
	"origin" "candidate_claim_origin" NOT NULL,
	"confidence" double precision NOT NULL,
	"years" double precision
);
--> statement-breakpoint
CREATE TABLE "candidate_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rankings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"opportunity_revision_id" uuid,
	"profile_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"evaluation_version" text NOT NULL,
	"score" double precision,
	"eligible" boolean NOT NULL,
	"hard_filter_reasons" jsonb NOT NULL,
	"component_scores" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidate_profile_claims" ADD CONSTRAINT "candidate_profile_claims_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rankings" ADD CONSTRAINT "rankings_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rankings" ADD CONSTRAINT "rankings_opportunity_revision_id_opportunity_revisions_id_fk" FOREIGN KEY ("opportunity_revision_id") REFERENCES "public"."opportunity_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rankings" ADD CONSTRAINT "rankings_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidate_profile_claims_profile_idx" ON "candidate_profile_claims" USING btree ("profile_id","profile_version");--> statement-breakpoint
CREATE INDEX "candidate_profile_claims_kind_idx" ON "candidate_profile_claims" USING btree ("kind","value_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "rankings_cache_key_idx" ON "rankings" USING btree ("opportunity_revision_id","profile_id","profile_version","evaluation_version");--> statement-breakpoint
CREATE INDEX "rankings_profile_score_idx" ON "rankings" USING btree ("profile_id","score");