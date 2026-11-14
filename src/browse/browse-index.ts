import { sql } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../db/types.js';
import { type BrowseKind, kindOfType } from './browse-form.js';
import { toEur, toGel } from './reference-rates.js';

/**
 * Browse v2's rows, read once and held in memory (Phase 16C). Every filter,
 * count and order on the screen is worked out from this in TypeScript
 * (`browse-engine.ts`): a few thousand open opportunities, so counts on every
 * option, the kind counts and "how many a filter leaves out" are cheap and
 * exact, where one SQL query per count was not (the same call as Phase 15's
 * choice I for programmes).
 *
 * One read per surface: `loadBrowseIndex` over the base tables for the local
 * edition (every state), `loadPublicBrowseIndex` over the public views only
 * (`public-queries.ts` explains why the public role may read nothing else).
 * Public eligibility (open now) is checked when a page is answered, not here,
 * since it moves with the clock.
 */

export interface BrowseMember {
  sourceListingId: string;
  sourceSlug: string;
  status: string;
  title: string;
  organization: string | null;
  url: string;
  deadlineAt: string | null;
  deadlineMs: number | null;
  firstSeenAt: string;
  firstSeenMs: number;
}

export interface Money {
  amount: number;
  currency: string;
}

export interface BrowseItem {
  id: string;
  type: string;
  /** Null for a programme kind that has no Browse kind yet: it shows under "All". */
  kind: BrowseKind | null;
  title: string;
  /** The cluster's state (local: the stored one; public: from its visible members). */
  status: string;
  members: BrowseMember[];
  /** Distinct boards, sorted. */
  boards: string[];
  /** Distinct organisations (employer, buyer or school). */
  orgs: string[];
  firstSeenMs: number;
  firstSeenAt: string;
  /** The latest deadline any member states. */
  deadlineMs: number | null;
  deadlineAt: string | null;
  /** Whether the members' deadlines differ by calendar day. */
  deadlinesDisagree: boolean;
  /** Every member's searchable text (title, organisation, places, categories), one per line. */
  hay: string;

  // ---- Facts. Merged over the members: lists joined, a single value from the first that states it.
  /** Places in Georgia as the board names them (hr.ge's locations, a tender's delivery places). */
  cities: string[];
  /** `g:<city>` for a vacancy, `c:<country>` for a course. */
  places: string[];
  /** `j:<field>`, `t:<CPV division>`, `c:<field of study>`. */
  fields: string[];
  /**
   * Phase 16D: the job's field is a guess from its text (jobs.ge states none),
   * taken only when no member states one. Shown as a guess, never as stated.
   */
  fieldGuessed: boolean;
  /**
   * Phase 16E: the job's cities are read from its text (jobs.ge states none),
   * taken only when no member states one.
   */
  citiesRead: boolean;
  industries: string[];
  /** Lari a month, as hr.ge states it: "1500-?" is [1500, null]. */
  salary: [number | null, number | null] | null;
  contract: string | null;
  hours: string | null;
  workplace: string | null;
  seniority: string[];
  education: string[];
  /** Null where no member states languages; [] where one asks for none. */
  languages: string[] | null;
  licences: string[] | null;
  benefits: string[] | null;
  bonus: boolean | null;
  students: boolean | null;
  /** The first CPV code's label, as etenders.ge gives it. */
  cpvLabel: string | null;
  method: string | null;
  submission: string | null;
  value: (Money & { vat: string | null }) | null;
  valueGel: number | null;
  tenderNumber: string | null;
  country: string | null;
  city: string | null;
  online: boolean;
  start: string | null;
  end: string | null;
  days: number | null;
  disciplines: string[];
  fee: Money | null;
  feeEur: number | null;
  credits: number | null;
  teaching: string[];
  earlyBird: string | null;
}

