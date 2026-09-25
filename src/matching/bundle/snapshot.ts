import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { deriveCanonicalTitle, publicEligibleMemberSql } from '../../browse/public-queries.js';
import {
  listingClassifications,
  opportunities,
  publicOpportunities,
  publicOpportunityMembers,
  sourceListings,
  taxonomyTerms,
} from '../../db/schema/index.js';
import type { Database } from '../../db/types.js';
import { type BundleOpportunity, MATCHING_FEATURE_CONTRACT, sha256Hex } from './contract.js';

/**
 * Reads the corpus a bundle is built from, as one consistent snapshot.
 *
 * Only through the PUBLIC views (`public_opportunities`,
 * `public_opportunity_members`) plus the two ids those views don't carry
 * (an opportunity's current canonical revision and a listing's current
 * revision, for taxonomy). So anything the public role cannot see, a
 * quarantined listing or a redacted description, cannot reach a bundle
 * either. Eligibility is `publicEligibleMemberSql`, the same predicate
 * Browse applies, not a second copy of the lifecycle rules (change.md §7).
 */

export interface CorpusSnapshot {
  rows: BundleOpportunity[];
  /** Eligible opportunities left out, by reason. */
  exclusions: Record<string, number>;
  /** Latest `last_seen_at` among included members; null for an empty corpus. */
  corpusWatermark: string | null;
  sourceFreshness: { sourceSlug: string; lastSeenAt: string }[];
}

export interface SnapshotOptions {
  asOf: string;
  /** Restrict to these sources (tests); the real build uses every source. */
  sourceSlugs?: readonly string[];
}

const pom = publicOpportunityMembers;
const eligible = (asOf: string) =>
  publicEligibleMemberSql(asOf, { status: pom.status, deadlineAt: pom.deadlineAt });

