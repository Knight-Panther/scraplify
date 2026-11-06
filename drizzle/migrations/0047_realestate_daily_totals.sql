-- Phase 13D: what was on the market each day (contract C3, docs/hermes-contracts.md),
-- taken after each night's ss.ge run. One new table in realestate_archive; nothing
-- else changes. Grants (scraplify_worker takes the totals, scraplify_public reads
-- them) come from deploy/apply-db-roles.sh grants, run after this migration.
CREATE TABLE "realestate_archive"."daily_totals" (
	"day" date NOT NULL,
	"area_level" text NOT NULL,
	"area_ref" integer NOT NULL,
	"area_name" text,
	"deal_type" "realestate"."deal_type" NOT NULL,
	"property_type" "realestate"."property_type" NOT NULL,
	"rooms_band" text NOT NULL,
	"listings" integer NOT NULL,
	"posts" integer NOT NULL,
	"with_details" integer NOT NULL,
	"price_usd_p25" numeric(14, 2),
	"price_usd_median" numeric(14, 2),
	"price_usd_p75" numeric(14, 2),
	"price_per_m2_usd_median" numeric(12, 2),
	"price_gel_median" numeric(14, 2),
	"price_per_m2_gel_median" numeric(12, 2),
	"area_m2_median" numeric(10, 2),
	"taken_at" timestamp with time zone NOT NULL,
	"crawl_run_id" uuid,
	"rules_version" smallint NOT NULL,
	CONSTRAINT "daily_totals_pk" PRIMARY KEY("day","area_level","area_ref","deal_type","property_type","rooms_band"),
	CONSTRAINT "daily_totals_area_level_check" CHECK ("realestate_archive"."daily_totals"."area_level" in ('all', 'city', 'district', 'subdistrict')),
	CONSTRAINT "daily_totals_rooms_band_check" CHECK ("realestate_archive"."daily_totals"."rooms_band" in ('all', '1', '2', '3', '4', '5+'))
);
