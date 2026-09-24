-- Phase 8B Stage 9: the remaining three database roles (concept §30.2).
--
-- Stage 3 (scripts/sql/phase-8b-public-role.sql) built the public role.
-- This script builds the other three concept §30.2 names for the hosted
-- deployment: scraplify_worker, scraplify_admin, scraplify_migration.
--
-- Same caveat as every role stage in docs/STATUS.md's Phase 8B plan:
-- creating a role and choosing its password is an operational credential
-- decision outside what this session's sandbox does on anyone's behalf.
-- Written here, run and verified by the project owner. Replace every
-- <STRONG_PASSWORD_HERE_WORKER>/<STRONG_PASSWORD_HERE_ADMIN>/
-- <STRONG_PASSWORD_HERE_MIGRATION> with its OWN distinct strong password
-- before running — never the same value for more than one, and never a
-- blind global find-and-replace across all three: that would give worker,
-- admin and migration the identical secret, so a leaked worker
-- `DATABASE_URL` could authenticate as `scraplify_admin` or
-- `scraplify_migration` too, defeating the entire point of separate roles.
-- Never paste a real password into chat or commit it anywhere. Also
-- replace every <TARGET_DATABASE> with
-- whichever database this run actually targets (`scraplify`,
-- `scraplify_qa`, or a separately named hosted database) — the three
-- roles' `GRANT CONNECT` statements below deliberately don't hardcode one,
-- since this script is meant to run against more than a single database.
--
-- This does NOT touch local dev. `npm run dev:web` / `dev:web:qa` keep
-- using the existing broad `scraplify` credential exactly as documented in
-- root CLAUDE.md's "Local databases" section (writes gated at the app
-- layer, not the database layer) — these three roles are for whichever
-- database an actual hosted worker/admin process points at. Run this
-- against `scraplify_qa` first if you want to verify the grants against a
-- disposable copy before touching the real `scraplify` corpus or standing
-- up a genuinely separate hosted database.
--
-- The whole script is safe to re-run against a second database in the same
-- cluster: `CREATE ROLE` is cluster-wide (a role exists once across every
-- database on a server), but the grants and ownership-transfer steps below
-- are per-database and must actually run again for each new target — so
-- each `CREATE ROLE` is wrapped in an `IF NOT EXISTS` check rather than run
-- bare, letting the QA rehearsal and the real deployment run the identical
-- script without the second run failing on "role already exists" before it
-- reaches its own database's grants.
--
-- Table ownership confirmed live before writing this (`pg_tables`,
-- 2026-09-24): all 27 tables in `scraplify` are owned by the single
-- existing `scraplify` role, which is itself SUPERUSER — that is today's
-- local-dev setup, not a hardened target. Nothing here changes that role
-- or its ownership; scraplify_migration is a new, separate, non-superuser
-- role for whichever database is actually used as the hosted deployment
-- target, wired in the same way Stage 3 already established: no code
-- change needed, `src/db/client.ts` just reads DATABASE_URL generically,
-- so a worker/admin/migration-configured process gets a DATABASE_URL built
-- from the matching role instead of the shared broad credential.
--
-- Write ownership below was traced against the actual call chains (not
-- assumed) from every worker CLI entry point and both Stage 8 admin Server
-- Action files — grep for `.insert(`/`.update(`/`.delete(` reachable from
-- each, 2026-09-24. See docs/STATUS.md's Stage 9 build record for the full
-- table.


