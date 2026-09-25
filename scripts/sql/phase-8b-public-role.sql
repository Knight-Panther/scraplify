-- Phase 8B Stage 3: the public database role (concept §30.2).
--
-- This file is NOT run automatically by `npm run db:migrate` and is not
-- meant to be. Creating a role and choosing its password is an operational
-- credential decision outside what this session's sandbox does on anyone's
-- behalf (the same reason every other role stage in docs/STATUS.md's Phase
-- 8B plan is "written here, run and verified by the project owner"). Run
-- this against every database a public-configured process will ever point
-- at — at minimum the real `scraplify` corpus before any public process is
-- deployed against it, and `scraplify_qa` too if you want to browser-QA
-- Stage 4/5/6's public routes against a disposable copy first.
--
-- Prerequisite: drizzle/migrations/0023_goofy_moondragon.sql (Stage 3's own
-- migration, creating public_opportunities and public_opportunity_members),
-- drizzle/migrations/0024_sharp_hammerhead.sql (Stage 4 round 3, adding
-- public_source_listings — the public /listings screen's own raw-listing
-- view, independent of dedupe/membership state), AND
-- drizzle/migrations/0026_lethal_smasher.sql (the description-redaction fix,
-- adversarial review 2026-09-24) must already be applied via
-- `npm run db:migrate` — this script only grants access to views those
-- migrations create.
--
-- RE-RUN WARNING (migration-safety-reviewer, 2026-09-24): `DROP VIEW` +
-- `CREATE VIEW` — how drizzle-kit expresses any future change to one of
-- these three views' own SQL, exactly as 0026 already does — destroys the
-- OLD view object and its grants along with it. A grant to
-- `scraplify_public` issued by an earlier run of this script does NOT carry
-- forward onto the recreated view; Postgres has nothing left to attach it
-- to. If this script has already been run against a database BEFORE a
-- migration that touches one of these views, re-run at minimum the three
-- `GRANT SELECT` statements below (step 3) against that database
-- immediately after applying the migration — do not assume a prior grant
-- still holds. Missing this fails closed (the public process gets
-- "permission denied", not a leak) but is a real functional break, silent
-- until someone notices the public site can no longer read anything.
--
-- Replace <STRONG_PASSWORD_HERE> before running. Do not commit the real
-- password anywhere, and do not paste it into chat — put it straight into
-- the public process's own .env once that env var is named (Stage 4/6).
--
-- Replace <TARGET_DATABASE> with whichever database this run targets
-- (`scraplify` for the real corpus, `scraplify_qa` for a rehearsal) — this
-- script is meant to run against more than one database in the same
-- cluster, per its own instructions above, so the `GRANT CONNECT` below
-- deliberately doesn't hardcode one (Stage 9's worker/admin/migration
-- script established this same pattern; adversarial review, 2026-09-24,
-- flagged this file as the one role script that hadn't caught up to it).
--
-- `CREATE ROLE` is cluster-wide — a role exists once across every database
-- on the server, not per-database — so running this script a second time
-- against a second database in the same cluster (QA rehearsal, then the
-- real target) would otherwise fail outright on "role already exists"
-- before reaching that database's own grants. The `CREATE ROLE` below is
-- wrapped in an `IF NOT EXISTS` check for exactly that reason.
--
-- Wiring, once verified: no code change is needed for this part.
-- src/db/client.ts already just reads DATABASE_URL generically — the same
-- way `npm run dev:web` (the live corpus) and `npm run dev:web:qa` (the
-- disposable copy) already differ only by which env file sets that one
-- variable. A public-configured process is wired in the same way: give
-- IT a DATABASE_URL built from this role, e.g.
-- postgres://scraplify_public:<password>@host:5432/scraplify — never the
-- broader credential every other process today still uses.

