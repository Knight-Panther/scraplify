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
-- migration, creating public_opportunities and public_opportunity_members)
-- must already be applied via `npm run db:migrate` — this script only
-- grants access to views that migration creates.
--
-- Replace <STRONG_PASSWORD_HERE> before running. Do not commit the real
-- password anywhere, and do not paste it into chat — put it straight into
-- the public process's own .env once that env var is named (Stage 4/6).
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
CREATE ROLE scraplify_public LOGIN PASSWORD '<STRONG_PASSWORD_HERE>';

-- 2. Being ABLE to connect and see the schema exists is not the same as
--    being able to read anything in it — these two grants alone expose
--    nothing.
GRANT CONNECT ON DATABASE scraplify TO scraplify_public;
GRANT USAGE ON SCHEMA public TO scraplify_public;

-- 3. The entire visible surface: SELECT on Stage 3's two views, and NOTHING
--    ELSE. No grant follows on any base table (opportunities,
--    source_listings, sources, opportunity_source_memberships, or any
--    other) — PostgreSQL views run with the privileges of their OWNER by
--    default (the role that ran the migration), so scraplify_public needs
--    no direct grant on a base table to read through these views. That is
--    what makes this a real boundary: even a future public-surface query
--    with a bug has nothing to fall back on beyond these two views.
GRANT SELECT ON public.public_opportunities TO scraplify_public;
GRANT SELECT ON public.public_opportunity_members TO scraplify_public;

-- 4. Verify — do not assume any of the above worked as written.
--
--    a) \du+ scraplify_public
--       Confirm: no Superuser, no Create DB, no Create role, no Bypass RLS.
--
--    b) Connected AS scraplify_public, confirm the two views ARE readable:
--         SELECT count(*) FROM public_opportunities;
--         SELECT count(*) FROM public_opportunity_members;
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
--    If ANY query in (c) succeeds, do not point a public process at this
--    role until you find and remove whatever grant let it through — a
--    default privilege inherited from a template database, an accidental
--    `GRANT ... TO PUBLIC` somewhere in this database's history, or
--    membership in a group role with broader grants are the usual causes.
--    `\z <table>` on the offending table shows exactly which grant is
--    responsible.
