import type { PublicOpportunityDetailView } from '../../src/browse/public-queries.js';
import {
  applyRoute,
  type BoardApply,
  type BoardColumn,
  type BoardDescription,
  type BoardExtras,
  column,
  type ComparisonRow,
  date,
  experienceField,
  extraFields,
  locationText,
  row,
  text,
} from './opportunity-detail.js';

/**
 * The public detail screen's own derivation (Phase 8B Stage 4) — deliberately
 * NOT `toDetail`/`OpportunityDetail` from `opportunity-detail.ts`. That
 * function's `observations` and `formerBoards` sections read
 * `decision`/`confidence`/`decidedBy`/`dedupeRulesetVersion`/`evidence`
 * straight off each member (dedupe internals), and `PublicOpportunityDetailView`
 * (`src/browse/public-queries.ts`) has none of those fields at all — Stage 3's
 * public database views never carried them in the first place. So there is no
 * boolean flag to get wrong here: the public shape structurally cannot
 * include what it must not show.
 *
 * `canonicalIsStale` is also absent for the same reason — it is computed from
 * `opportunity_revisions.sourceMembershipVersions`, which the public views
 * don't expose either.
 *
 * The five sections a public visitor SHOULD see (comparison, apply,
 * descriptions, extras, and which boards carry it) reuse the exact same
 * derivation helpers `toDetail` uses, exported from `opportunity-detail.ts`
 * for this purpose — so a rule change there (a new comparison row, a new
 * extra field) does not have to be maintained twice.
 */

export interface PublicOpportunityDetail {
  opportunityId: string;
  title: string;
  status: string;
  type: string;
  columns: BoardColumn[];
  comparison: ComparisonRow[];
  apply: BoardApply[];
  /**
   * Already filtered by the query layer's `mayRepublishFullContent` policy
   * (`src/browse/public-queries.ts`'s `publicDescription`): a member whose
   * source has not cleared full-content republishing arrives with an empty
   * description and is excluded here exactly the way a board that genuinely
   * wrote nothing already is — no separate "omitted for policy" branch is
   * needed because the two cases render identically to a visitor either way.
   */
  descriptions: BoardDescription[];
  extras: BoardExtras[];
  crossPosted: boolean;
  grouped: boolean;
}

export function toPublicDetail(view: PublicOpportunityDetailView): PublicOpportunityDetail {
  const members = view.members;
  const columns = members.map(column);

  const comparison = [
    row(
      'title',
      'Title',
      'The boards word the title differently.',
      members.map((m) => text(m.title)),
    ),
    row(
      'employer',
      'Employer',
      'The boards name the employer differently.',
      members.map((m) => text(m.organization)),
    ),
    row(
      'state',
      'State',
      'The boards report different states, and a missed crawl is a suspicion rather than a takedown.',
      members.map((m) => ({ kind: 'status' as const, value: m.status })),
    ),
    row(
      'deadline',
      'Closes',
      'The boards state different closing dates.',
      members.map((m) => date(m.deadlineAt)),
    ),
    row(
      'published',
      'Posted',
      'The boards state different posting dates.',
      members.map((m) => date(m.publishedAt)),
    ),
    row(
      'location',
      'Location',
      'The boards state different locations.',
      members.map((m) => locationText(m.locations)),
    ),
    row(
      'salary',
      'Pay',
      'The boards state different pay.',
      members.map((m) => text(m.salaryRaw)),
    ),
  ].filter((entry): entry is ComparisonRow => entry !== null);

  const extras: BoardExtras[] = [];
  for (const member of members) {
    const fields = extraFields(member.structuredAttributes);
    const experience = experienceField(member.structuredAttributes);
    if (experience !== null) fields.push(experience);
    if (fields.length > 0) extras.push({ column: column(member), fields });
  }

  return {
    opportunityId: view.opportunityId,
    title: view.canonicalTitle,
    status: view.canonicalStatus,
    type: view.type,
    columns,
    comparison,
    apply: members.map((member) => ({
      column: column(member),
      route: applyRoute(member.applicationMethod),
    })),
    descriptions: members
      .filter((member) => member.description.trim() !== '')
      .map((member) => ({ column: column(member), text: member.description })),
    extras,
    crossPosted: new Set(members.map((member) => member.sourceSlug)).size > 1,
    grouped: members.length > 1,
  };
}