-- 1. The role itself. LOGIN because a live process connects as it; nothing
--    else — not SUPERUSER, not CREATEDB, not CREATEROLE, not BYPASSRLS.
--    PostgreSQL denies everything by default to a freshly created role, so
--    every capability it has below is an explicit grant, not an inherited
--    default.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scraplify_public') THEN
    EXECUTE $create$CREATE ROLE scraplify_public LOGIN PASSWORD '<STRONG_PASSWORD_HERE>'$create$;
  END IF;
END $$;

-- 2. Being ABLE to connect and see the schema exists is not the same as
--    being able to read anything in it — these two grants alone expose
--    nothing.
GRANT CONNECT ON DATABASE <TARGET_DATABASE> TO scraplify_public;
GRANT USAGE ON SCHEMA public TO scraplify_public;

-- 3. The entire visible surface: SELECT on these three views, and NOTHING
--    ELSE. No grant follows on any base table (opportunities,
--    source_listings, sources, opportunity_source_memberships, or any
--    other) — PostgreSQL views run with the privileges of their OWNER by
--    default (the role that ran the migration), so scraplify_public needs
--    no direct grant on a base table to read through these views. That is
--    what makes this a real boundary: even a future public-surface query
--    with a bug has nothing to fall back on beyond these three views.
GRANT SELECT ON public.public_opportunities TO scraplify_public;
GRANT SELECT ON public.public_opportunity_members TO scraplify_public;
GRANT SELECT ON public.public_source_listings TO scraplify_public;

-- 4. Verify — do not assume any of the above worked as written.
--
--    a) \du+ scraplify_public
--       Confirm: no Superuser, no Create DB, no Create role, no Bypass RLS.
--
--    b) Connected AS scraplify_public, confirm all three views ARE readable:
--         SELECT count(*) FROM public_opportunities;
--         SELECT count(*) FROM public_opportunity_members;
--         SELECT count(*) FROM public_source_listings;
--
--    c) Connected AS scraplify_public, confirm everything else is NOT —
--       every one of these must fail with "permission denied":
--         SELECT count(*) FROM opportunity_source_memberships;
--         SELECT count(*) FROM opportunity_decisions;      -- the shortlist
--         SELECT count(*) FROM duplicate_candidates;
--         SELECT count(*) FROM candidate_profiles;
--         SELECT count(*) FROM candidate_profile_claims;
--         SELECT count(*) FROM rankings;
--         SELECT count(*) FROM outreach_drafts;
--         SELECT count(*) FROM outreach_approvals;
--         SELECT count(*) FROM audit_events;
--         SELECT count(*) FROM crawl_runs;
--         SELECT count(*) FROM fetch_attempts;
--         SELECT count(*) FROM parser_incidents;
--         SELECT count(*) FROM resources;                  -- raw fetched content
--
--    d) Connected AS scraplify_public, confirm `description` is redacted at
--       the VIEW level for every source whose policy hasn't cleared
--       full-content republishing — this must hold even queried directly,
--       not only through the app's own query layer:
--         SELECT source_slug, description FROM public_opportunity_members
--         WHERE description <> '';
--       As of this script's own writing, both jobs.ge and hr.ge have
--       `mayRepublishFullContent: false` (src/policies/jobs-ge.ts,
--       src/policies/hr-ge.ts) — this query returning zero rows is the
--       expected, correct result today. If it ever returns a row for a
--       source whose policy you know is still `false`, stop: that means
--       either the source's `source_policies.display` row in the database
--       has drifted from the TypeScript policy file (the crawl adapters'
--       `ensureXSourceSeeded()` only inserts once, on conflict-do-nothing —
--       it does not resync an already-seeded row if the policy file
--       changes later), or the view's own redaction `CASE` has regressed.
--
--    If ANY query in (c) succeeds, do not point a public process at this
--    role until you find and remove whatever grant let it through — a
--    default privilege inherited from a template database, an accidental
--    `GRANT ... TO PUBLIC` somewhere in this database's history, or
--    membership in a group role with broader grants are the usual causes.
--    `\z <table>` on the offending table shows exactly which grant is
--    responsible.
