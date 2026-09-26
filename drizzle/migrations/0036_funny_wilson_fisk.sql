CREATE VIEW "public"."public_crawl_status" AS (
  select
    "sources"."slug" as source_slug,
    latest.started_at as last_run_started_at,
    latest.status as last_run_status,
    completed.finished_at as last_completed_at
  from "sources"
  left join lateral (
    select "crawl_runs"."started_at" as started_at, "crawl_runs"."status" as status
    from "crawl_runs"
    where "crawl_runs"."source_id" = "sources"."id"
    order by "crawl_runs"."started_at" desc
    limit 1
  ) latest on true
  left join lateral (
    select "crawl_runs"."finished_at" as finished_at
    from "crawl_runs"
    where "crawl_runs"."source_id" = "sources"."id"
      and "crawl_runs"."status" = 'completed'
      and "crawl_runs"."finished_at" is not null
    order by "crawl_runs"."finished_at" desc
    limit 1
  ) completed on true
);