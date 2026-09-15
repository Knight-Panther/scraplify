import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import {
  listingClassifications,
  opportunitySourceMemberships,
  sourceListingRevisions,
  sourceListings,
  sources,
  taxonomyTerms,
} from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/**
 * §15.2 step 8's "queue low-confidence or conflicting results for review" —
 * any classification below this is ambiguous enough to need a human look.
 * hr.ge's own structured-field backfill writes `confidence: 1` throughout
 * (§15.2 step 5: it is the source's own stated category, not a guess), so
 * every classification in the corpus today is comfortably above this and
 * the queue built from it legitimately starts empty — that is a true
 * statement about the data, not a bug in the query (`docs/STATUS.md`,
 * Phase 3C-2).
 *
 * This queue implements only the low-confidence half of that requirement,
 * not "or conflicting" — nothing today produces two disagreeing
 * classifications for the same revision/axis (`deterministic_rule` is the
 * only method any code path writes), so there is nothing real to detect a
 * conflict against yet. Recorded as an accepted gap rather than built
 * against a hypothetical, per `docs/STATUS.md`'s Phase 3C-2 note (commit
 * gate, 2026-09-15) — real design work for whenever a second classification
 * method actually exists.
 */
export const AMBIGUOUS_CLASSIFICATION_CONFIDENCE_THRESHOLD = 0.8;

export interface AmbiguousClassification {
  classificationId: string;
  sourceListingId: string;
  listingTitle: string;
  sourceSlug: string;
  sourceDisplayName: string;
  termLabel: string;
  axis: string;
  confidence: number;
  method: string;
  /** §15.2 step 7's stored reasons — what explains the assignment, not just what it is. */
  evidence: unknown;
  /**
   * The listing's CURRENT live opportunity, if it has one — for linking to
   * `/opportunities/[id]`, the only detail route this app has (there is no
   * `/listings/[id]`). Null when the listing has no live membership (e.g.
   * detached), which this page renders as plain text rather than a link
   * that would 404.
   */
  opportunityId: string | null;
  /**
   * The listing's own canonical source URL — the fallback link for the
   * (common today, since nothing has clustered yet) case where
   * `opportunityId` is null. Without this a detached or never-clustered row
   * has no way to verify the classified content at all (commit gate,
   * 2026-09-15: `docs/scraplify-concept.md`'s requirement that every
   * user-facing view links back to the original listing).
   */
  canonicalSourceUrl: string;
}

/**
 * Every classification below the ambiguity threshold, joined out to
 * something a reviewer can actually read — a bare `listing_classifications`
 * row names two other rows by id and nothing else.
 *
 * Reads the title from the classification's OWN pinned revision
 * (`listingClassifications.sourceListingRevisionId`), not the listing's
 * current one — a classification is a judgment about specific content
 * (§15.2), so a reviewer deciding whether it was right needs to see exactly
 * what was judged, not whatever the listing says now if it has since
 * changed. If that ever needs reconciling against a listing's current
 * state too, it is a second, explicit column, not a silent substitution.
 */
export async function listAmbiguousClassifications(
  db: DatabaseOrTransaction,
  filters: { limit?: number | undefined; offset?: number | undefined } = {},
): Promise<AmbiguousClassification[]> {
  return (
    db
      .select({
        classificationId: listingClassifications.id,
        sourceListingId: sourceListings.id,
        listingTitle: sourceListingRevisions.titleRaw,
        sourceSlug: sources.slug,
        sourceDisplayName: sources.displayName,
        termLabel: taxonomyTerms.label,
        axis: taxonomyTerms.axis,
        confidence: listingClassifications.confidence,
        method: listingClassifications.method,
        evidence: listingClassifications.evidence,
        opportunityId: opportunitySourceMemberships.opportunityId,
        canonicalSourceUrl: sourceListings.canonicalSourceUrl,
      })
      .from(listingClassifications)
      .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, listingClassifications.taxonomyTermId))
      .innerJoin(
        sourceListingRevisions,
        eq(sourceListingRevisions.id, listingClassifications.sourceListingRevisionId),
      )
      .innerJoin(sourceListings, eq(sourceListings.id, sourceListingRevisions.sourceListingId))
      .innerJoin(sources, eq(sources.id, sourceListings.sourceId))
      // LEFT, not inner: a listing with no live membership (detached, or never
      // clustered) still needs to appear in this queue — it just renders
      // without a link, rather than being silently dropped from a review
      // queue because of an unrelated dedupe state.
      .leftJoin(
        opportunitySourceMemberships,
        and(
          eq(opportunitySourceMemberships.sourceListingId, sourceListings.id),
          isNull(opportunitySourceMemberships.supersededAt),
        ),
      )
      .where(lt(listingClassifications.confidence, AMBIGUOUS_CLASSIFICATION_CONFIDENCE_THRESHOLD))
      .orderBy(
        asc(listingClassifications.confidence),
        // Total order: confidence alone is not unique, and an ORDER BY that
        // isn't total lets the database return tied rows in any order.
        asc(listingClassifications.id),
      )
      .limit(clampLimit(filters.limit))
      .offset(filters.offset ?? 0)
  );
}

/**
 * A real `count(*)`, not `rows.length` over a full unbounded select — the
 * commit gate correctly flagged the original list query as unbounded
 * (2026-09-15); this must scale independently of that fix, the same way
 * `countReviewQueue` does for the duplicate-review queue.
 */
export async function countAmbiguousClassifications(db: DatabaseOrTransaction): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(listingClassifications)
    .where(lt(listingClassifications.confidence, AMBIGUOUS_CLASSIFICATION_CONFIDENCE_THRESHOLD));
  return row?.total ?? 0;
}
