CREATE TABLE "fx_rates" (
	"currency" text NOT NULL,
	"day" date NOT NULL,
	"valid_from" date NOT NULL,
	"quantity" integer NOT NULL,
	"rate" numeric(14, 6) NOT NULL,
	"gel_per_unit" numeric(18, 10) NOT NULL,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_currency_day_pk" PRIMARY KEY("currency","day"),
	CONSTRAINT "fx_rates_currency_check" CHECK ("fx_rates"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "fx_rates_positive_check" CHECK ("fx_rates"."quantity" > 0 and "fx_rates"."rate" > 0),
	CONSTRAINT "fx_rates_valid_from_check" CHECK ("fx_rates"."valid_from" <= "fx_rates"."day")
);
