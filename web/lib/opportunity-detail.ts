import { sourceDayKey } from './format.js';
import type { OpportunityDetailView, OpportunityMemberDetail } from '../../src/browse/queries.js';

/**
 * The detail screen's derivations, kept out of the component so they can be
 * tested against the shapes the corpus actually contains.
 *
 * The organising idea is §14.2's: a canonical opportunity must SURFACE the
 * places its sources disagree rather than resolve them silently. So this file
 * does not pick winning values. It lines the boards up field by field and says
 * which fields they state differently — the page renders that, and the reader
 * decides.
 *
 * One distinction runs through all of it, and it is not pedantry:
 *
 *   - **Disagreement** is two boards stating DIFFERENT values.
 *   - **Absence** is one board stating nothing.
 *
 * They look alike in a table and mean opposite things. jobs.ge carries no
 * location and no pay on any of its 310 listings, so treating "hr.ge says
 * თბილისი, jobs.ge says nothing" as a conflict would mark almost every
 * cross-posted cluster as contradictory when the boards simply record
 * different fields. Only distinct PRESENT values count as a disagreement.
 */

export interface BoardColumn {
  sourceListingId: string;
  sourceSlug: string;
  /** This board's own listing page — every member links back to its source. */
  url: string;
  status: string;
}

/**
 * A cell's kind, so the page can render a `<time>` or a status chip rather
 * than receiving pre-formatted strings. Formatting lives in `format.ts` and
 * labelling in `labels.ts`; neither belongs in a derivation.
 */
export type Cell =
  | { kind: 'text'; value: string }
  | { kind: 'date'; iso: string }
  | { kind: 'status'; value: string };

export interface ComparisonRow {
  key: string;
  label: string;
  /** One entry per column, in column order. null means this board is silent. */
  cells: (Cell | null)[];
  /** True only when two boards state DIFFERENT values. See the note above. */
  differs: boolean;
  /** What the difference means, shown beside the marker when `differs`. */
  note: string;
}

/**
 * How to apply, which `data-density.md` calls the primary action.
 *
 * All four of the schema's cases occur in the corpus — 225 email, 128 url, 35
 * form, 22 unspecified — so all four get a deliberate treatment rather than a
 * fallback. `form` means the board hosts the application itself, which is an
 * instruction to open the listing, not a missing value; `unstated` is the
 * genuinely absent case and says so.
 */
export type ApplyRoute =
  | { kind: 'email'; address: string; href: string }
  | { kind: 'url'; href: string }
  | { kind: 'onSource' }
  | { kind: 'unstated' };

export interface BoardApply {
  column: BoardColumn;
  route: ApplyRoute;
}

export interface BoardDescription {
  column: BoardColumn;
  /** This board's text alone. Never joined with another board's. */
  text: string;
}

/** One `key: value` the board records and this schema has no column for. */
export interface ExtraField {
  label: string;
  values: string[];
}

export interface BoardExtras {
  column: BoardColumn;
  fields: ExtraField[];
}

export interface OpportunityDetail {
  opportunityId: string;
  /** See `OpportunityDetailView.canonicalIsStale`. */
  canonicalIsStale: boolean;
  title: string;
  status: string;
  type: string;
  columns: BoardColumn[];
  comparison: ComparisonRow[];
  apply: BoardApply[];
  descriptions: BoardDescription[];
  extras: BoardExtras[];
  crossPosted: boolean;
  /**
   * Listings detached from this cluster, with when and why.
   *
   * The reason an opportunity with no live members is still worth rendering:
   * without these it is a page asserting it is "a record of what was seen"
   * while showing nothing that was seen.
   */
  formerBoards: {
    /** The membership row, not the listing: one listing can appear twice. */
    membershipId: string;
    column: BoardColumn;
    title: string;
    detachedAt: string;
    /**
     * The same audit metadata a live membership carries.
     *
     * Kept because of what happens when every member has been detached: the
     * live observations are then empty, so these rows are the ONLY record of
     * who grouped this listing and how confidently. Dropping them left the
     * audit section of a fully detached record with nothing in it — an audit
     * trail that exists precisely for the case where it had nothing to show.
     */
    decision: string;
    confidence: number;
    decidedBy: string;
    decidedAt: string;
    dedupeRulesetVersion: string;
    /**
     * Why the listing was GROUPED HERE in the first place — not why it left.
     *
     * `retireLiveMembership` only stamps `supersededAt`; it never rewrites
     * `evidence`, so a retired row still carries the reasons that put the
     * listing in this cluster. Rendering those under a detachment date reads
     * as the reason for removal, attributing "shared application value" to an
     * act it had nothing to do with. The removal's own reason lives on the
     * NEW membership for a reassignment, and nowhere at all for a plain
     * detach — so the honest thing is to label this for what it is.
     */
    groupingReasons: string[];
  }[];
  /**
   * Whether more than one listing was actually grouped into this record.
   *
   * Distinct from `crossPosted`, and the distinction is not academic: the
   * schema permits two live listings from the SAME board in one cluster —
   * transitive linking and manual reassignment both produce it, since the only
   * uniqueness is one live membership per listing. Gating the grouping
   * evidence on `crossPosted` therefore hid the decision, confidence and
   * recorded reasons for a real merge, leaving it uninspectable, whenever both
   * listings happened to come from one board.
   */
  grouped: boolean;
  /** Xtelo's own observations, not board claims — kept apart deliberately. */
  observations: {
    column: BoardColumn;
    firstSeenAt: string;
    lastSeenAt: string;
    fetchedAt: string;
    parserVersion: string;
    extractionMethod: string;
    decision: string;
    confidence: number;
    decidedBy: string;
    decidedAt: string;
    dedupeRulesetVersion: string;
    /**
     * The reasons the dedupe pass RECORDED for this membership, in its own
     * words. Not the same thing as the decision label beside them: the label
     * is this build's generic wording for an enum value, while these are what
     * was actually stored when the decision was made — and they diverge the
     * moment a membership comes from a human reassignment or an older
     * ruleset. Showing only the label would let the screen that exists to
     * explain a grouping quietly misstate it.
     */
    reasons: string[];
  }[];
}

