import type { ListingView, OpportunityView } from '../../src/browse/queries.js';

/**
 * One canonical opportunity, reduced to the handful of values a table row shows.
 *
 * These derivations are not free-form summarising. Two of them MUST reproduce
 * what `searchOpportunities` sorts by, or the column a user just sorted on
 * appears unsorted:
 *
 *   - `deadline` is the MAXIMUM live-member deadline, matching
 *     LATEST_OPEN_MEMBER_DEADLINE.
 *   - `firstSeen` is the MINIMUM live-member first-seen, matching
 *     EARLIEST_MEMBER_FIRST_SEEN.
 *
 * If either of those SQL expressions changes, this file changes with it, and
 * `opportunity-row.test.ts` is what notices.
 */

export interface SourceRef {
  sourceSlug: string;
  url: string;
  status: string;
}

export interface OpportunityRow {
  opportunityId: string;
  title: string;
  status: string;
  type: string;
  /** Distinct employer names across the live members, in member order. */
  employers: string[];
  /** One entry per source, so a cross-posted opportunity links out to both. */
  sources: SourceRef[];
  /** Latest deadline any live member states; null when none states one. */
  deadline: string | null;
  /** Whether the members state different deadlines — a real source conflict. */
  deadlinesDisagree: boolean;
  /** Earliest instant any live member was first seen: when this first appeared. */
  firstSeen: string | null;
  crossPosted: boolean;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function toRow(opportunity: OpportunityView): OpportunityRow {
  const members: readonly ListingView[] = opportunity.members;

  const deadlines = distinct(
    members.flatMap((member) => (member.deadlineAt === null ? [] : [member.deadlineAt])),
  ).sort();
  const firstSeens = members.map((member) => member.firstSeenAt).sort();

  // One entry per SOURCE, not per member: a source that listed the same
  // vacancy twice would otherwise render as two identical links.
  const sources: SourceRef[] = [];
  for (const member of members) {
    if (sources.some((source) => source.sourceSlug === member.sourceSlug)) continue;
    sources.push({
      sourceSlug: member.sourceSlug,
      url: member.canonicalUrl,
      status: member.status,
    });
  }

  return {
    opportunityId: opportunity.opportunityId,
    title: opportunity.canonicalTitle,
    status: opportunity.canonicalStatus,
    type: opportunity.type,
    employers: distinct(
      members.flatMap((member) =>
        member.organization === null || member.organization.trim() === ''
          ? []
          : [member.organization.trim()],
      ),
    ),
    sources,
    deadline: deadlines.at(-1) ?? null,
    deadlinesDisagree: deadlines.length > 1,
    firstSeen: firstSeens[0] ?? null,
    crossPosted: sources.length > 1,
  };
}
