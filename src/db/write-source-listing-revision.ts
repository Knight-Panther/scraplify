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

export interface WriteSourceListingRevisionOptions {
  /**
   * Allows a fresh, non-stale positive observation to reopen a 'closed',
   * 'expired', or 'quarantined' listing (concept §13: "closed/expired ->
   * active, reopened or republished"). Defaults to false — reactivating a
   * completed lifecycle decision needs a genuine confirmed-reappearance
   * context (e.g. a full discovery walk that re-found and successfully
   * re-fetched this exact listing), not just "this URL was fetched again
   * from somewhere," which is why this is an explicit per-call opt-in
   * rather than always-on default behavior (adversarial review, 2026-09-05
   * — the crawl orchestrator is the caller expected to set this true).
   * 'quarantined' belongs in this same opt-in bucket, not a separate
   * always-on rule: a listing that was quarantined for an unreliable parse
   * needs the same "genuinely re-observed" evidence to leave that state as
   * a closed/expired one does (adversarial review, 2026-09-05, round 8 —
   * without this a single transient parse failure permanently removed an
   * otherwise-healthy listing, since no other reactivation path exists;
   * see quarantineSourceListing's own comment).
   */
  allowReopen?: boolean;
}

export interface WriteSourceListingRevisionResult {
  outcome: WriteOutcome;
  sourceListing: SourceListingRow;
  revision: SourceListingRevisionRow;
  /** True only when this call actually reopened a 'closed'/'expired' listing (options.allowReopen and that transition both applied). */
  reopened: boolean;
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
  options: WriteSourceListingRevisionOptions = {},
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
        return {
          outcome: 'stale',
          sourceListing: corrected,
          revision: currentRevision,
          reopened: false,
        };
      }
      return {
        outcome: 'stale',
        sourceListing: locked,
        revision: currentRevision,
        reopened: false,
      };
    }

    // Only 'discovered' and 'missing_suspected' are advanced to 'active' by
    // a mere positive observation (docs/scraplify-concept.md §13). 'closed',
    // 'expired', and 'quarantined' represent a completed lifecycle decision
    // that only reopens with options.allowReopen explicitly set — a
    // confirmed reappearance signal, not just this listing having been
    // fetched again, which for 'expired' in particular could just mean the
    // source still serves the same past-deadline page, and for
    // 'quarantined' means THIS observation is itself the evidence the prior
    // parse failure was transient (adversarial review, 2026-09-05, round 8).
    // An allowlist, not a denylist, so a status added to the enum later
    // defaults to "don't touch" here unless deliberately included.
    const reopening =
      (options.allowReopen ?? false) &&
      (locked.status === 'closed' ||
        locked.status === 'expired' ||
        locked.status === 'quarantined');
    const nextStatus =
      locked.status === 'discovered' || locked.status === 'missing_suspected' || reopening
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
          // Deliberately NOT refreshed from `content` here (adversarial
          // review, 2026-09-05, round 8 raised this, then the per-commit
          // gate caught the fix's own regression): meaningfulContentHash
          // covers the RAW yearless date strings, but parseYearlessGeorgianDate
          // (dates.ts) re-resolves the SAME raw string to a different year
          // as the reference (fetch) instant moves. Refreshing on every
          // unchanged touch would silently roll an already-established,
          // genuinely past deadline into next year's occurrence purely
          // because real-world time passed — no source change involved —
          // which could keep a truly expired listing wrongly 'active'
          // (allowReopen already reopens it below) for months. Left as-is,
          // pinned to whatever the current, immutable revision established
          // when it was created: a narrower, deliberate fix (e.g. gated on
          // an actual parserVersion change, not just elapsed time) is
          // needed here, not attempted yet — see docs/STATUS.md.
        })
        .where(eq(sourceListings.id, locked.id))
        .returning();
      if (!touched) throw new Error('writeSourceListingRevision: listing update returned no row');

      return {
        outcome: 'unchanged',
        sourceListing: touched,
        revision: currentRevision,
        reopened: reopening,
      };
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
      reopened: reopening,
    };
  });
}

export interface TouchSourceListingSeenResult {
  sourceListing: SourceListingRow;
  /** True if this observation was rejected as older than what's already on record — see writeSourceListingRevision's own staleness comment; the same reasoning applies here. */
  stale: boolean;
}