/** One member row as the loaders read it. */
export interface IndexRow {
  opportunityId: string;
  type: string;
  canonicalTitle: string | null;
  canonicalStatus: string | null;
  sourceListingId: string;
  sourceSlug: string;
  status: string;
  title: string;
  organization: string | null;
  url: string;
  deadlineAt: string | null;
  firstSeenAt: string;
  hay: string;
  locations: unknown;
  salaryRaw: string | null;
  facts: Record<string, unknown>;
  /** Phase 16D: a field guessed from the text, for a board that states none. */
  guessedField: string | null;
  /** Phase 16E: the places the text names, for a board that states no city. */
  readCities: unknown;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
        .map((v) => v.trim())
    : [];
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/** hr.ge's salary text: "1500-?", "1500-2000", "?-2000". Anything else states nothing. */
export function parseSalary(raw: string | null): [number | null, number | null] | null {
  if (raw === null) return null;
  const match = /^\s*(\d+|\?)\s*-\s*(\d+|\?)\s*$/.exec(raw);
  if (match === null) return null;
  const lo = match[1] === '?' ? null : Number(match[1]);
  const hi = match[2] === '?' ? null : Number(match[2]);
  if (lo === null && hi === null) return null;
  return [lo, hi];
}

/** A money object a source wrote (`{amount, currency}`), or null. */
function money(value: unknown): Money | null {
  if (typeof value !== 'object' || value === null) return null;
  const amount = num((value as Record<string, unknown>).amount);
  const currency = text((value as Record<string, unknown>).currency);
  return amount === null || currency === null ? null : { amount, currency: currency.toUpperCase() };
}

const union = (target: string[], values: readonly string[]) => {
  for (const v of values) if (!target.includes(v)) target.push(v);
};

const PUBLIC_STATUS_PRECEDENCE = ['active', 'missing_suspected', 'discovered', 'expired'];

/**
 * The rows, one per opportunity, from member rows in any order. Members are
 * taken in `sourceListingId` order, so "the first that states it" and the
 * public title (the same tie-break `resolveCanonicalOpportunity` uses) do not
 * depend on the database's row order.
 */
export function assembleIndex(rows: readonly IndexRow[]): BrowseItem[] {
  const groups = new Map<string, IndexRow[]>();
  for (const row of rows) {
    const list = groups.get(row.opportunityId);
    if (list === undefined) groups.set(row.opportunityId, [row]);
    else list.push(row);
  }
  const items: BrowseItem[] = [];
  for (const [id, group] of groups) {
    group.sort((a, b) => (a.sourceListingId < b.sourceListingId ? -1 : 1));
    const first = group[0];
    if (first === undefined) continue;
    const members: BrowseMember[] = group.map((row) => ({
      sourceListingId: row.sourceListingId,
      sourceSlug: row.sourceSlug,
      status: row.status,
      title: row.title,
      organization: row.organization,
      url: row.url,
      deadlineAt: row.deadlineAt,
      deadlineMs: row.deadlineAt === null ? null : Date.parse(row.deadlineAt),
      firstSeenAt: row.firstSeenAt,
      firstSeenMs: Date.parse(row.firstSeenAt),
    }));
    const kind = kindOfType(first.type);
    const item: BrowseItem = {
      id,
      type: first.type,
      kind,
      title: first.canonicalTitle ?? first.title,
      status:
        first.canonicalStatus ??
        PUBLIC_STATUS_PRECEDENCE.find((s) => members.some((m) => m.status === s)) ??
        'closed',
      members,
      boards: [...new Set(members.map((m) => m.sourceSlug))].sort(),
      orgs: [],
      firstSeenMs: Number.POSITIVE_INFINITY,
      firstSeenAt: first.firstSeenAt,
      deadlineMs: null,
      deadlineAt: null,
      deadlinesDisagree: false,
      hay: group.map((row) => row.hay).join('\n'),
      cities: [],
      places: [],
      fields: [],
      fieldGuessed: false,
      citiesRead: false,
      industries: [],
      salary: null,
      contract: null,
      hours: null,
      workplace: null,
      seniority: [],
      education: [],
      languages: null,
      licences: null,
      benefits: null,
      bonus: null,
      students: null,
      cpvLabel: null,
      method: null,
      submission: null,
      value: null,
      valueGel: null,
      tenderNumber: null,
      country: null,
      city: null,
      online: false,
      start: null,
      end: null,
      days: null,
      disciplines: [],
      fee: null,
      feeEur: null,
      credits: null,
      teaching: [],
      earlyBird: null,
    };
    const deadlineDays = new Set<string>();
    for (const [index, member] of members.entries()) {
      if (member.organization !== null && member.organization.trim() !== '') {
        union(item.orgs, [member.organization.trim()]);
      }
      if (member.firstSeenMs < item.firstSeenMs) {
        item.firstSeenMs = member.firstSeenMs;
        item.firstSeenAt = member.firstSeenAt;
      }
      if (member.deadlineMs !== null && member.deadlineAt !== null) {
        // Tbilisi's calendar day: two boards printing the same date are not a disagreement.
        deadlineDays.add(new Date(member.deadlineMs + 4 * 3600_000).toISOString().slice(0, 10));
        if (item.deadlineMs === null || member.deadlineMs > item.deadlineMs) {
          item.deadlineMs = member.deadlineMs;
          item.deadlineAt = member.deadlineAt;
        }
      }
      const row = group[index];
      if (row !== undefined) addFacts(item, row);
    }
    item.deadlinesDisagree = deadlineDays.size > 1;
    if (kind === 'job' && item.cities.length === 0) {
      const read = group.flatMap((row) => strings(row.readCities));
      if (read.length > 0) {
        union(item.cities, read);
        item.citiesRead = true;
      }
    }
    if (kind === 'job' && item.fields.length === 0) {
      const guesses = group.flatMap((row) => (row.guessedField === null ? [] : [row.guessedField]));
      if (guesses.length > 0) {
        union(
          item.fields,
          guesses.map((g) => `j:${g}`),
        );
        item.fieldGuessed = true;
      }
    }
    if (kind === 'job') item.places = item.cities.map((c) => `g:${c}`);
    if (kind === 'course' && item.country !== null) item.places = [`c:${item.country}`];
    item.valueGel = item.value === null ? null : toGel(item.value.amount, item.value.currency);
    item.feeEur = item.fee === null ? null : toEur(item.fee.amount, item.fee.currency);
    items.push(item);
  }
  return items;
}

function addFacts(item: BrowseItem, row: IndexRow) {
  const f = row.facts;
  // A tender's delivery places and hr.ge's cities are both board place names in Georgian.
  if (item.kind !== 'course') union(item.cities, strings(row.locations));
  item.salary ??= parseSalary(row.salaryRaw);

  if (item.kind === 'job') {
    union(
      item.fields,
      strings(f.spec).map((s) => `j:${s}`),
    );
    union(item.industries, strings(f.ind));
    item.contract ??= text(f.emp);
    item.hours ??= text(f.sched);
    item.workplace ??= text(f.form);
    union(item.seniority, strings(f.sen));
    union(item.education, strings(f.edu));
    if (Array.isArray(f.lang)) {
      item.languages ??= [];
      union(item.languages, strings(f.lang));
    }
    if (Array.isArray(f.lic)) {
      item.licences ??= [];
      union(item.licences, strings(f.lic));
    }
    if (Array.isArray(f.ben)) {
      item.benefits ??= [];
      union(item.benefits, strings(f.ben));
    }
    item.bonus ??= bool(f.bonus);
    item.students ??= bool(f.stud);
  }
  if (item.kind === 'tender') {
    if (Array.isArray(f.cpv)) {
      for (const entry of f.cpv) {
        if (typeof entry !== 'object' || entry === null) continue;
        const code = text((entry as Record<string, unknown>).code);
        if (code === null || !/^\d{2}/.test(code)) continue;
        union(item.fields, [`t:${code.slice(0, 2)}`]);
        item.cpvLabel ??= text((entry as Record<string, unknown>).label);
      }
    }
    item.method ??= text(f.method);
    item.submission ??= text(f.subm);
    const value = money(f.maxValue);
    if (item.value === null && value !== null) {
      const vat =
        (typeof f.maxValue === 'object' && f.maxValue !== null
          ? text((f.maxValue as Record<string, unknown>).vat)
          : null) ?? text(f.vat);
      item.value = { ...value, vat };
    }
    item.tenderNumber ??= text(f.num);
  }
  if (item.kind === 'course') {
    item.country ??= text(f.country);
    item.city ??= text(f.city);
    if (text(f.format)?.toLowerCase() === 'online') item.online = true;
    item.start ??= text(f.start);
    item.end ??= text(f.end);
    item.days ??= num(f.days);
    union(item.disciplines, strings(f.disc));
    union(
      item.fields,
      strings(f.disc).map((d) => `c:${d}`),
    );
    item.fee ??= money(f.fee);
    if (item.credits === null && typeof f.credits === 'object' && f.credits !== null) {
      item.credits = num((f.credits as Record<string, unknown>).amount);
    }
    union(
      item.teaching,
      (text(f.clang) ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    );
    item.earlyBird ??= text(f.early);
  }
}

/**
 * The facts each source states, picked out of a revision's attributes in SQL
 * so only what Browse reads leaves the database (hr.ge's field trees, a
 * tender's documents and the rest stay behind). `a` is the attributes column.
 */
function factsSql(a: ReturnType<typeof sql>) {
  return sql`jsonb_strip_nulls(jsonb_build_object(
    'spec', jsonb_path_query_array(${a}->'specialty', 'lax $[*].name'),
    'ind', jsonb_path_query_array(${a}->'industry', 'lax $[*].name'),
    'sen', ${a}->'seniorityLevels',
    'edu', ${a}->'educationLevels',
    'lang', ${a}->'languages',
    'emp', ${a}->'employmentTypeName',
    'sched', ${a}->'workScheduleName',
    'form', ${a}->'employmentFormTypeName',
    'bonus', ${a}->'isWithBonus',
    'stud', ${a}->'isSuitableForStudent',
    'lic', ${a}->'drivingLicenses',
    'ben', ${a}->'benefits',
    'cpv', ${a}->'cpv',
    'method', ${a}->'method'->'text',
    'subm', ${a}->'submission',
    'maxValue', ${a}->'maxValue',
    'vat', ${a}->'priceBasis'->'vat',
    'num', ${a}->'tenderNumber',
    'country', ${a}->'country',
    'city', ${a}->'city',
    'format', ${a}->'format',
    'start', ${a}->'startDate',
    'end', ${a}->'endDate',
    'days', ${a}->'durationDays',
    'disc', jsonb_path_query_array(${a}->'disciplines', 'lax $[*].name'),
    'fee', ${a}->'fee',
    'credits', ${a}->'credits',
    'clang', ${a}->'language',
    'early', ${a}->'earlyBirdDeadline'
  ))`;
}

/**
 * A revision's guessed field (Phase 16D), as `public_opportunity_members`'
 * `guessed_field` reads it: keep the two the same.
 */
function guessedFieldSql(revisionId: ReturnType<typeof sql>) {
  return sql`(select t.label from listing_classifications lc
       join taxonomy_terms t on t.id = lc.taxonomy_term_id and t.parent_id is null
       where lc.source_listing_revision_id = ${revisionId}
         and lc.axis = 'profession' and lc.superseded_at is null
         and lc.method in ('keyword', 'human_review')
       order by (lc.method = 'human_review') desc, lc.confidence desc, lc.id
       limit 1)`;
}

/** A revision's read places (Phase 16E), as the public view's `read_cities` reads them. */
function readCitiesSql(revisionId: ReturnType<typeof sql>) {
  return sql`(select coalesce(jsonb_agg(t.label order by (lc.evidence->>'order')::int nulls last, t.label), '[]'::jsonb)
       from listing_classifications lc
       join taxonomy_terms t on t.id = lc.taxonomy_term_id
       where lc.source_listing_revision_id = ${revisionId}
         and lc.axis = 'location' and lc.superseded_at is null
         and lc.method in ('keyword', 'human_review'))`;
}

interface RawRow extends Record<string, unknown> {
  opportunity_id: string;
  type: string;
  canonical_title: string | null;
  canonical_status: string | null;
  source_listing_id: string;
  source_slug: string;
  status: string;
  title: string;
  organization: string | null;
  url: string;
  deadline_at: string | Date | null;
  first_seen_at: string | Date;
  hay: string;
  locations: unknown;
  salary_raw: string | null;
  facts: Record<string, unknown> | null;
  guessed_field: string | null;
  read_cities: unknown;
}

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function toIndexRow(row: RawRow): IndexRow {
  return {
    opportunityId: row.opportunity_id,
    type: row.type,
    canonicalTitle: row.canonical_title,
    canonicalStatus: row.canonical_status,
    sourceListingId: row.source_listing_id,
    sourceSlug: row.source_slug,
    status: row.status,
    title: row.title,
    organization: row.organization,
    url: row.url,
    deadlineAt: row.deadline_at === null ? null : iso(row.deadline_at),
    firstSeenAt: iso(row.first_seen_at),
    hay: row.hay,
    locations: row.locations,
    salaryRaw: row.salary_raw,
    facts: row.facts ?? {},
    guessedField: row.guessed_field,
    readCities: row.read_cities,
  };
}

async function rowsOf(
  db: DatabaseOrTransaction,
  query: ReturnType<typeof sql>,
): Promise<IndexRow[]> {
  const result = await db.execute<RawRow>(query);
  const rows = Array.isArray(result) ? result : (result as { rows: RawRow[] }).rows;
  return rows.map(toIndexRow);
}

/**
 * Every opportunity with a live member, in every state, with its live
 * members: the local edition's Browse (the same rows `searchOpportunities`
 * walks). The search text is the same four fields its search reads.
 */
export async function loadBrowseIndex(db: DatabaseOrTransaction): Promise<BrowseItem[]> {
  const rows = await rowsOf(
    db,
    sql`select o.id as opportunity_id, o.type::text as type,
          o.canonical_title, o.canonical_status::text as canonical_status,
          sl.id as source_listing_id, s.slug as source_slug, sl.status::text as status,
          r.title_raw as title, r.organization_raw as organization,
          sl.canonical_source_url as url, sl.source_deadline_at as deadline_at,
          sl.first_seen_at,
          concat_ws(' ', r.title_raw, r.organization_raw, r.locations::text, r.source_categories::text) as hay,
          r.locations, r.salary_raw,
          ${factsSql(sql`r.structured_attributes`)} as facts,
          ${guessedFieldSql(sql`r.id`)} as guessed_field,
          ${readCitiesSql(sql`r.id`)} as read_cities
        from opportunities o
        join opportunity_source_memberships m on m.opportunity_id = o.id and m.superseded_at is null
        join source_listings sl on sl.id = m.source_listing_id
        join sources s on s.id = sl.source_id
        join source_listing_revisions r on r.id = sl.current_revision_id`,
  );
  return assembleIndex(rows);
}

/**
 * The public catalogue's rows, from `public_opportunity_members` and
 * `public_opportunities` only. Title and state come from the visible
 * members, never the stored columns (`public-queries.ts`,
 * `deriveCanonicalTitle`, says why).
 */
export async function loadPublicBrowseIndex(db: DatabaseOrTransaction): Promise<BrowseItem[]> {
  const rows = await rowsOf(
    db,
    sql`select pom.opportunity_id, po.type::text as type,
          null::text as canonical_title, null::text as canonical_status,
          pom.source_listing_id, pom.source_slug, pom.status::text as status,
          pom.title, pom.organization, pom.canonical_url as url,
          pom.deadline_at, pom.first_seen_at,
          concat_ws(' ', pom.title, pom.organization, pom.locations::text, pom.source_categories::text) as hay,
          pom.locations, pom.salary_raw,
          ${factsSql(sql`pom.structured_attributes`)} as facts,
          pom.guessed_field, pom.read_cities
        from public_opportunity_members pom
        join public_opportunities po on po.id = pom.opportunity_id`,
  );
  return assembleIndex(rows);
}
