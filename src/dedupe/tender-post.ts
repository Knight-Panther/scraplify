import { type AnyColumn, eq, type SQL, sql } from 'drizzle-orm';
import { sourceListingRevisions, sourceListings } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import type { OpportunityType } from '../domain/opportunity.js';
import { etendersGeSource } from '../policies/etenders-ge.js';

/**
 * Which kind of opportunity a source listing is: a vacancy or a procurement
 * tender (docs/addEtender.md §14.6, Phase 9B).
 *
 * etenders.ge carries nothing but tenders. jobs.ge and hr.ge carry vacancies,
 * plus a steady trickle of buyers' own tender posts (22 in 35 days when the
 * study measured it) that used to sit in the vacancy catalogue and in CV
 * Ranked. This module finds those posts.
 *
 * Every rule below was checked against the whole real corpus (14,655 job-board
 * listings, 2026-10-07) before it was written, and the bar is precision: a
 * vacancy wrongly typed as a tender drops out of CV Ranked, which is worse
 * than a tender post left among the vacancies. So each rule is a phrase that
 * only tender posts used, and any title naming a job role vetoes all of them.
 * What the rules measured:
 *
 * - Every title starting with "ტენდერი" ("tender", or the short "ტენ.") was a
 *   tender post. Job titles use the word's other forms instead: "ტენდერების
 *   მენეჯერი" (tender manager), "სატენდერო პროექტების მენეჯერი".
 * - "შესყიდვ…" (procurement) on its own is a job word: 150 titles such as
 *   "შესყიდვების სპეციალისტი". Only the procurement-act phrases below
 *   ("for the purchase of", "carrying out works", "providing services") were
 *   tender posts, all 21 of them.
 * - A description saying "<buyer> აცხადებს ტენდერს" ("announces a tender")
 *   marked 19 listings, every one a tender post, including the three with no
 *   tender word in the title. Job ads talk about "სატენდერო დოკუმენტაცია"
 *   (tender documents, 30 hits) as a duty, never about announcing one.
 * - Known misses: a consultancy call whose title and description name no
 *   procurement act (UNDP's "ციფრული ტრანსფორმაციის მხარდაჭერა" asks for
 *   an expression of interest only in its body). It stays a vacancy.
 */

/** A title opening with the word "tender" (Georgian, its short form, or English). */
const TENDER_TITLE_START = /^\s*(?:ტენდერი|ტენ\.|tender)(?![\p{L}\p{N}])/iu;

/**
 * Phrases that name a procurement act or a tender format anywhere in a title.
 * Georgian forms are written out because Georgian has no case and the regex
 * engine has no Georgian word boundary; each is a stem followed by its
 * measured endings.
 */
const TENDER_TITLE_PHRASES: readonly RegExp[] = [
  // Price inquiry, expression of interest, "announces a tender", tender notice.
  /ფასთა გამოკითხვ/u,
  /ინტერეს(?:ის|თა) გამოხატვ/u,
  /აცხადებს ტენდერს|ტენდერს აცხადებს/u,
  /სატენდერო განცხადებ/u,
  // Procurement acts: "providing / supplying / buying services", "carrying out
  // / buying works", "about the purchase / acquisition / sale / supply of",
  // "for the purchase / acquisition / sale of", "selecting a supplier".
  /მომსახურების (?:გაწევ|მიწოდებ|შესყიდვ)/u,
  /სამუშაოების (?:შესრულებ|შესყიდვ)/u,
  /(?:შესყიდვის|შეძენის|გაყიდვის|მიწოდების) თაობაზე/u,
  /(?:შესყიდვა|შეძენა|გაყიდვა)ზე(?![\p{L}])/u,
  /მომწოდებლ(?:ის|ების) შერჩევ/u,
  /შერჩევა\s*[-–—:].*მომწოდებ/u,
  // English procurement formats, as whole words.
  /(?<![\p{L}\p{N}])(?:rfq|rfp|itb|eoi)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}])request for (?:quotations?|proposals?)(?![\p{L}])/iu,
  /(?<![\p{L}])invitation (?:to|for) (?:bids?|tenders?)(?![\p{L}])/iu,
  /(?<![\p{L}])expressions? of interest(?![\p{L}])/iu,
  /(?<![\p{L}])call for (?:bids|tenders)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:tender|procurement) (?:for|of)(?![\p{L}])/iu,
];

