-- Pure data migration: backfills the nullable provenance_* columns added in
-- 0002 from the still-present provenance jsonb column, before 0004 drops
-- that column and enforces NOT NULL. No schema.ts change accompanies this
-- migration, so drizzle-kit's own snapshot tracking stays accurate without
-- needing to be hand-edited.
--
-- The pre-0002 domain contract allowed provenance.resourceId to be null.
-- §6.2 now requires every revision to trace to a source resource, so this
-- backfill can't silently invent an id for such a row, and letting it
-- through would only resurface two migrations later as a much less
-- informative NOT NULL violation in 0004. Fail loudly here instead, so an
-- operator can decide how to remediate (backfill the correct resource, or
-- delete the row) before the constraint is enforced.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "source_listing_revisions"
    WHERE "provenance" IS NOT NULL AND ("provenance"->>'resourceId') IS NULL
  ) THEN
    RAISE EXCEPTION 'source_listing_revisions has rows with provenance.resourceId = null, predating the §6.2 requirement that every revision trace to a source resource; remediate these rows (backfill the correct resource or delete them) before rerunning this migration';
  END IF;
END $$;

UPDATE "source_listing_revisions"
SET
  "provenance_resource_id" = ("provenance"->>'resourceId')::uuid,
  "provenance_fetched_at" = ("provenance"->>'fetchedAt')::timestamptz,
  "provenance_notes" = "provenance"->>'notes'
WHERE "provenance" IS NOT NULL;
