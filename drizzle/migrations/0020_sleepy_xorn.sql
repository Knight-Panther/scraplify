CREATE TYPE "public"."classification_method" AS ENUM('deterministic_rule', 'keyword', 'llm_classification', 'human_review');--> statement-breakpoint
CREATE TYPE "public"."taxonomy_axis" AS ENUM('opportunity_type', 'profession', 'functional_area', 'industry', 'seniority', 'employment_type', 'schedule', 'work_mode', 'skill', 'language', 'education', 'location');--> statement-breakpoint
CREATE TABLE "listing_classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_listing_revision_id" uuid NOT NULL,
	"taxonomy_term_id" uuid NOT NULL,
	"axis" "taxonomy_axis" NOT NULL,
	"method" "classification_method" NOT NULL,
	"confidence" double precision NOT NULL,
	"evidence" jsonb NOT NULL,
	"taxonomy_version" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "listing_classifications_revision_term_unique" UNIQUE("source_listing_revision_id","taxonomy_term_id")
);
--> statement-breakpoint
CREATE TABLE "source_taxonomy_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_category_raw" text NOT NULL,
	"taxonomy_term_id" uuid NOT NULL,
	"method" "classification_method" NOT NULL,
	"confidence" double precision,
	"taxonomy_version" text NOT NULL,
	CONSTRAINT "source_taxonomy_mappings_source_raw_unique" UNIQUE("source_id","source_category_raw")
);
--> statement-breakpoint
CREATE TABLE "taxonomy_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"axis" "taxonomy_axis" NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"taxonomy_version" text NOT NULL,
	"parent_id" uuid,
	CONSTRAINT "taxonomy_terms_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "listing_classifications" ADD CONSTRAINT "listing_classifications_source_listing_revision_id_source_listing_revisions_id_fk" FOREIGN KEY ("source_listing_revision_id") REFERENCES "public"."source_listing_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_classifications" ADD CONSTRAINT "listing_classifications_taxonomy_term_id_taxonomy_terms_id_fk" FOREIGN KEY ("taxonomy_term_id") REFERENCES "public"."taxonomy_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_taxonomy_mappings" ADD CONSTRAINT "source_taxonomy_mappings_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_taxonomy_mappings" ADD CONSTRAINT "source_taxonomy_mappings_taxonomy_term_id_taxonomy_terms_id_fk" FOREIGN KEY ("taxonomy_term_id") REFERENCES "public"."taxonomy_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_terms" ADD CONSTRAINT "taxonomy_terms_parent_id_taxonomy_terms_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."taxonomy_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_classifications_term_idx" ON "listing_classifications" USING btree ("taxonomy_term_id");--> statement-breakpoint
CREATE INDEX "listing_classifications_confidence_idx" ON "listing_classifications" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX "source_taxonomy_mappings_term_idx" ON "source_taxonomy_mappings" USING btree ("taxonomy_term_id");--> statement-breakpoint
CREATE INDEX "taxonomy_terms_parent_idx" ON "taxonomy_terms" USING btree ("parent_id");