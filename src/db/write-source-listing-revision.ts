import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { SourceListingRevision } from '../domain/source-listing.js';
import {
  sourceListingRevisions,
  sourceListings,
  type SourceListingRevisionRow,
  type SourceListingRow,
} from './schema/index.js';
import type { Database } from './types.js';

export interface SourceListingIdentity {
  sourceId: string;
  /** Null when this source has no stable external ID — identity falls back to canonicalSourceUrl (§12.1). */
  sourceRecordId: string | null;
  canonicalSourceUrl: string;
}

/** Everything a fresh fetch+parse observed, minus the fields this write path assigns itself. */
export type SourceListingRevisionContent = Omit<
  SourceListingRevision,
  'id' | 'sourceListingId' | 'createdAt'
>;

export type WriteOutcome = 'new' | 'changed' | 'unchanged' | 'stale';

export interface WriteSourceListingRevisionResult {
  outcome: WriteOutcome;
  sourceListing: SourceListingRow;
  revision: SourceListingRevisionRow;
}

/**
 * Compares two timestamp strings as actual instants rather than lexically.
 * Needed because a value round-tripped through Postgres (`YYYY-MM-DD
 * HH:MM:SS+TZ`) and one supplied directly by a caller (ISO 8601,
 * `YYYY-MM-DDTHH:MM:SSZ`) can represent the same instant while sorting
 * differently as raw strings — `Date` parses both correctly.
 */
function toEpochMs(isoLike: string): number {
  return new Date(isoLike).getTime();
}

/**
 * Retry-safe idempotent write protocol carried forward from Phase 0's
 * adversarial review (docs/STATUS.md, src/db/schema/source-listings.ts):
 * source_listing_revisions has no DB-level uniqueness on
 * (sourceListingId, meaningfulContentHash), since content can legitimately
 * revert to an earlier hash — so two concurrent/retried observations of the
 * SAME fetch must be deduplicated here, not by a database constraint.
 *
 * Protocol, all inside one transaction:
 *  1. Insert-or-ignore the listing row (handles "never seen before" without
 *     a separate existence check racing another writer).
 *  2. SELECT ... FOR UPDATE that row by its natural key, serializing any
 *     concurrent writer for the same listing behind this transaction.
 *  3. Re-read the current revision's hash under that lock and compare.
 *  4. Only if the hash differs (including "no current revision yet"):
 *     insert the new revision, then repoint currentRevisionId — in that
 *     order, so the ownership FK is always satisfiable.
 * A second concurrent call for an identical observation blocks on step 2,
 * then — once it acquires the lock — finds the hash already matches at
 * step 3 and reports 'unchanged' instead of inserting a duplicate revision.
 *
 * The lock alone only serializes writers for the same listing — it says
 * nothing about which of two DIFFERENT observations (e.g. a slow retry of
 * an older fetch landing after a newer regular crawl already processed the
 * same listing) should win. Locking order is not observation order, so
 * `observedAt` is compared against the row's own `lastSeenAt` high-water
 * mark — as actual instants (`toEpochMs`), not as raw strings: a value
 * read back from Postgres and one supplied by the caller can be
 * differently formatted for the same instant (space vs `T`, `+00` vs `Z`),
 * so lexicographic string comparison is not reliable here — and checked
 * BEFORE any state change, including a same-hash "unchanged" touch: a
 * late, strictly-older retry must never reset `missingStreak` or reactivate
 * a status a more recent observation (or a later reconciliation pass) has
 * already moved past, even when its content happens to match.
 */
