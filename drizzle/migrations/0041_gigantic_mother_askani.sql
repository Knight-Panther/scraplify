-- create or replace, not drop and create: the columns are unchanged, so the
-- grants on this view (scraplify_public, scraplify_admin) are kept.
CREATE OR REPLACE VIEW "public"."public_crawl_status" AS (
  select
    "sources"."slug" as source_slug,
    latest.started_at as last_run_started_at,
    latest.status as last_run_status,
    completed.finished_at as last_completed_at
  from "sources"
  left join lateral (
    select runs.started_at, runs.status
    from (
      select "crawl_runs"."started_at" as started_at, "crawl_runs"."status" as status
      from "crawl_runs"
      where "crawl_runs"."source_id" = "sources"."id"
      union all
      select "realestate"."crawl_runs"."started_at", "realestate"."crawl_runs"."status"::text::crawl_run_status
      from "realestate"."crawl_runs"
      where "realestate"."crawl_runs"."source_id" = "sources"."id"
    ) runs
    order by runs.started_at desc
    limit 1
  ) latest on true
  left join lateral (
    select runs.finished_at
    from (
      select "crawl_runs"."finished_at" as finished_at
      from "crawl_runs"
      where "crawl_runs"."source_id" = "sources"."id"
        and "crawl_runs"."status" = 'completed'
        and "crawl_runs"."finished_at" is not null
      union all
      select "realestate"."crawl_runs"."finished_at"
      from "realestate"."crawl_runs"
      where "realestate"."crawl_runs"."source_id" = "sources"."id"
        and "realestate"."crawl_runs"."status" = 'completed'
        and "realestate"."crawl_runs"."finished_at" is not null
    ) runs
    order by runs.finished_at desc
    limit 1
  ) completed on true
);