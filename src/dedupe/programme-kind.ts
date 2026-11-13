import { type AnyColumn, type SQL, sql } from 'drizzle-orm';
import { OpportunityType } from '../domain/opportunity.js';
import { summerSchoolsEuSource } from '../policies/summerschoolsineurope-eu.js';

/**
 * Programme kinds (Phase 15): every opportunity type except a vacancy and a
 * tender. Programme sources declare them; nothing else may.
 */
export const PROGRAMME_KINDS: readonly OpportunityType[] = OpportunityType.options.filter(
  (type) => type !== 'job' && type !== 'tender',
);

/**
 * The kinds each programme source may give its listings, keyed by source id.
 * A source with one kind gets it whatever its attributes say: every
 * summerschoolsineurope.eu listing is a course ("course / school").
 */
const PROGRAMME_SOURCE_KINDS: ReadonlyMap<string, readonly OpportunityType[]> = new Map([
  [summerSchoolsEuSource.id, ['summer_school'] as const],
]);

/**
 * A listing's programme kind, or undefined when its source is not a
 * programme source. Honoured only for registered programme source ids: a
 * job board cannot declare a kind through its attributes, so its listings
 * stay vacancies or tenders (`opportunityTypeForListing`).
 *
 * `hint` is the listing's own `structuredAttributes.opportunityKind`. A
 * source allowed one kind ignores it; a source allowed several (Eurodesk,
 * Phase 15D) must name one of them.
 */
export function programmeKindForListing(
  sourceId: string,
  hint: string | null,
): OpportunityType | undefined {
  const allowed = PROGRAMME_SOURCE_KINDS.get(sourceId);
  if (allowed === undefined) return undefined;
  if (allowed.length === 1) return allowed[0];
  return allowed.find((kind) => kind === hint);
}

/** The listing's declared kind (`structuredAttributes.opportunityKind`), read by Postgres. */
export function opportunityKindSql(column: AnyColumn): SQL<string | null> {
  return sql<string | null>`(${column} ->> 'opportunityKind')`;
}