/**
 * Records that a listing was seen in DISCOVERY this run even though its
 * detail fetch or parse failed — used specifically so a still-discovered
 * listing's lastSeenAt still advances, protecting it from
 * reconcile-source-listings.ts's closeMissingListings, which has only
 * lastSeenAt to judge "was this observed this run" by (adversarial review,
 * 2026-09-05: without this, a listing that's still plainly listed on the
 * source but whose detail fetch keeps failing transiently would gradually
 * accumulate missingStreak and eventually close, even though it was never
 * actually missing from the index).
 *
 * Deliberately narrower than writeSourceListingRevision's own reactivation
 * rule: only 'missing_suspected' advances to 'active' here, not
 * 'discovered'. A 'missing_suspected' listing already has a prior
 * successful revision (that's how it reached that status), so confirming
 * it's still indexed is enough to reactivate it around that last-known-good
 * content. A 'discovered' listing has never had a successful fetch at all —
 * advancing it to 'active' on a mere index sighting, with no content behind
 * it, would misrepresent what "active" means elsewhere in the schema. Never
 * reopens 'closed'/'expired'/'quarantined' — each needs the stronger
 * confirmed-reappearance evidence of an actual successful re-fetch and
 * re-parse (writeSourceListingRevision's own allowReopen path), not just an
 * index-page sighting.
 */
export async function touchSourceListingSeen(
  db: Database,
  identity: SourceListingIdentity,
  observedAt: string,
): Promise<TouchSourceListingSeenResult> {
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
      sourcePublishedAt: null,
      sourceDeadlineAt: null,
    };

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
        'touchSourceListingSeen: listing row missing immediately after insert-or-ignore',
      );
    }

    if (toEpochMs(observedAt) < toEpochMs(locked.lastSeenAt)) {
      return { sourceListing: locked, stale: true };
    }

    const nextStatus = locked.status === 'missing_suspected' ? 'active' : locked.status;

    const [updated] = await tx
      .update(sourceListings)
      .set({
        canonicalSourceUrl: identity.canonicalSourceUrl,
        lastSeenAt: observedAt,
        missingStreak: 0,
        status: nextStatus,
      })
      .where(eq(sourceListings.id, locked.id))
      .returning();
    if (!updated) throw new Error('touchSourceListingSeen: listing update returned no row');

    return { sourceListing: updated, stale: false };
  });
}

export interface QuarantineSourceListingResult {
  sourceListing: SourceListingRow;
  /** True if this observation was rejected as older than what's already on record — see writeSourceListingRevision's own staleness comment; the same reasoning applies here. */
  stale: boolean;
}

/**
 * Marks a listing quarantined — concept §13: "any state -> quarantined
 * when evidence is unreliable." Used when a listing's detail content was
 * successfully FETCHED but failed to PARSE (a markup/template mismatch,
 * not a network failure): concept §26's acceptance criteria explicitly
 * require parse failures to be "typed and quarantined," not silently
 * folded into an ordinary missing/failed count (adversarial review,
 * 2026-09-05).
 *
 * Unlike touchSourceListingSeen's allowlist-based reactivation, this
 * unconditionally overrides status to 'quarantined' regardless of the
 * listing's prior state — unreliable evidence takes precedence over
 * whatever lifecycle state was previously recorded. missingStreak is left
 * untouched (neither reset nor advanced): quarantine isn't a "confirmed
 * present" signal the way a successful fetch is, so resetting the streak
 * would overstate what's actually known.
 *
 * A quarantined listing stays excluded from touchSourceListingSeen's
 * reactivation allowlist — a bare index sighting still isn't evidence the
 * parser works — but writeSourceListingRevision's own allowReopen path DOES
 * cover 'quarantined' (adversarial review, 2026-09-05, round 8): a
 * successful, non-stale re-fetch and re-parse within a full discovery walk
 * is itself the evidence that the prior parse failure was transient, not a
 * genuine template break, so it reactivates the listing the same way it
 * would a 'closed'/'expired' one. The underlying parser_incidents row this
 * function also records is untouched either way — its own resolution
 * (concept §22, a future supervised-repair process, Phase 7) is a separate
 * concern from whether the LISTING itself is usable again.
 */
export async function quarantineSourceListing(
  db: Database,
  identity: SourceListingIdentity,
  observedAt: string,
): Promise<QuarantineSourceListingResult> {
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
      sourcePublishedAt: null,
      sourceDeadlineAt: null,
    };

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
        'quarantineSourceListing: listing row missing immediately after insert-or-ignore',
      );
    }

    if (toEpochMs(observedAt) < toEpochMs(locked.lastSeenAt)) {
      return { sourceListing: locked, stale: true };
    }

    const [updated] = await tx
      .update(sourceListings)
      .set({
        canonicalSourceUrl: identity.canonicalSourceUrl,
        lastSeenAt: observedAt,
        status: 'quarantined',
      })
      .where(eq(sourceListings.id, locked.id))
      .returning();
    if (!updated) throw new Error('quarantineSourceListing: listing update returned no row');

    return { sourceListing: updated, stale: false };
  });
}