function column(member: OpportunityMemberDetail): BoardColumn {
  return {
    sourceListingId: member.sourceListingId,
    sourceSlug: member.sourceSlug,
    url: member.canonicalUrl,
    status: member.status,
  };
}

/**
 * A cell's comparable identity — what "the same value" means for each kind.
 *
 * For a date that is the Georgian CALENDAR DAY, not the stored instant. The
 * two boards record the same day at different precisions — jobs.ge as local
 * midnight, hr.ge as an end-of-day minute — so comparing instants reported a
 * disagreement on every cross-posted cluster, including the ones where both
 * boards printed the same date. It must use the same function the screen
 * displays with, or the marker and the values beside it can contradict.
 */
function identity(cell: Cell): string {
  switch (cell.kind) {
    case 'text':
      return cell.value;
    case 'date':
      return sourceDayKey(cell.iso);
    case 'status':
      return cell.value;
  }
}

function text(value: string | null | undefined): Cell | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : { kind: 'text', value: trimmed };
}

function date(iso: string | null): Cell | null {
  return iso === null ? null : { kind: 'date', iso };
}

function row(
  key: string,
  label: string,
  note: string,
  cells: (Cell | null)[],
): ComparisonRow | null {
  const present = cells.filter((cell): cell is Cell => cell !== null);
  // A row no board states at all is not rendered as a line of blanks.
  // `data-density.md`: absent fields must simply not be there.
  if (present.length === 0) return null;
  const distinct = new Set(present.map(identity));
  return { key, label, note, cells, differs: distinct.size > 1 };
}

/** jsonb arrives as `unknown`; every read below checks before it trusts. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

/**
 * `specialty`/`industry` display names, tolerant of both the shape hr.ge
 * revisions carry today and the shape a re-crawl on the corrected parser
 * (Phase 3C-2) produces.
 *
 * Pre-`v3` revisions still hold a flat array of strings (`asStrings` alone
 * handles that). `v3` revisions hold real nested taxonomy nodes —
 * `{ sourceTermId, code, name, children }` — so `asStrings` alone would
 * silently filter every one of them out as "not a string" and this field
 * would go blank on every re-crawled hr.ge listing (caught by the commit
 * gate, 2026-09-15, before any re-crawl had actually run). Flattening node
 * names (parent and child both) here reproduces the exact same display text
 * the old flattened-string storage shape used to show directly — this is a
 * DISPLAY fallback only; the real tree is what `structuredAttributes` stores
 * and what the taxonomy tables (Phase 3C-2) are built from.
 */
function asTaxonomyNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  // A revision's structuredAttributes is written by exactly one parser
  // version, so specialty/industry are homogeneous within a revision —
  // either every element is a v2 string or every element is a v3 node,
  // never a mix. Checking the first element decides which shape to read.
  if (typeof value[0] === 'string') return asStrings(value);
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const node = item as Record<string, unknown>;
    if (typeof node.name === 'string' && node.name.trim() !== '') names.push(node.name.trim());
    names.push(...asTaxonomyNames(node.children));
  }
  return names;
}

/**
 * The `reasons` array out of a membership's stored evidence.
 *
 * jsonb, so every level is checked. An evidence object with no readable
 * reasons yields an empty list and the screen falls back to the decision
 * label alone rather than printing an empty section or a raw object.
 */