-- =========================================================================
-- 1. scraplify_worker — crawl/dedupe/taxonomy/embedding/publication writes
--    (concept §30.2's own wording). Today's existing CLI tools:
--    `npm run crawl:jobs-ge` / `crawl:hr-ge` (src/adapters/*/crawl.ts via
--    src/db/ingest.ts + src/db/write-source-listing-revision.ts),
--    `npm run dedupe` (src/dedupe/run-dedupe.ts),
--    `npm run taxonomy:backfill` (src/taxonomy/seed-terms.ts +
--    classify-listings.ts). No embedding/publication tables exist yet
--    (concept §30.3's opportunity_embeddings/matching_bundle_* are future
--    schema) — nothing to grant for them until that ships.
--
--    Deliberately EXCLUDED, not an oversight:
--    - candidate_profiles, candidate_profile_claims, rankings,
--      outreach_drafts, outreach_approvals, audit_events — `npm run rank`
--      (profile:create/delete, rank) does write three of these, but
--      concept §30.4 states plainly that "profile, ranking, shortlist, and
--      outreach drafts... remain personal/local features... unavailable
--      in the public production profile." They are not part of the
--      hosted worker pipeline this role backs; `rank` keeps running
--      locally against the existing broad credential, same as today.
--    - opportunity_decisions, admin_audit_events — admin-only, see below.
--    - organizations, organization_aliases, resource_links — schema
--      exists but nothing anywhere in src/ or web/ writes to them yet
--      (`resolveCanonicalOpportunity` hardcodes `organizationId: null`).
--      No grant until they're actually wired up — add one then, not now.
-- =========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scraplify_worker') THEN
    EXECUTE $create$CREATE ROLE scraplify_worker LOGIN PASSWORD '<STRONG_PASSWORD_HERE_WORKER>'$create$;
  END IF;
END $$;

GRANT CONNECT ON DATABASE <TARGET_DATABASE> TO scraplify_worker;
GRANT USAGE ON SCHEMA public TO scraplify_worker;

-- Crawl (sources, listings, run bookkeeping).
GRANT SELECT, INSERT, UPDATE ON public.sources TO scraplify_worker;
GRANT SELECT, INSERT, UPDATE ON public.source_policies TO scraplify_worker;
GRANT SELECT, INSERT, UPDATE ON public.source_listings TO scraplify_worker;
GRANT SELECT, INSERT ON public.source_listing_revisions TO scraplify_worker;
-- UPDATE, not just INSERT: upsertResource (src/db/ingest.ts) does
-- `.onConflictDoUpdate(...)`, which Postgres treats as an UPDATE on a
-- conflicting row, on EVERY crawl fetch — INSERT-only would make every
-- re-fetch of an already-seen URL fail under this role.
GRANT SELECT, INSERT, UPDATE ON public.resources TO scraplify_worker;
GRANT SELECT, INSERT, UPDATE ON public.crawl_runs TO scraplify_worker;
GRANT SELECT, INSERT ON public.fetch_attempts TO scraplify_worker;
GRANT SELECT, INSERT, UPDATE ON public.crawl_cursors TO scraplify_worker;
GRANT SELECT, INSERT ON public.parser_incidents TO scraplify_worker;

-- Dedupe.
GRANT SELECT, INSERT, UPDATE ON public.opportunities TO scraplify_worker;
GRANT SELECT, INSERT ON public.opportunity_revisions TO scraplify_worker;
GRANT SELECT, INSERT, UPDATE ON public.opportunity_source_memberships TO scraplify_worker;
GRANT SELECT, INSERT, UPDATE ON public.duplicate_candidates TO scraplify_worker;

-- Taxonomy backfill.
GRANT SELECT, INSERT, UPDATE ON public.taxonomy_terms TO scraplify_worker;
GRANT SELECT, INSERT, UPDATE ON public.source_taxonomy_mappings TO scraplify_worker;
GRANT SELECT, INSERT, UPDATE ON public.listing_classifications TO scraplify_worker;


-- =========================================================================
-- 2. scraplify_admin — "only implemented review/operations mutations"
--    (concept §30.2's own wording), i.e. exactly what Phase 8B Stage 8's
--    admin Server Actions actually call:
--    web/app/(admin)/admin/duplicates/actions.ts ->
--      src/dedupe/membership-review.ts (accept/reject a duplicate
--      candidate — reassigns or splits a listing, resolves the candidate,
--      can retire/reconcile a shortlist decision on the losing side).
--    web/app/(admin)/admin/taxonomy/actions.ts ->
--      src/taxonomy/correct-classification.ts (correct/undo a
--      classification).
--    web/lib/admin-audit.ts's insertAuditEvent -> admin_audit_events
--    directly, for every admin mutation attempt (success, refusal AND
--    failure — Stage 11).
--
--    SELECT is granted across the same operational domain worker owns,
--    since /admin/sources, /admin/duplicates and /admin/taxonomy reuse
--    src/browse/queries.ts's read functions (the same ones the `local`
--    surface's /health, /review, /taxonomy-review use) to render their
--    screens — admin needs to see this data to review it, even where it
--    has no write grant on a given table.
--
--    Deliberately EXCLUDED, same reasoning as worker's exclusions above:
--    candidate_profiles, candidate_profile_claims, rankings,
--    outreach_drafts, outreach_approvals, audit_events — concept §30.4's
--    "remain personal/local features" applies here too, and none of them
--    are in the admin route table (/admin/sources, /duplicates, /taxonomy,
--    /matching, /incidents, /operations — no /admin/profile or
--    /admin/outreach). organizations, organization_aliases, resource_links
--    stay excluded for the same "nothing writes them yet" reason as
--    worker's.
-- =========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scraplify_admin') THEN
    EXECUTE $create$CREATE ROLE scraplify_admin LOGIN PASSWORD '<STRONG_PASSWORD_HERE_ADMIN>'$create$;
  END IF;
END $$;

GRANT CONNECT ON DATABASE <TARGET_DATABASE> TO scraplify_admin;
GRANT USAGE ON SCHEMA public TO scraplify_admin;

-- Read-only across the operational domain (source health, review queue,
-- taxonomy queue, opportunity detail with dedupe evidence).
GRANT SELECT ON public.sources TO scraplify_admin;
GRANT SELECT ON public.source_policies TO scraplify_admin;
GRANT SELECT ON public.source_listings TO scraplify_admin;
GRANT SELECT ON public.source_listing_revisions TO scraplify_admin;
GRANT SELECT ON public.resources TO scraplify_admin;
GRANT SELECT ON public.crawl_runs TO scraplify_admin;
GRANT SELECT ON public.fetch_attempts TO scraplify_admin;
GRANT SELECT ON public.crawl_cursors TO scraplify_admin;
GRANT SELECT ON public.parser_incidents TO scraplify_admin;
GRANT SELECT ON public.taxonomy_terms TO scraplify_admin;
GRANT SELECT ON public.source_taxonomy_mappings TO scraplify_admin;

-- Read + write: the actual review/operations mutation surface.
GRANT SELECT, INSERT, UPDATE ON public.opportunities TO scraplify_admin;
GRANT SELECT, INSERT ON public.opportunity_revisions TO scraplify_admin;
GRANT SELECT, INSERT, UPDATE ON public.opportunity_source_memberships TO scraplify_admin;
GRANT SELECT, UPDATE ON public.duplicate_candidates TO scraplify_admin;
GRANT SELECT, INSERT, UPDATE ON public.listing_classifications TO scraplify_admin;

-- reconcileShortlistDecision / retireLiveMembership can retire the losing
-- side's shortlist decision when a duplicate is resolved or a listing is
-- split (src/dedupe/membership-review.ts:137,141) — admin never creates a
-- shortlist decision (that's the `local` surface's own /saved actions),
-- only updates or deletes one as a side effect of a merge/split decision.
GRANT SELECT, UPDATE, DELETE ON public.opportunity_decisions TO scraplify_admin;

-- The audit trail itself — written directly by web/lib/admin-audit.ts for
-- every admin mutation's outcome (succeeded/refused/failed), not proxied
-- through any other table.
GRANT SELECT, INSERT ON public.admin_audit_events TO scraplify_admin;


-- =========================================================================
-- 3. scraplify_migration — DDL at deploy time only (concept §30.2's own
--    wording). The only thing that runs under this role is
--    `npm run db:migrate` (drizzle-kit, applying drizzle/migrations/*.sql)
--    — no application code (worker, admin, public or local) ever connects
--    as this role. Unlike scraplify_worker/scraplify_admin above, this is
--    NOT a row-level SELECT/INSERT/UPDATE/DELETE grant — it needs to
--    CREATE/ALTER/DROP tables, indexes and views, which in Postgres
--    requires actually OWNING those objects, not just a schema-level
--    GRANT CREATE (that only covers objects not yet created).
--
--    Object ownership in Postgres carries full implicit data privileges —
--    an owner can SELECT/INSERT/UPDATE/DELETE its own tables with no
--    separate grant, and there is no way to give a role ALTER/DROP rights
--    on an existing object without either owning it or being superuser.
--    So scraplify_migration is inherently data-capable, not row-access-free
--    — the "DDL at deploy time only" boundary this role enforces is
--    *operational* (only `db:migrate` ever connects as it; no worker,
--    admin, public or local process is ever configured with this
--    credential), not a privilege the database itself withholds. Handle
--    this credential with the same care as a superuser-adjacent one, even
--    though it holds neither SUPERUSER nor CREATEDB/CREATEROLE.
--
--    CREATE ROLE alone is safe to run anywhere. The ownership-transfer
--    step below is NOT — it makes scraplify_migration the owner of every
--    table, view, materialized view and sequence in the CURRENT
--    DATABASE's public schema that <CURRENT_OWNER_ROLE> owns. It
--    deliberately does NOT use `REASSIGN OWNED BY ... TO ...`: per
--    PostgreSQL's own docs, that command reassigns not just objects in
--    the connected database but every *shared* object (databases,
--    tablespaces) the source role owns, cluster-wide. This project's own
--    `scraplify` role owns both the `scraplify` and `scraplify_qa`
--    databases (root CLAUDE.md's "Local databases" section) — running
--    REASSIGN OWNED while rehearsing against `scraplify_qa` would
--    silently hand scraplify_migration ownership of the live `scraplify`
--    database too. The DO block below only touches objects inside
--    whichever database it's connected to when run.
--
--    Before running: confirm the actual owning role for THIS database
--    with `SELECT tableowner, count(*) FROM pg_tables WHERE schemaname =
--    'public' GROUP BY tableowner;`, then replace <CURRENT_OWNER_ROLE>
--    below with that name. (Confirmed live 2026-09-24: today, locally,
--    every one of `scraplify`'s 27 tables is owned by role `scraplify`
--    itself, which is SUPERUSER — today's local-dev setup, not a
--    hardened target, and unaffected by this step: a superuser's own
--    privileges don't depend on which objects it owns.)
--
--    `npm run db:migrate` (drizzle-kit) doesn't only touch `public` — it
--    reads/writes its own migration journal at `drizzle.__drizzle_migrations`
--    to track which migrations already applied, in a schema separate from
--    the one being migrated. This role needs that covered too: database-
--    level CREATE (so it can create the `drizzle` schema itself the first
--    time db:migrate runs against a target that's never been migrated),
--    ownership of that schema if it already exists from an earlier
--    migration run under a different role, and its enum types (Drizzle's
--    `pgEnum` columns), which live in `pg_type`, not `pg_class` — a
--    separate catalog the ownership loop below must also walk, or a later
--    migration that touches an existing enum will fail under this role.
-- =========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scraplify_migration') THEN
    EXECUTE $create$CREATE ROLE scraplify_migration LOGIN PASSWORD '<STRONG_PASSWORD_HERE_MIGRATION>' NOCREATEDB NOCREATEROLE$create$;
  END IF;
END $$;

GRANT CONNECT ON DATABASE <TARGET_DATABASE> TO scraplify_migration;
GRANT CREATE, USAGE ON SCHEMA public TO scraplify_migration;
-- Database-level CREATE, not just schema-level: lets this role create the
-- `drizzle` schema itself on a target that has never been migrated before.
GRANT CREATE ON DATABASE <TARGET_DATABASE> TO scraplify_migration;

-- Hands scraplify_migration ownership of everything <CURRENT_OWNER_ROLE>
-- owns in THIS database's `public` AND `drizzle` schemas — tables, views,
-- materialized views, sequences (pg_class) and enum types (pg_type,
-- Drizzle's pgEnum) — plus the `drizzle` schema itself if it already
-- exists. Touches nothing outside this one connected database (no other
-- database, no shared/cluster-level object). Run once per target database,
-- connected to that database; safe to re-run (no-ops on anything it
-- already owns or that doesn't exist).
DO $$
DECLARE
  obj RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
    EXECUTE 'ALTER SCHEMA drizzle OWNER TO scraplify_migration';
  END IF;

  FOR obj IN
    SELECT n.nspname, c.relname, c.relkind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE r.rolname = '<CURRENT_OWNER_ROLE>'
      AND n.nspname IN ('public', 'drizzle')
      AND c.relkind IN ('r', 'v', 'm', 'S')
  LOOP
    EXECUTE format(
      'ALTER %s %I.%I OWNER TO scraplify_migration',
      CASE obj.relkind
        WHEN 'r' THEN 'TABLE'
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'S' THEN 'SEQUENCE'
      END,
      obj.nspname,
      obj.relname
    );
  END LOOP;

  FOR obj IN
    SELECT n.nspname, t.typname
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_roles r ON r.oid = t.typowner
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE r.rolname = '<CURRENT_OWNER_ROLE>'
      AND n.nspname IN ('public', 'drizzle')
      AND t.typtype = 'e'
  LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO scraplify_migration', obj.nspname, obj.typname);
  END LOOP;
END $$;


-- =========================================================================
-- 4. Verify — do not assume any of the above worked as written.
-- =========================================================================
--
-- a) \du+ scraplify_worker scraplify_admin scraplify_migration
--    Confirm: no Superuser, no Create DB, no Create role, no Bypass RLS
--    on any of the three (scraplify_migration gets schema-level CREATE
--    only, never database-level CREATEDB/CREATEROLE).
--
-- b) Connected AS scraplify_worker, confirm it CAN write its own domain:
--      INSERT/UPDATE a throwaway row in source_listings, resources,
--      opportunities, duplicate_candidates, listing_classifications
--      (roll back after).
--    Confirm it CANNOT touch admin/local-only data — every one of these
--    must fail with "permission denied":
--      SELECT count(*) FROM candidate_profiles;
--      SELECT count(*) FROM rankings;
--      SELECT count(*) FROM outreach_drafts;
--      SELECT count(*) FROM opportunity_decisions;
--      SELECT count(*) FROM admin_audit_events;
--      INSERT INTO admin_audit_events (...) VALUES (...);
--
-- c) Connected AS scraplify_admin, confirm it CAN write its own domain:
--      UPDATE a throwaway opportunity_source_memberships/duplicate_candidates
--      row, INSERT into admin_audit_events (roll back after).
--    Confirm it CANNOT write the crawl-only tables it can only read:
--      INSERT INTO source_listings (...) VALUES (...);   -- must fail
--      INSERT INTO resources (...) VALUES (...);          -- must fail
--    Confirm it CANNOT touch local-only personal data at all:
--      SELECT count(*) FROM candidate_profiles;   -- must fail
--      SELECT count(*) FROM rankings;              -- must fail
--
-- d) Connected AS scraplify_migration, confirm real DDL works:
--      run `npm run db:migrate` against a disposable database (e.g. a
--      throwaway copy of scraplify_qa) with DATABASE_URL pointed at this
--      role, and confirm it applies cleanly end to end.
--    Note: because this role now OWNS the migrated tables, it also has
--    full implicit SELECT/INSERT/UPDATE/DELETE on them — Postgres grants
--    every privilege to an object's owner by default, with no way to
--    withhold that while still allowing ALTER/DROP. `SELECT count(*) FROM
--    opportunities;` under this role WILL succeed, and that is expected,
--    not a leak (see section 3's own note on this tradeoff): what
--    actually must hold is operational, not privilege-level — confirm no
--    worker/admin/public/local process's DATABASE_URL is ever configured
--    with this role's credential; only `db:migrate` connects as it.
--
-- If any "must fail" query above succeeds, do not point the matching
-- hosted process at that role until you find and remove whatever grant
-- let it through — same troubleshooting note as Stage 3's script.
