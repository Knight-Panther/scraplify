---
name: refresh-corpus
description: Bring the real corpus up to date by hand in the one order that leaves it consistent — build, crawl (with its chained dedupe pass), re-rank every profile, then verify with counts — pausing for confirmation before anything touches the live sites or writes to the real database.
disable-model-invocation: true
---

# Refresh the corpus

The pipeline's steps are only correct **in order**, and each skipped step has
already failed silently once in this repo:

- Crawl without dedupe → new listings exist only in the raw `/listings` view.
  That is the 2026-09-15 incident (`docs/STATUS.md`): 3,277 active hr.ge
  listings had no canonical opportunity for nine days.
- Dedupe without re-ranking → the ranked screen goes empty, because every
  stored ranking is pinned to a canonical revision the dedupe pass superseded
  and `listRankedOpportunities` refuses those by design (Phase 3B Stage 8 record).
- Build skipped → the crawl runs yesterday's `dist/`, not the code on disk.

This is the **manual** path. The scheduled path is `scripts/register-crawl-schedule.ps1`,
and registering that remains a deliberate step the project owner runs — this
skill never registers or modifies a scheduled task.

Every command below writes to the real `scraplify` database and/or sends
requests to jobs.ge and hr.ge. None of it runs against `scraplify_qa`.

## Steps

1. **Preflight (read-only, no confirmation needed).**
   - **Verify this is actually the real corpus before anything else.** Run
     `select current_database()` through the Postgres MCP, **and separately**
     `node --env-file=.env -e "console.log(new URL(process.env.DATABASE_URL).pathname.slice(1))"`
     for the CLI's own resolved connection — both must print `scraplify`, not
     `scraplify_qa`. A process-level `DATABASE_URL` overrides `.env`
     (README.md), so the MCP connection and the CLI's resolved connection can
     legitimately point at different databases even when nothing else here
     looks unusual. **Abort and report if either one isn't `scraplify`** — do
     not crawl, dedupe, or rank against the wrong database while believing
     it's the real one.
   - `git status --short` — report uncommitted changes, since they will be
     compiled into the build that crawls.
   - Confirm Docker/Postgres is up (the Postgres MCP `list_schemas` call is enough).
   - Record the **before** counts with the query in step 6, so the report
     can show deltas rather than bare totals — and so step 4 knows whether a
     backlog already existed before this run touched anything.
   - Check the last run per source (`crawl_runs`: `status`, `started_at`,
     `full_coverage`) and any cooldown in `crawl_cursors.next_fetch_at`. A
     source still inside a rate-limit cooldown records a partial run
     without making requests; say so rather than crawling it anyway.

2. **Confirm scope with the user — stop here and ask.** Which sources
   (`jobs-ge`, `hr-ge`, or both), and full or incremental. A full hr.ge sweep
   is thousands of detail fetches and takes a long time; say that plainly.
   Do not assume "both, full."

3. **Build.** `npm run build`. Stop on any failure — never crawl with a stale `dist/`.

4. **Crawl + dedupe + taxonomy, one source at a time, never in parallel.**
   - **Skip a source outright if step 1 found an unreconciled `crawl_runs`
     row for it.** Don't invoke the wrapper anyway expecting it to handle
     this: `run-crawl.ps1` proceeds to dedupe and taxonomy even after its own
     `CrawlAlreadyRunningError`, which would then run against a corpus the
     other, still-live crawl is actively still changing — its eventual
     settlement can invalidate the rankings this same refresh just produced.
     Report the unreconciled run and move to the next source (or stop, if
     that was the only one requested).
   - **Full mode (same path the schedule uses):**
     `powershell -NoProfile -File scripts/run-crawl.ps1 -Source <source>`.
     It chains `run-dedupe --auto-link` then `backfill-taxonomy` after every
     crawl attempt, including a failed one, and folds either failure into its
     exit code. Output goes to `logs/<source>-crawl-<date>.log`, not the
     terminal. Read the tail of that log afterwards.
   - **Incremental mode** (the wrapper passes no crawl flags):
     `npm run crawl:<source> -- --mode=incremental --pages=<n>`, **then
     always** `npm run dedupe -- --auto-link` and `npm run taxonomy:backfill`
     — even if the crawl step itself exited non-zero. A crawl that fails
     partway through has still written whatever it discovered before failing
     (listings are stored as they're found, not held back for one commit at
     the end of the run — the 2026-09-15 incident above is itself evidence:
     those listings existed for days from ordinary crawls before anyone ran
     dedupe against them), and those rows need the same dedupe +
     classification pass a fully successful run gets, or they sit
     unlinked/uncategorized in exactly that shape. **Only skip dedupe/
     taxonomy if BOTH the crawl step wrote nothing at all (check its own
     reported discovered/new count) AND step 1's before-count already showed
     zero `active_unlinked` for this source** — a zero-write crawl does not
     mean there is nothing to repair if an earlier failed or manual crawl
     already left a backlog sitting there. When in doubt, run dedupe and
     taxonomy anyway: both are safe to run against an already-clean corpus.
   - After dedupe and taxonomy have run for a source (success or failure),
     **re-rank now (step 5), before deciding anything else.** A non-zero exit
     from the crawl itself still stops the sequence there — but only after
     ranking reflects the dedupe pass that already ran. Skipping straight to
     "ask before continuing" leaves rankings pinned to canonical revisions
     dedupe just superseded, which `listRankedOpportunities` refuses by
     design (Phase 3B Stage 8) — if the operator then declines to continue,
     that stale/empty ranked view is where the refresh stops, not a
     transient mid-sequence state. Then ask before continuing to the next
     source. Never "retry until green": a rate-limit or block response means
     stop (README, Politeness).

5. **Re-rank every profile.** `npm run rank -- profile:list`, then for each id
   `npm run rank -- rank --profile <id>`. Skip only if there are zero
   profiles, and say so. Invoked from step 4 after every source's dedupe —
   running it again here (after the last source, or as the only re-rank if
   step 4 never reached it) is cheap and always safe against an
   already-current corpus, so treat this as "make sure it ran," not "run it
   a second time regardless."

6. **Verify with real counts (Postgres MCP, read-only), before vs after.**
   ```sql
   select s.slug,
          count(*) filter (where sl.status = 'active') as active,
          count(*) filter (where sl.status = 'active' and not exists (
            select 1 from opportunity_source_memberships m
            where m.source_listing_id = sl.id and m.superseded_at is null
          )) as active_unlinked
   from source_listings sl join sources s on s.id = sl.source_id
   group by s.slug order by s.slug;
   ```
   `active_unlinked` should be **0** after a successful dedupe. Anything
   else is the 2026-09-15 incident signature and must be reported as a
   failure, not a footnote. If `npm run health:check` exists by then (Phase
   7A Stage 7-2), run it too and report its exit code.

7. **Report.** Per source: crawl exit, dedupe exit, listings before → after,
   unlinked count, rankings produced per profile, plus anything from the logs
   that looks like a guard downgrade or a new `parser_incidents` row. Do not
   update `docs/STATUS.md` unless the user asks. A routine refresh is not a
   phase-status change.