function evidenceReasons(evidence: unknown): string[] {
  return asStrings(asRecord(evidence).reasons);
}

function locationText(value: unknown): Cell | null {
  const places = asStrings(value);
  return places.length === 0 ? null : { kind: 'text', value: places.join(' · ') };
}

/**
 * An absolute http(s) URL, or null.
 *
 * The value is whatever a board put in its markup, and neither the schema nor
 * the adapters constrain it to a web address. Two cases matter and both are
 * silent failures rather than obvious ones: a RELATIVE value resolves against
 * Xtelo's own origin, so the link would point at this app instead of the
 * source; and a custom scheme reaches the operating system's protocol
 * handlers. Neither is present in the current corpus — measured, all 128 url
 * routes are absolute https — which is exactly why it must be checked here
 * rather than assumed to stay that way.
 */
function webUrl(raw: string): string | null {
  try {
    // No base argument, so a relative value throws instead of being resolved
    // against this app.
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * An address safe to put after `mailto:`.
 *
 * An allowlist, because the obvious check is not enough. "No whitespace and
 * exactly one `@`" accepts `victim@example.ge?bcc=attacker%40example.ge`,
 * which becomes a `mailto:` carrying a BCC the sender never sees — and what is
 * being sent is a job application with a CV attached. Percent-encoding hides
 * the second `@` from any counting rule, so URI delimiters have to be excluded
 * by construction rather than detected after the fact.
 *
 * Hence no `?`, `&`, `%`, `#`, `,`, `;`, `:`, `<`, `>`, quotes or whitespace
 * anywhere, and a domain that has to look like one. `#` is on that list for a
 * quieter reason than the rest: it is legal in an address's local part, but in
 * a URI it opens a fragment, so `mailto:foo#bar@example.com` addresses the
 * message to `foo` — a link that silently sends to the wrong recipient rather
 * than failing. This rejects some
 * addresses RFC 5322 would allow; that is the right trade for a value taken
 * from scraped markup and turned into a link that sends personal data.
 * Measured: every address stored in the corpus still passes (225 real, plus
 * the test rows).
 */
const MAIL_LOCAL = String.raw`[A-Za-z0-9!$*+/=^_\`{|}~'-]+(?:\.[A-Za-z0-9!$*+/=^_\`{|}~'-]+)*`;
const MAIL_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const MAIL_ADDRESS = new RegExp(`^${MAIL_LOCAL}@${MAIL_LABEL}(?:\\.${MAIL_LABEL})+$`);

function mailAddress(raw: string): string | null {
  return MAIL_ADDRESS.test(raw) ? raw : null;
}

function applyRoute(value: unknown): ApplyRoute {
  const method = asRecord(value);
  const type = method.type;
  const raw = typeof method.value === 'string' ? method.value.trim() : '';

  if (type === 'email') {
    const address = mailAddress(raw);
    if (address !== null) return { kind: 'email', address, href: `mailto:${address}` };
  }
  if (type === 'url') {
    const href = webUrl(raw);
    if (href !== null) return { kind: 'url', href };
  }
  if (type === 'form') return { kind: 'onSource' };
  // A route with no value, or one this cannot make safely clickable, degrades
  // to unstated. Rendering it anyway would offer a control that goes nowhere
  // or somewhere unintended, which is worse than saying the board did not say.
  return { kind: 'unstated' };
}

/**
 * The hr.ge fields this schema has no column for, named in English.
 *
 * Curated rather than dumped: `structuredAttributes` also carries the board's
 * own bookkeeping — `listingSection: -1`, `isAnonymous`, `hideContactPerson`,
 * `isPriority` — which describes how hr.ge runs its site, not the vacancy.
 * Printing those would be raw internals reaching the screen, which
 * `anti-patterns.md` forbids in the same breath as raw enums.
 *
 * The VALUES are left exactly as the board wrote them, in Georgian. They are
 * free text from the source, not enums, and translating or normalising them
 * here would be inventing data. The `industry` and `specialty` keys are the
 * input to the taxonomy work; until that exists they are labelled as the
 * board's own filing, not Xtelo's.
 */
const EXTRA_LIST_FIELDS: readonly { key: string; label: string }[] = [
  { key: 'seniorityLevels', label: 'Level' },
  { key: 'languages', label: 'Languages' },
  { key: 'educationLevels', label: 'Education' },
  { key: 'drivingLicenses', label: 'Driving licence' },
  { key: 'benefits', label: 'Benefits' },
  { key: 'specialty', label: 'Filed by the board under' },
  { key: 'industry', label: 'Board’s industry' },
];

const EXTRA_TEXT_FIELDS: readonly { key: string; label: string }[] = [
  { key: 'workScheduleName', label: 'Hours' },
  { key: 'employmentTypeName', label: 'Contract' },
  { key: 'employmentFormTypeName', label: 'Where the work happens' },
];

/**
 * Flags worth printing only when TRUE.
 *
 * A false flag is the board's default, not a statement about this vacancy, and
 * a column of "Remote work: no" on every listing is the kind of noise
 * `data-density.md` warns about.
 */
const EXTRA_TRUE_FLAGS: readonly { key: string; label: string; value: string }[] = [
  { key: 'isWorkFromHome', label: 'Remote', value: 'The board marks this as remote work' },
  {
    key: 'isSuitableForStudent',
    label: 'Students',
    value: 'The board marks this as suitable for students',
  },
];

function extraFields(attributes: unknown): ExtraField[] {
  const record = asRecord(attributes);
  const fields: ExtraField[] = [];

  for (const { key, label } of EXTRA_TEXT_FIELDS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      fields.push({ label, values: [value.trim()] });
    }
  }
  for (const { key, label } of EXTRA_LIST_FIELDS) {
    // specialty/industry read through asTaxonomyNames, not asStrings — see
    // that function's own comment for why (Phase 3C-2's tree-shaped revisions).
    const values =
      key === 'specialty' || key === 'industry'
        ? asTaxonomyNames(record[key])
        : asStrings(record[key]);
    if (values.length > 0) fields.push({ label, values });
  }
  for (const { key, label, value } of EXTRA_TRUE_FLAGS) {
    if (record[key] === true) fields.push({ label, values: [value] });
  }
  return fields;
}

/**
 * Experience, which needs both ends of a range and is absent throughout the
 * current corpus — so it is written to handle either bound alone rather than
 * assuming the pair that no listing has yet supplied.
 */
function experienceField(attributes: unknown): ExtraField | null {
  const record = asRecord(attributes);
  const from = typeof record.workExperienceFrom === 'number' ? record.workExperienceFrom : null;
  const to = typeof record.workExperienceTo === 'number' ? record.workExperienceTo : null;
  if (from === null && to === null) return null;
  if (from !== null && to !== null) {
    return { label: 'Experience', values: [`${from}–${to} years`] };
  }
  return {
    label: 'Experience',
    values: [from !== null ? `${from}+ years` : `up to ${to} years`],
  };
}

export function toDetail(view: OpportunityDetailView): OpportunityDetail {
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
      // Deliberately neutral. An earlier wording said the vacancy was "still
      // up on one board and not on the other", which turns a suspicion into a
      // fact: `missing_suspected` means only that one crawl did not see the
      // listing — the page itself may well still be there, and `labels.ts`
      // says exactly that two lines away. Asserting a takedown the system has
      // not established is the status-softening `anti-patterns.md` forbids,
      // in the opposite direction.
      'The boards report different states, and a missed crawl is a suspicion rather than a takedown.',
      members.map((m): Cell => ({ kind: 'status', value: m.status })),
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
    canonicalIsStale: view.canonicalIsStale,
    title: view.canonicalTitle,
    status: view.canonicalStatus,
    type: view.type,
    columns,
    comparison,
    apply: members.map((member) => ({
      column: column(member),
      route: applyRoute(member.applicationMethod),
    })),
    // Kept per board and in board order. Concatenating them is what the
    // ranking layer does internally, and `anti-patterns.md` classes letting
    // that leak into the UI as lost provenance.
    descriptions: members
      .filter((member) => member.description.trim() !== '')
      .map((member) => ({ column: column(member), text: member.description })),
    extras,
    // One entry per SOURCE, matching how the list screen counts cross-posting:
    // two memberships from the same board are a data problem, not a second
    // board carrying the vacancy.
    crossPosted: new Set(members.map((member) => member.sourceSlug)).size > 1,
    grouped: members.length > 1,
    formerBoards: view.formerMembers.map((member) => ({
      membershipId: member.membershipId,
      column: column(member),
      title: member.title,
      detachedAt: member.supersededAt ?? '',
      decision: member.decision,
      confidence: member.confidence,
      decidedBy: member.decidedBy,
      decidedAt: member.decidedAt,
      dedupeRulesetVersion: member.dedupeRulesetVersion,
      groupingReasons: evidenceReasons(member.evidence),
    })),
    observations: members.map((member) => ({
      column: column(member),
      firstSeenAt: member.firstSeenAt,
      lastSeenAt: member.lastSeenAt,
      fetchedAt: member.fetchedAt,
      parserVersion: member.parserVersion,
      extractionMethod: member.extractionMethod,
      decision: member.decision,
      confidence: member.confidence,
      decidedBy: member.decidedBy,
      decidedAt: member.decidedAt,
      dedupeRulesetVersion: member.dedupeRulesetVersion,
      reasons: evidenceReasons(member.evidence),
    })),
  };
}
