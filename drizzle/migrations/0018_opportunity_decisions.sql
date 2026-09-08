CREATE TYPE "public"."opportunity_decision" AS ENUM('saved', 'dismissed');--> statement-breakpoint
CREATE TABLE "opportunity_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"decision" "opportunity_decision" NOT NULL,
	"note" text,
	"decided_at" timestamp with time zone NOT NULL,
	"first_decided_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opportunity_decisions" ADD CONSTRAINT "opportunity_decisions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_decisions_opportunity_id_unique" ON "opportunity_decisions" USING btree ("opportunity_id");