/**
 * Job-role nouns in their dictionary (nominative) form. A title naming one is
 * a vacancy, whatever else it says: "Tender Manager", "ტენდერების მენეჯერი".
 * Nominative only, on purpose: a tender for "IT სპეციალისტის მომსახურება"
 * (an IT specialist's services) uses the genitive and is not vetoed.
 */
const JOB_ROLE_WORDS: readonly string[] = [
  // Georgian
  'მენეჯერი',
  'სპეციალისტი',
  'კოორდინატორი',
  'ასისტენტი',
  'ოფიცერი',
  'ხელმძღვანელი',
  'ანალიტიკოსი',
  'სტაჟიორი',
  'სტაჟიორები',
  'სტაჟირება',
  'თანამშრომელი',
  'დირექტორი',
  'ინჟინერი',
  'კონსულტანტი',
  'ექსპერტი',
  'ოპერატორი',
  'აგენტი',
  'ადმინისტრატორი',
  'იურისტი',
  'ბუღალტერი',
  'მძღოლი',
  'მრჩეველი',
  'წარმომადგენელი',
  'ვაკანსია',
  // English
  'manager',
  'specialist',
  'officer',
  'coordinator',
  'assistant',
  'analyst',
  'intern',
  'internship',
  'trainee',
  'director',
  'head',
  'engineer',
  'consultant',
  'expert',
  'operator',
  'agent',
  'administrator',
  'lawyer',
  'accountant',
  'driver',
  'developer',
  'designer',
  'advisor',
  'adviser',
  'representative',
  'vacancy',
  'position',
];

const JOB_ROLE_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${JOB_ROLE_WORDS.join('|')})(?![\\p{L}\\p{N}])`,
  'iu',
);

/**
 * Description phrases that announce a tender. Kept as plain strings so the
 * same list runs in SQL (`descriptionAnnouncesTenderSql`) and in code.
 */
export const TENDER_ANNOUNCEMENT_PHRASES: readonly string[] = [
  'აცხადებს ტენდერს',
  'ტენდერს აცხადებს',
];

export function hasJobRoleWord(title: string): boolean {
  return JOB_ROLE_PATTERN.test(title.normalize('NFKC'));
}

/** True when a job-board title reads as a buyer's tender post. */
export function isTenderPostTitle(title: string): boolean {
  const text = title.normalize('NFKC');
  if (hasJobRoleWord(text)) return false;
  return TENDER_TITLE_START.test(text) || TENDER_TITLE_PHRASES.some((phrase) => phrase.test(text));
}

export function descriptionAnnouncesTender(description: string | null | undefined): boolean {
  if (description === null || description === undefined) return false;
  const text = description.normalize('NFKC');
  return TENDER_ANNOUNCEMENT_PHRASES.some((phrase) => text.includes(phrase));
}

/**
 * The same description check, evaluated by Postgres, so a pass over every
 * listing reads one boolean per row instead of every description.
 */
export function descriptionAnnouncesTenderSql(column: AnyColumn): SQL<boolean> {
  const checks = TENDER_ANNOUNCEMENT_PHRASES.map(
    (phrase) => sql`coalesce(strpos(${column}, ${phrase}), 0) > 0`,
  );
  return sql<boolean>`(${sql.join(checks, sql` or `)})`;
}

export interface ListingTypeInput {
  sourceId: string;
  title: string;
  /** Whether the listing's description announces a tender (`descriptionAnnouncesTender`). */
  descriptionAnnouncesTender: boolean;
}

/** The opportunity type a source listing belongs to. */
export function opportunityTypeForListing(input: ListingTypeInput): OpportunityType {
  if (input.sourceId === etendersGeSource.id) return 'tender';
  if (isTenderPostTitle(input.title)) return 'tender';
  if (input.descriptionAnnouncesTender && !hasJobRoleWord(input.title)) return 'tender';
  return 'job';
}

/**
 * One stored listing's type, read from its current revision. Null when the
 * listing does not exist or has no revision yet.
 */
export async function loadListingOpportunityType(
  db: DatabaseOrTransaction,
  sourceListingId: string,
): Promise<OpportunityType | null> {
  const [row] = await db
    .select({
      sourceId: sourceListings.sourceId,
      title: sourceListingRevisions.titleRaw,
      descriptionAnnouncesTender: descriptionAnnouncesTenderSql(sourceListingRevisions.description),
    })
    .from(sourceListings)
    .innerJoin(
      sourceListingRevisions,
      eq(sourceListingRevisions.id, sourceListings.currentRevisionId),
    )
    .where(eq(sourceListings.id, sourceListingId));
  return row === undefined ? null : opportunityTypeForListing(row);
}
