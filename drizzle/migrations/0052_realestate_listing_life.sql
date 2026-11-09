-- One-time correction of a stored guess; no schema change.
--
-- From 2026-10-15 the ss.ge parser expected a listing whose results row names
-- no business to live 45 days (src/adapters/ss-ge/list.ts). Such a row is a
-- broker's about nine times in ten, and a broker's listing ends after 30, so
-- its dead listing stayed on the tab for up to 17 days. The parser expects 30
-- days for every listing again; this gives the rows stored under the old rule
-- the same end.
--
-- Only an end that is still the guess is touched:
--   - exactly 45 days after the order time (in hours, so no session's time
--     zone changes what a day is);
--   - not confirmed by the listing's own page since its last renewal, which
--     states the real end;
--   - not seen in a list after its 30 days, which proves a longer life.
-- Run again it finds nothing.
UPDATE "realestate"."listings"
   SET "expected_end_at" = "source_updated_at" + interval '720 hours'
 WHERE "status" = 'active'
   AND "poster_type" = 'unknown'
   AND "expected_end_at" = "source_updated_at" + interval '1080 hours'
   AND ("verified_at" IS NULL OR "verified_at" < "source_updated_at")
   AND "last_seen_at" <= "source_updated_at" + interval '720 hours';
