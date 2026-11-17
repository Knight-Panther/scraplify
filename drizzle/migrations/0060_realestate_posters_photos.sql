-- Phases 17B and 17G: the private poster directory and photo references
-- (docs/PHASE_17_PLAN.md). Two new schemas, realestate_contacts and realestate_media,
-- each holding new tables only; nothing existing changes. Private by owner decision
-- (2026-11-17): deploy/apply-db-roles.sh grants, run after this migration, gives the
-- worker its rights and stops if scraplify_public or scraplify_admin can read either
-- schema. No image is ever stored: realestate_media keeps photo paths only. The foreign
-- keys to public.sources take a short lock on it; a lock held by a long read makes this
-- fail in 10 s instead of queuing every reader behind it.
SET lock_timeout = '10s';--> statement-breakpoint
CREATE SCHEMA "realestate_contacts";
--> statement-breakpoint
CREATE SCHEMA "realestate_media";
--> statement-breakpoint
CREATE TABLE "realestate_contacts"."account_contacts" (
	"account_id" bigint NOT NULL,
	"contact_id" bigint NOT NULL,
	"seen_in" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_contacts_pk" PRIMARY KEY("account_id","contact_id","seen_in"),
	CONSTRAINT "account_contacts_seen_in_check" CHECK ("realestate_contacts"."account_contacts"."seen_in" in ('listing_page', 'description', 'row'))
);
--> statement-breakpoint
CREATE TABLE "realestate_contacts"."contacts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "realestate_contacts"."contacts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"account_count" integer DEFAULT 0 NOT NULL,
	"merge_blocked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "contacts_kind_check" CHECK ("realestate_contacts"."contacts"."kind" in ('phone', 'email'))
);
--> statement-breakpoint
CREATE TABLE "realestate_contacts"."listing_contacts" (
	"source_id" uuid NOT NULL,
	"source_listing_key" text NOT NULL,
	"contact_id" bigint NOT NULL,
	"contact_name" text DEFAULT '' NOT NULL,
	"seen_in" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "listing_contacts_pk" PRIMARY KEY("source_id","source_listing_key","contact_id","contact_name","seen_in"),
	CONSTRAINT "listing_contacts_seen_in_check" CHECK ("realestate_contacts"."listing_contacts"."seen_in" in ('listing_page', 'description', 'row'))
);
--> statement-breakpoint
CREATE TABLE "realestate_contacts"."listing_posters" (
	"source_id" uuid NOT NULL,
	"source_listing_key" text NOT NULL,
	"account_id" bigint NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "listing_posters_pk" PRIMARY KEY("source_id","source_listing_key","account_id")
);
--> statement-breakpoint
CREATE TABLE "realestate_contacts"."poster_accounts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "realestate_contacts"."poster_accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_id" uuid NOT NULL,
	"source_user_id" text NOT NULL,
	"display_name" text,
	"contact_name" text,
	"user_type" smallint,
	"entity_type" text,
	"listing_count" integer,
	"agency_ref" integer,
	"agency_name" text,
	"company_ref" integer,
	"company_name" text,
	"company_type" smallint,
	"agent_info_type" smallint,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realestate_contacts"."poster_daily" (
	"source_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"day" date NOT NULL,
	"listings_on_show" integer NOT NULL,
	"new_listings" integer NOT NULL,
	"distinct_groups" integer NOT NULL,
	CONSTRAINT "poster_daily_pk" PRIMARY KEY("source_id","entity_id","day")
);
--> statement-breakpoint
CREATE TABLE "realestate_contacts"."poster_entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rule_version" smallint NOT NULL,
	"account_count" integer NOT NULL,
	"first_built_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "realestate_contacts"."poster_entity_members" (
	"account_id" bigint PRIMARY KEY NOT NULL,
	"entity_id" uuid NOT NULL,
	"rule_version" smallint NOT NULL,
	"since" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realestate_contacts"."poster_entity_overrides" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "realestate_contacts"."poster_entity_overrides_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"account_id" bigint,
	"other_account_id" bigint,
	"contact_id" bigint,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poster_entity_overrides_shape_check" CHECK (("realestate_contacts"."poster_entity_overrides"."kind" = 'merge' and "realestate_contacts"."poster_entity_overrides"."account_id" is not null and "realestate_contacts"."poster_entity_overrides"."other_account_id" is not null and "realestate_contacts"."poster_entity_overrides"."contact_id" is null)
        or ("realestate_contacts"."poster_entity_overrides"."kind" = 'split' and "realestate_contacts"."poster_entity_overrides"."other_account_id" is null and ("realestate_contacts"."poster_entity_overrides"."account_id" is not null or "realestate_contacts"."poster_entity_overrides"."contact_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "realestate_contacts"."poster_steps" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "realestate_contacts"."poster_steps_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_id" uuid NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"crawl_run_id" uuid,
	"rule_version" smallint NOT NULL,
	"links_written" integer DEFAULT 0 NOT NULL,
	"accounts" integer DEFAULT 0 NOT NULL,
	"entities" integer DEFAULT 0 NOT NULL,
	"members_changed" integer DEFAULT 0 NOT NULL,
	"contacts_flagged" integer DEFAULT 0 NOT NULL,
	"daily_rows" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "realestate_media"."listing_photo_refs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "realestate_media"."listing_photo_refs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_id" uuid NOT NULL,
	"source_listing_key" text NOT NULL,
	"origin" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"refs" text[] NOT NULL,
	"main_ref" text,
	"image_count" smallint,
	"set_hash" text NOT NULL,
	CONSTRAINT "listing_photo_refs_origin_check" CHECK ("realestate_media"."listing_photo_refs"."origin" in ('row', 'listing_page')),
	CONSTRAINT "listing_photo_refs_valid_check" CHECK ("realestate_media"."listing_photo_refs"."valid_to" is null or "realestate_media"."listing_photo_refs"."valid_to" >= "realestate_media"."listing_photo_refs"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "realestate_media"."photo_refs" (
	"source_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"first_listing_key" text NOT NULL,
	"upload_day" date,
	"is_360" boolean,
	"image_type" smallint,
	CONSTRAINT "photo_refs_pk" PRIMARY KEY("source_id","ref")
);
--> statement-breakpoint
ALTER TABLE "realestate_contacts"."account_contacts" ADD CONSTRAINT "account_contacts_account_id_poster_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "realestate_contacts"."poster_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_contacts"."account_contacts" ADD CONSTRAINT "account_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "realestate_contacts"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_contacts"."listing_contacts" ADD CONSTRAINT "listing_contacts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_contacts"."listing_contacts" ADD CONSTRAINT "listing_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "realestate_contacts"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_contacts"."listing_posters" ADD CONSTRAINT "listing_posters_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_contacts"."listing_posters" ADD CONSTRAINT "listing_posters_account_id_poster_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "realestate_contacts"."poster_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_contacts"."poster_accounts" ADD CONSTRAINT "poster_accounts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_contacts"."poster_daily" ADD CONSTRAINT "poster_daily_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_contacts"."poster_daily" ADD CONSTRAINT "poster_daily_entity_id_poster_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "realestate_contacts"."poster_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_contacts"."poster_entity_members" ADD CONSTRAINT "poster_entity_members_account_id_poster_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "realestate_contacts"."poster_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_contacts"."poster_entity_members" ADD CONSTRAINT "poster_entity_members_entity_id_poster_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "realestate_contacts"."poster_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_contacts"."poster_entity_overrides" ADD CONSTRAINT "poster_entity_overrides_account_id_poster_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "realestate_contacts"."poster_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_contacts"."poster_entity_overrides" ADD CONSTRAINT "poster_entity_overrides_other_account_id_poster_accounts_id_fk" FOREIGN KEY ("other_account_id") REFERENCES "realestate_contacts"."poster_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_contacts"."poster_entity_overrides" ADD CONSTRAINT "poster_entity_overrides_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "realestate_contacts"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_contacts"."poster_steps" ADD CONSTRAINT "poster_steps_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_media"."listing_photo_refs" ADD CONSTRAINT "listing_photo_refs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realestate_media"."photo_refs" ADD CONSTRAINT "photo_refs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_contacts_contact_idx" ON "realestate_contacts"."account_contacts" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_kind_value_idx" ON "realestate_contacts"."contacts" USING btree ("kind","value");--> statement-breakpoint
CREATE INDEX "listing_contacts_contact_idx" ON "realestate_contacts"."listing_contacts" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "listing_contacts_seen_idx" ON "realestate_contacts"."listing_contacts" USING btree ("source_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "listing_posters_account_idx" ON "realestate_contacts"."listing_posters" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "poster_accounts_source_user_idx" ON "realestate_contacts"."poster_accounts" USING btree ("source_id","source_user_id");--> statement-breakpoint
CREATE INDEX "poster_daily_day_idx" ON "realestate_contacts"."poster_daily" USING btree ("source_id","day");--> statement-breakpoint
CREATE INDEX "poster_entity_members_entity_idx" ON "realestate_contacts"."poster_entity_members" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "poster_steps_source_idx" ON "realestate_contacts"."poster_steps" USING btree ("source_id","taken_at");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_photo_refs_open_idx" ON "realestate_media"."listing_photo_refs" USING btree ("source_id","source_listing_key","origin") WHERE "realestate_media"."listing_photo_refs"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "listing_photo_refs_listing_idx" ON "realestate_media"."listing_photo_refs" USING btree ("source_id","source_listing_key","valid_from");--> statement-breakpoint
CREATE INDEX "listing_photo_refs_refs_idx" ON "realestate_media"."listing_photo_refs" USING gin ("refs");