export async function writeSourceListingRevision(
  db: Database,
  identity: SourceListingIdentity,
  content: SourceListingRevisionContent,
  observedAt: string,
): Promise<WriteSourceListingRevisionResult> {
  return db.transaction(async (tx) => {
    const values = {
      id: randomUUID(),
      sourceId: identity.sourceId,
      sourceRecordId: identity.sourceRecordId,
      canonicalSourceUrl: identity.canonicalSourceUrl,
      currentRevisionId: null,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      status: 'discovered' as const,
      missingStreak: 0,
      sourcePublishedAt: content.publishedDate.parsed,
      sourceDeadlineAt: content.deadlineDate.parsed,
    };

    // Two different partial unique indexes back this listing's identity
    // (source-listings.ts), so the conflict target has to match whichever
    // one actually applies.
    if (identity.sourceRecordId !== null) {
      await tx
        .insert(sourceListings)
        .values(values)
        .onConflictDoNothing({
          target: [sourceListings.sourceId, sourceListings.sourceRecordId],
          where: sql`${sourceListings.sourceRecordId} is not null`,
        });
    } else {
      await tx
        .insert(sourceListings)
        .values(values)
        .onConflictDoNothing({
          target: [sourceListings.sourceId, sourceListings.canonicalSourceUrl],
          where: sql`${sourceListings.sourceRecordId} is null`,
        });
    }

    const identityWhere =
      identity.sourceRecordId !== null
        ? and(
            eq(sourceListings.sourceId, identity.sourceId),
            eq(sourceListings.sourceRecordId, identity.sourceRecordId),
          )
        : and(
            eq(sourceListings.sourceId, identity.sourceId),
            eq(sourceListings.canonicalSourceUrl, identity.canonicalSourceUrl),
          );

    const [locked] = await tx.select().from(sourceListings).where(identityWhere).for('update');
    if (!locked) {
      throw new Error(
        'writeSourceListingRevision: listing row missing immediately after insert-or-ignore',
      );
    }

    let currentRevision: SourceListingRevisionRow | null = null;
    if (locked.currentRevisionId !== null) {
      const [row] = await tx
        .select()
        .from(sourceListingRevisions)
        .where(eq(sourceListingRevisions.id, locked.currentRevisionId));
      if (!row) throw new Error('writeSourceListingRevision: current revision missing under lock');
      currentRevision = row;
    }

    // Checked before ANY state change below, hash match included: the lock
    // only orders writers relative to EACH OTHER, not relative to the
    // real-world time their observations were made, so a strictly-older
    // arrival here must be rejected outright rather than allowed to touch
    // lastSeenAt/missingStreak/status — even a same-hash "unchanged" touch
    // would otherwise let a late retry silently reactivate a listing a more
    // recent observation (or a later reconciliation pass) already moved on
    // from. A tie (equal instants) is not stale — the common case of many
    // listings in one crawl run sharing that run's single observedAt must
    // still be able to proceed past this check.
    if (currentRevision !== null && toEpochMs(observedAt) < toEpochMs(locked.lastSeenAt)) {
      // Rejected for state purposes, but a delayed FIRST sighting can still
      // reveal an earlier true firstSeenAt than what's on record — pure
      // audit bookkeeping, orthogonal to the rejection above (a listing's
      // recorded age should reflect the earliest observation ever made,
      // regardless of arrival order).
      if (toEpochMs(observedAt) < toEpochMs(locked.firstSeenAt)) {
        const [corrected] = await tx
          .update(sourceListings)
          .set({ firstSeenAt: observedAt })
          .where(eq(sourceListings.id, locked.id))
          .returning();
        if (!corrected) {
          throw new Error('writeSourceListingRevision: firstSeenAt correction returned no row');
        }
        return { outcome: 'stale', sourceListing: corrected, revision: currentRevision };
      }
      return { outcome: 'stale', sourceListing: locked, revision: currentRevision };
    }

    // Only 'discovered' and 'missing_suspected' are advanced to 'active' by
    // a mere positive observation (docs/scraplify-concept.md §13). 'closed'
    // and 'expired' represent a completed lifecycle decision that only a
    // reconciliation pass may reverse with a confirmed reappearance signal
    // — not just this listing having been fetched again, which for
    // 'expired' in particular could just mean the source still serves the
    // same past-deadline page. 'quarantined' needs its incident resolved
    // first. An allowlist, not a denylist, so a status added to the enum
    // later defaults to "don't touch" here unless deliberately included.
    const nextStatus =
      locked.status === 'discovered' || locked.status === 'missing_suspected'
        ? 'active'
        : locked.status;

    if (
      currentRevision !== null &&
      currentRevision.meaningfulContentHash === content.meaningfulContentHash
    ) {
      const [touched] = await tx
        .update(sourceListings)
        .set({
          canonicalSourceUrl: identity.canonicalSourceUrl,
          lastSeenAt: observedAt,
          missingStreak: 0,
          status: nextStatus,
        })
        .where(eq(sourceListings.id, locked.id))
        .returning();
      if (!touched) throw new Error('writeSourceListingRevision: listing update returned no row');

      return { outcome: 'unchanged', sourceListing: touched, revision: currentRevision };
    }

    const newRevisionId = randomUUID();
    const [revision] = await tx
      .insert(sourceListingRevisions)
      .values({
        id: newRevisionId,
        sourceListingId: locked.id,
        parserVersion: content.parserVersion,
        extractionMethod: content.extractionMethod,
        rawResourceHash: content.rawResourceHash,
        meaningfulContentHash: content.meaningfulContentHash,
        titleRaw: content.titleRaw,
        titleNormalized: content.titleNormalized,
        organizationRaw: content.organizationRaw,
        description: content.description,
        locations: content.locations,
        salaryRaw: content.salaryRaw,
        publishedDate: content.publishedDate,
        deadlineDate: content.deadlineDate,
        applicationMethod: content.applicationMethod,
        sourceCategories: content.sourceCategories,
        structuredAttributes: content.structuredAttributes,
        createdAt: observedAt,
        provenanceResourceId: content.provenance.resourceId,
        provenanceFetchedAt: content.provenance.fetchedAt,
        provenanceNotes: content.provenance.notes,
      })
      .returning();
    if (!revision) throw new Error('writeSourceListingRevision: revision insert returned no row');

    // Revision inserted before repointing currentRevisionId, never the
    // other order — the ownership FK requires the revision to already
    // exist before a listing can point at it.
    const [updated] = await tx
      .update(sourceListings)
      .set({
        currentRevisionId: newRevisionId,
        canonicalSourceUrl: identity.canonicalSourceUrl,
        lastSeenAt: observedAt,
        missingStreak: 0,
        status: nextStatus,
        sourcePublishedAt: content.publishedDate.parsed,
        sourceDeadlineAt: content.deadlineDate.parsed,
      })
      .where(eq(sourceListings.id, locked.id))
      .returning();
    if (!updated) throw new Error('writeSourceListingRevision: listing update returned no row');

    return {
      outcome: currentRevision === null ? 'new' : 'changed',
      sourceListing: updated,
      revision,
    };
  });
}
