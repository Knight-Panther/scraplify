import { and, asc, eq, ilike, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import {
  listingClassifications,
  opportunitySourceMemberships,
  sourceListingRevisions,
  sourceListings,
  sources,
  taxonomyTerms,
} from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import type { TaxonomyAxis } from '../domain/taxonomy.js';

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
      .where(
        and(
          lt(listingClassifications.confidence, AMBIGUOUS_CLASSIFICATION_CONFIDENCE_THRESHOLD),
          // A rejected classification (Stage 7) is born already superseded,
          // at confidence 0 — without this filter it would immediately
          // reappear here as "needs review" despite already being decided.
          isNull(listingClassifications.supersededAt),
        ),
      )
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
    .where(
      and(
        lt(listingClassifications.confidence, AMBIGUOUS_CLASSIFICATION_CONFIDENCE_THRESHOLD),
        isNull(listingClassifications.supersededAt),
      ),
    );
  return row?.total ?? 0;
}

export interface SearchClassificationsFilters {
  text?: string | undefined;
  sourceSlug?: string | undefined;
  axis?: TaxonomyAxis | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * `ilike` compares bytes; case folding is a no-op for Mkhedruli (no
 * capitals), but still matters for Latin term/title text — same helper
 * `src/browse/queries.ts`'s `searchListings` already establishes.
 */
function searchPattern(text: string): string {
  return `%${text.trim().normalize('NFC')}%`;
}

/**
 * Shared between `searchClassifications` and `countClassifications` so they
 * cannot disagree — a hand-copied filter set between a list and its count is
 * the classic pagination bug this project has hit twice before
 * (`docs/STATUS.md`, 3C-1's own "count and list silently disagree" defect).
 */
function classificationConditions(filters: SearchClassificationsFilters): SQL[] {
  const conditions: SQL[] = [isNull(listingClassifications.supersededAt)];
  if (filters.text !== undefined && filters.text.trim().length > 0) {
    const pattern = searchPattern(filters.text);
    const match = or(
      ilike(sourceListingRevisions.titleRaw, pattern),
      ilike(taxonomyTerms.label, pattern),
    );
    if (match !== undefined) conditions.push(match);
  }
  if (filters.sourceSlug !== undefined) conditions.push(eq(sources.slug, filters.sourceSlug));
  if (filters.axis !== undefined) conditions.push(eq(taxonomyTerms.axis, filters.axis));
  return conditions;
}

/**
 * Every LIVE classification, searchable — this is what actually lets a
 * reviewer correct any classification in the corpus, not only the ones that
 * happen to score below the ambiguity threshold. hr.ge's structured-field
 * backfill writes confidence 1 throughout, so `listAmbiguousClassifications`
 * alone has nothing to act on against the real corpus (commit gate finding,
 * 2026-09-15) — this is the query that actually satisfies Phase 3's exit
 * gate ("inspected and corrected"), scoped to search rather than a bare full
 * dump, since the real corpus is 16,000+ rows.
 */
export async function searchClassifications(
  db: DatabaseOrTransaction,
  filters: SearchClassificationsFilters = {},
): Promise<AmbiguousClassification[]> {
  return db
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
    .leftJoin(
      opportunitySourceMemberships,
      and(
        eq(opportunitySourceMemberships.sourceListingId, sourceListings.id),
        isNull(opportunitySourceMemberships.supersededAt),
      ),
    )
    .where(and(...classificationConditions(filters)))
    .orderBy(asc(sourceListingRevisions.titleRaw), asc(listingClassifications.id))
    .limit(clampLimit(filters.limit))
    .offset(filters.offset ?? 0);
}

export async function countClassifications(
  db: DatabaseOrTransaction,
  filters: SearchClassificationsFilters = {},
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(listingClassifications)
    .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, listingClassifications.taxonomyTermId))
    .innerJoin(
      sourceListingRevisions,
      eq(sourceListingRevisions.id, listingClassifications.sourceListingRevisionId),
    )
    .innerJoin(sourceListings, eq(sourceListings.id, sourceListingRevisions.sourceListingId))
    .innerJoin(sources, eq(sources.id, sourceListings.sourceId))
    .where(and(...classificationConditions(filters)));
  return row?.total ?? 0;
}

/**
 * How many of a source's listings have never had a live classification at
 * all — distinct from "low confidence" (they have none, not a shaky one).
 * jobs.ge today: every listing, since its `structuredAttributes` is always
 * `{}` and nothing else classifies it (commit gate finding, 2026-09-15).
 *
 * "Uncategorized" means no LIVE classification for the listing's CURRENT
 * revision — a listing whose only classification was rejected (Stage 7)
 * counts as uncategorized again, which is the honest reading: nothing
 * currently classifies it, regardless of history.
 */
export async function countUncategorizedListings(
  db: DatabaseOrTransaction,
  filters: { sourceSlug: string },
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(sourceListings)
    .innerJoin(sources, eq(sources.id, sourceListings.sourceId))
    .where(
      and(
        eq(sources.slug, filters.sourceSlug),
        sql`not exists (
          select 1
          from ${listingClassifications} lc
          where lc.source_listing_revision_id = ${sourceListings.currentRevisionId}
            and lc.superseded_at is null
        )`,
      ),
    );
  return row?.total ?? 0;
}