export async function readCorpusSnapshot(
  db: Database,
  options: SnapshotOptions,
): Promise<CorpusSnapshot> {
  return db.transaction(
    async (tx) => {
      const scope =
        options.sourceSlugs === undefined
          ? undefined
          : inArray(pom.sourceSlug, [...options.sourceSlugs]);

      const eligibleRows = await tx
        .select({ opportunityId: pom.opportunityId, sourceListingId: pom.sourceListingId })
        .from(pom)
        .where(and(eligible(options.asOf), scope));
      const eligibleListingIds = new Set(eligibleRows.map((row) => row.sourceListingId));
      const opportunityIds = [...new Set(eligibleRows.map((row) => row.opportunityId))];
      if (opportunityIds.length === 0) {
        return { rows: [], exclusions: {}, corpusWatermark: null, sourceFreshness: [] };
      }

      // Every visible member of those opportunities, not only the eligible
      // ones: the canonical title follows Browse's rule over all visible
      // members, so the two screens name an opportunity the same way.
      const members = await tx
        .select({
          opportunityId: pom.opportunityId,
          canonicalRevisionId: opportunities.currentCanonicalRevisionId,
          type: publicOpportunities.type,
          sourceListingId: pom.sourceListingId,
          sourceSlug: pom.sourceSlug,
          title: pom.title,
          organization: pom.organization,
          canonicalUrl: pom.canonicalUrl,
          deadlineAt: pom.deadlineAt,
          lastSeenAt: pom.lastSeenAt,
          description: pom.description,
          locations: pom.locations,
          listingRevisionId: sourceListings.currentRevisionId,
        })
        .from(pom)
        .innerJoin(publicOpportunities, eq(publicOpportunities.id, pom.opportunityId))
        .innerJoin(opportunities, eq(opportunities.id, pom.opportunityId))
        .innerJoin(sourceListings, eq(sourceListings.id, pom.sourceListingId))
        .where(and(inArray(pom.opportunityId, opportunityIds), scope));

      const revisionIds = members
        .filter((member) => eligibleListingIds.has(member.sourceListingId))
        .flatMap((member) => (member.listingRevisionId === null ? [] : [member.listingRevisionId]));
      const terms =
        revisionIds.length === 0
          ? []
          : await tx
              .select({
                revisionId: listingClassifications.sourceListingRevisionId,
                axis: taxonomyTerms.axis,
                code: taxonomyTerms.code,
                label: taxonomyTerms.label,
              })
              .from(listingClassifications)
              .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, listingClassifications.taxonomyTermId))
              .where(
                and(
                  isNull(listingClassifications.supersededAt),
                  inArray(listingClassifications.sourceListingRevisionId, revisionIds),
                ),
              );
      const termsByRevision = new Map<string, { axis: string; code: string; label: string }[]>();
      for (const { revisionId, ...term } of terms) {
        const list = termsByRevision.get(revisionId);
        if (list) list.push(term);
        else termsByRevision.set(revisionId, [term]);
      }

      const byOpportunity = new Map<string, typeof members>();
      for (const member of members) {
        const list = byOpportunity.get(member.opportunityId);
        if (list) list.push(member);
        else byOpportunity.set(member.opportunityId, [member]);
      }

      const exclusions: Record<string, number> = {};
      const rows: BundleOpportunity[] = [];
      const freshness = new Map<string, string>();
      let watermark: string | null = null;

      for (const opportunityId of [...byOpportunity.keys()].sort()) {
        const all = byOpportunity.get(opportunityId) ?? [];
        const available = all
          .filter((member) => eligibleListingIds.has(member.sourceListingId))
          .sort(
            (a, b) => cmp(a.sourceSlug, b.sourceSlug) || cmp(a.sourceListingId, b.sourceListingId),
          );
        const first = all[0];
        if (first === undefined || available.length === 0) continue;
        if (first.canonicalRevisionId === null) {
          exclusions.no_canonical_revision = (exclusions.no_canonical_revision ?? 0) + 1;
          continue;
        }

        const title = deriveCanonicalTitle(all);
        const titleMember = all.find((member) => member.title === title && member.organization);
        const organization =
          titleMember?.organization ??
          available.find((member) => member.organization)?.organization ??
          null;
        const deadlines = available.flatMap((member) =>
          member.deadlineAt === null ? [] : [new Date(member.deadlineAt).toISOString()],
        );
        const locations = uniqueSorted(
          available.flatMap((member) => stringArray(member.locations).map((value) => value.trim())),
        );
        const taxonomy = [
          ...new Map(
            available
              .flatMap((member) =>
                member.listingRevisionId === null
                  ? []
                  : (termsByRevision.get(member.listingRevisionId) ?? []),
              )
              .map((term) => [term.code, term] as const),
          ).values(),
        ].sort((a, b) => cmp(a.axis, b.axis) || cmp(a.code, b.code));

        const semanticInput = JSON.stringify({
          contract: MATCHING_FEATURE_CONTRACT,
          type: first.type,
          title,
          organization,
          descriptions: available.map((member) => ({
            sourceSlug: member.sourceSlug,
            text: member.description,
          })),
          taxonomy: taxonomy.map((term) => term.code),
          locations,
        });

        rows.push({
          opportunityId,
          canonicalRevisionId: first.canonicalRevisionId,
          semanticInputHash: sha256Hex(semanticInput),
          type: first.type,
          title,
          organization,
          deadlineAt: deadlines.length === 0 ? null : (deadlines.sort().at(-1) ?? null),
          locations,
          taxonomy,
          sources: available.map((member) => ({
            sourceSlug: member.sourceSlug,
            sourceListingId: member.sourceListingId,
            canonicalUrl: member.canonicalUrl,
          })),
        });

        for (const member of available) {
          const seen = new Date(member.lastSeenAt).toISOString();
          const prior = freshness.get(member.sourceSlug);
          if (prior === undefined || seen > prior) freshness.set(member.sourceSlug, seen);
          if (watermark === null || seen > watermark) watermark = seen;
        }
      }

      return {
        rows,
        exclusions,
        corpusWatermark: watermark,
        sourceFreshness: [...freshness.entries()]
          .sort(([a], [b]) => cmp(a, b))
          .map(([sourceSlug, lastSeenAt]) => ({ sourceSlug, lastSeenAt })),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort(cmp);
}

/**
 * Re-checks, after the files are written, that every row still maps to the
 * opportunity's CURRENT canonical revision and that every source it names is
 * still a live, public member of that opportunity at the same URL (the 8C
 * exit criterion). Returns the ids that no longer do.
 */
export async function findProvenanceDrift(
  db: Database,
  rows: readonly BundleOpportunity[],
): Promise<string[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.opportunityId);
  const current = await db
    .select({ id: opportunities.id, revisionId: opportunities.currentCanonicalRevisionId })
    .from(opportunities)
    .where(
      and(
        inArray(opportunities.id, ids),
        sql`exists (select 1 from ${publicOpportunities} where ${publicOpportunities.id} = ${opportunities.id})`,
      ),
    );
  const revisionById = new Map(current.map((row) => [row.id, row.revisionId]));
  const liveMembers = await db
    .select({
      opportunityId: publicOpportunityMembers.opportunityId,
      sourceListingId: publicOpportunityMembers.sourceListingId,
      sourceSlug: publicOpportunityMembers.sourceSlug,
      canonicalUrl: publicOpportunityMembers.canonicalUrl,
    })
    .from(publicOpportunityMembers)
    .where(inArray(publicOpportunityMembers.opportunityId, ids));
  const memberKey = (m: {
    opportunityId: string;
    sourceListingId: string;
    sourceSlug: string;
    canonicalUrl: string;
  }) => `${m.opportunityId}|${m.sourceListingId}|${m.sourceSlug}|${m.canonicalUrl}`;
  const live = new Set(liveMembers.map(memberKey));

  return rows
    .filter(
      (row) =>
        revisionById.get(row.opportunityId) !== row.canonicalRevisionId ||
        row.sources.some(
          (source) => !live.has(memberKey({ opportunityId: row.opportunityId, ...source })),
        ),
    )
    .map((row) => row.opportunityId);
}
