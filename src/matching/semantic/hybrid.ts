import type { BundleOpportunity } from '../bundle/schema.js';
import { LEXICON } from '../lexical/lexicon.js';
import type { MatchProfile, ProfileTerm } from '../lexical/profile.js';
import {
  activeTerms,
  hardFilter,
  type IndexedOpportunity,
  indexOpportunities,
  LEXICAL_RANK_VERSION,
  type MatchReason,
  type RankingStats,
  rankOpportunities,
} from '../lexical/rank.js';
import { findPhrase, phraseStems } from '../lexical/text.js';
import { STATIC_E1_PIN } from '../models/static-e1.js';
import { embed, type StaticModel } from './static-embed.js';
import { englishTitle, type TitleDictionary } from './title-english.js';
import { type RoleHit, roleSimilarList, type TitleVectors } from './title-vectors.js';

/**
 * CV Ranked's ranking: the lexical ranker fused with title similarity.
 * Browser-safe: pure, no Node import.
 *
 * Title similarity comes from one of two places:
 * - **Role vectors** (bundle schema 2, `title-vectors.ts`), the main path:
 *   each active lexicon role's precomputed vector against each title's.
 *   Lexical matching plus this list at weight 2 judged nDCG@10 .833 on the
 *   32 English and Georgian CVs of the suite, against .763 for the path
 *   below, with no model in the browser at all.
 * - **The static E1 model** (spike/semantic), the fallback: needed only
 *   when no active role has a vector (the rules found none, or found only
 *   titles outside the lexicon), when the user typed a role the lexicon
 *   does not know, or when the bundle is schema 1 and carries no vectors.
 *   It adds three lists:
 *   1. lexical matching against each title's English key
 *      (`title-english.ts`), so an English CV meets Georgian titles the
 *      lexicon does not bridge (whole roles only; see `rankHybrid`);
 *   2. and 3. similarity, Georgian titles and English keys, to the active
 *      roles and to the CV's short lines ("Senior accountant").
 *
 * Lists are combined by weighted reciprocal-rank fusion. Similarity only
 * ever adds a row; it never excludes one, and every row still passes the
 * same deadline and location filters.
 */

/** The static path's version, unchanged from before role vectors existed. */
export const HYBRID_RANK_VERSION = `hybrid-v1+${LEXICAL_RANK_VERSION}+${STATIC_E1_PIN.id}`;

/**
 * The static path's weights, as the spike judged best ("lex+semL
 * (1,.25,.25,.25)"): the lexical list carries full weight and the rest a
 * quarter each, so a row reached only by similarity ranks after the word
 * matches rather than displacing them.
 */
export const FUSION_WEIGHTS = {
  lexical: 1,
  lexicalEnglish: 0.25,
  similarGeorgian: 0.25,
  similarEnglish: 0.25,
} as const;
/**
 * The role-vector list's weight. Judged on the 34-CV suite: weights 1, 2
 * and 3 against the lexical list; 2 was best, and the list is reliable
 * enough to lead where it and the word matches disagree.
 */
export const ROLE_LIST_WEIGHT = 2;
/** The usual reciprocal-rank-fusion constant. */
const RRF_K = 60;
/** How far down each static similarity list counts. */
export const SIMILAR_LIST_LENGTH = 100;
/**
 * A row stays in a static similarity list only while its cosine is at least
 * this share of the list's best. Relative, not absolute: static-embedding
 * cosines across scripts are low but still well ordered (a Russian CV's
 * best Georgian titles score under 0.3 and still judge nDCG@10 .698), so an
 * absolute cut removed real matches before it removed noise. Measured on
 * the judged suite: no cut .790 with 56 non-relevant similarity-only rows
 * in the 33 CVs' top 20s; 0.9 gives .797 and 18; 0.93 and above start
 * losing the Russian CV (.502).
 */
export const SIMILAR_RELATIVE_FLOOR = 0.9;

const MAX_LINES = 60;
const MAX_LINE_WORDS = 10;
const MIN_LINE_CHARS = 3;
const CONTACT = /@|\+?\d[\d\s-]{6,}|https?:|www\./;
const BULLET = /^[\s•▪–*-]+/u;
const GEORGIAN = /\p{Script=Georgian}/u;

export type HybridReason =
  | MatchReason
  /** A role matched the title's English key rather than the title as written. */
  | { kind: 'translated-role'; term: string }
  /** The title is close to an active role, or to a short line of the CV. */
  | { kind: 'similar'; term: string; from: 'role' | 'cv' };

export interface HybridRanked {
  row: BundleOpportunity;
  /** The fused reciprocal-rank score: an ordering, not a probability of fit. */
  score: number;
  reasons: HybridReason[];
  locationUnstated: boolean;
}

/**
 * What title similarity compared vacancy titles with: the active roles
 * alone (role vectors), the roles and the CV's short lines too (the static
 * model), or nothing, which means word matching alone.
 */
export type HybridSimilarity = 'roles' | 'roles-and-cv' | 'none';

export interface HybridResult {
  version: string;
  similarity: HybridSimilarity;
  results: HybridRanked[];
  stats: RankingStats;
}

/** The static model's per-bundle precomputation; a few thousand titles take well under a second. */
export interface StaticIndex {
  model: StaticModel;
  /** The same rows with each title replaced by its English key. */
  english: IndexedOpportunity[];
  dims: number;
  /** Row-major, one unit vector per row (all zeros when nothing was known). */
  georgianVectors: Float32Array;
  englishVectors: Float32Array;
}

export interface HybridIndex {
  lexical: IndexedOpportunity[];
  position: ReadonlyMap<string, number>;
  /** Null until the static model is loaded (`withStaticModel`). */
  static: StaticIndex | null;
}

export function indexHybrid(rows: readonly BundleOpportunity[]): HybridIndex {
  return {
    lexical: indexOpportunities(rows),
    position: new Map(rows.map((row, i) => [row.opportunityId, i])),
    static: null,
  };
}

/** Adds the static model's vectors to an index, once that model has loaded. */
export function withStaticModel(
  index: HybridIndex,
  model: StaticModel,
  dictionary: TitleDictionary,
): HybridIndex {
  const rows = index.lexical.map((opportunity) => opportunity.row);
  const dims = model.table.dims;
  const georgianVectors = new Float32Array(rows.length * dims);
  const englishVectors = new Float32Array(rows.length * dims);
  const englishRows = rows.map((row, i) => {
    const key = englishTitle(row.title, dictionary).text || row.title;
    georgianVectors.set(embedText(row.title, model), i * dims);
    englishVectors.set(embedText(key, model), i * dims);
    return { ...row, title: key };
  });
  return {
    ...index,
    static: {
      model,
      english: indexOpportunities(englishRows),
      dims,
      georgianVectors,
      englishVectors,
    },
  };
}

function embedText(text: string, model: StaticModel): Float32Array {
  return embed(model.tokenizer.encode(text), model.table);
}

/**
 * The CV's short lines — headings, job titles, skill lines — which carry
 * most of what a title can be similar to. Contact lines are dropped, and
 * long sentences, which read as prose rather than as a title.
 */
export function cvLines(text: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of text.normalize('NFKC').split('\n')) {
    const line = raw.replace(BULLET, '').replace(/\s+/gu, ' ').trim();
    if (line.length < MIN_LINE_CHARS || line.split(' ').length > MAX_LINE_WORDS) continue;
    if (CONTACT.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
    if (lines.length === MAX_LINES) break;
  }
  return lines;
}

/** What the similarity lists are ranked against, kept for the life of one CV. */
export interface CvSource {
  lines: readonly string[];
  /** The profile as first derived from the CV, before any edit. */
  derived: readonly ProfileTerm[];
}

/**
 * Whether this profile needs the static model: when no active role has a
 * vector, or when the user added a role that has none. A role the CV
 * itself yielded without a vector (a bundle title outside the lexicon) does
 * not by itself: the judged runs left those to the lexical list.
 */
export function needsStaticModel(
  profile: MatchProfile,
  cv: CvSource,
  vectors: TitleVectors | null,
): boolean {
  if (vectors === null) return true;
  const roles = activeTerms(profile, 'role');
  if (!roles.some((role) => vectors.roleRow.has(role.id))) return true;
  const derived = new Set(cv.derived.map((term) => term.id));
  return roles.some((role) => !vectors.roleRow.has(role.id) && !derived.has(role.id));
}

interface Query {
  vector: Float32Array;
  /** What the explanation names: a role's label or the CV line itself. */
  label: string;
  from: 'role' | 'cv';
}

const LEXICON_BY_ID = new Map(LEXICON.map((entry) => [`${entry.kind}:${entry.key}`, entry]));

/**
 * The queries for both static similarity lists. A CV line is left out when
 * it contains a term the user switched off or removed, so switching off
 * "Accountant" is not undone by the CV line that says "Senior accountant".
 */
function buildQueries(
  profile: MatchProfile,
  cv: CvSource,
  model: StaticModel,
  dictionary: TitleDictionary,
): { georgian: Query[]; english: Query[] } {
  const georgian: Query[] = [];
  const english: Query[] = [];
  const push = (list: Query[], text: string, label: string, from: 'role' | 'cv') => {
    const vector = embedText(text, model);
    if (vector.some((value) => value !== 0)) list.push({ vector, label, from });
  };

  for (const role of activeTerms(profile, 'role')) {
    const entry = LEXICON_BY_ID.get(role.id);
    push(georgian, entry?.ka ?? role.label, role.label, 'role');
    const en = entry?.en ?? englishTitle(role.label, dictionary).text;
    if (en !== '') push(english, en, role.label, 'role');
  }

  const current = new Map(profile.terms.map((term) => [term.id, term]));
  const off = cv.derived.filter((term) => current.get(term.id)?.active !== true);
  for (const line of cv.lines) {
    const stems = phraseStems(line);
    if (off.some((term) => term.forms.some((form) => findPhrase(stems, form) !== -1))) continue;
    if (GEORGIAN.test(line)) {
      push(georgian, line, line, 'cv');
      const en = englishTitle(line, dictionary).text;
      if (en !== '') push(english, en, line, 'cv');
    } else {
      push(english, line, line, 'cv');
    }
  }
  return { georgian, english };
}

interface Similar {
  position: number;
  score: number;
  query: Query;
}

/** Rows by their best cosine to any query, eligible rows only, best first. */
function similarList(
  queries: readonly Query[],
  vectors: Float32Array,
  dims: number,
  eligible: Uint8Array,
): Similar[] {
  if (queries.length === 0) return [];
  const found: Similar[] = [];
  for (let position = 0; position < eligible.length; position++) {
    if (eligible[position] === 0) continue;
    const base = position * dims;
    let best = Number.NEGATIVE_INFINITY;
    let bestQuery: Query | null = null;
    for (const query of queries) {
      let dot = 0;
      for (let d = 0; d < dims; d++) dot += (query.vector[d] ?? 0) * (vectors[base + d] ?? 0);
      if (dot > best) {
        best = dot;
        bestQuery = query;
      }
    }
    if (bestQuery !== null) {
      found.push({ position, score: best, query: bestQuery });
    }
  }
  found.sort((a, b) => b.score - a.score || a.position - b.position);
  const floor = (found[0]?.score ?? 0) * SIMILAR_RELATIVE_FLOOR;
  return found.filter((hit) => hit.score >= floor).slice(0, SIMILAR_LIST_LENGTH);
}

export interface RankInputs {
  dictionary: TitleDictionary;
  /** The bundle's title vectors; null for a schema 1 bundle, which has none. */
  vectors: TitleVectors | null;
}

export function rankHybrid(
  profile: MatchProfile,
  cv: CvSource,
  index: HybridIndex,
  inputs: RankInputs,
  options: { now: number },
): HybridResult {
  const lexical = rankOpportunities(profile, index.lexical, options);

  const locations = activeTerms(profile, 'location');
  const filters = index.lexical.map((opportunity) =>
    hardFilter(opportunity, locations, options.now),
  );
  const eligible = Uint8Array.from(filters, (filter) => (filter.excluded === null ? 1 : 0));

  const roles = activeTerms(profile, 'role');
  const roleHits: RoleHit[] =
    inputs.vectors === null
      ? []
      : roleSimilarList(
          roles.map((role) => role.id),
          inputs.vectors,
          eligible,
        );
  const staticIndex =
    index.static !== null && needsStaticModel(profile, cv, inputs.vectors) ? index.static : null;

  const fused = new Map<number, number>();
  const fuse = (positions: readonly number[], weight: number) => {
    positions.forEach((position, rank) => {
      fused.set(position, (fused.get(position) ?? 0) + weight / (RRF_K + rank + 1));
    });
  };
  const at = (opportunityId: string) => index.position.get(opportunityId) ?? -1;
  fuse(
    lexical.results.map((result) => at(result.row.opportunityId)),
    FUSION_WEIGHTS.lexical,
  );
  fuse(
    roleHits.map((hit) => hit.position),
    ROLE_LIST_WEIGHT,
  );

  let lexicalEnglish: typeof lexical.results = [];
  const similarAt = new Map<number, Similar>();
  if (staticIndex !== null) {
    // From English keys only a role the key actually contains counts. The
    // lexical ranker's partial matches (a shared head noun, trigram
    // closeness) are too loose on dictionary keys: "software engineer" met
    // every "HVAC engineer". Judged: nDCG@10 unchanged (.797 -> .798), and
    // 11 translated-role rows in the suite's top 20s, 2 relevant, became 1.
    lexicalEnglish = rankOpportunities(profile, staticIndex.english, options).results.filter(
      (result) => result.reasons.some((reason) => reason.kind === 'role' && reason.exact),
    );
    const queries = buildQueries(profile, cv, staticIndex.model, inputs.dictionary);
    const similarGeorgian = similarList(
      queries.georgian,
      staticIndex.georgianVectors,
      staticIndex.dims,
      eligible,
    );
    const similarEnglish = similarList(
      queries.english,
      staticIndex.englishVectors,
      staticIndex.dims,
      eligible,
    );
    fuse(
      lexicalEnglish.map((result) => at(result.row.opportunityId)),
      FUSION_WEIGHTS.lexicalEnglish,
    );
    fuse(
      similarGeorgian.map((hit) => hit.position),
      FUSION_WEIGHTS.similarGeorgian,
    );
    fuse(
      similarEnglish.map((hit) => hit.position),
      FUSION_WEIGHTS.similarEnglish,
    );
    for (const hit of [...similarGeorgian, ...similarEnglish]) {
      const known = similarAt.get(hit.position);
      if (known === undefined || hit.score > known.score) similarAt.set(hit.position, hit);
    }
  }
  fused.delete(-1);

  const byId = <T extends { row: BundleOpportunity }>(list: readonly T[]) =>
    new Map(list.map((item) => [item.row.opportunityId, item]));
  const lexicalById = byId(lexical.results);
  const englishById = byId(lexicalEnglish);
  const roleLabel = new Map(roles.map((role) => [role.id, role.label]));
  const roleAt = new Map(roleHits.map((hit) => [hit.position, hit]));

  const results: HybridRanked[] = [];
  for (const [position, score] of fused) {
    const opportunity = index.lexical[position];
    const filter = filters[position];
    if (opportunity === undefined || filter === undefined || filter.excluded !== null) continue;
    const id = opportunity.row.opportunityId;
    const reasons: HybridReason[] = [...(lexicalById.get(id)?.reasons ?? [])];
    if (reasons.length === 0 && filter.location !== null) reasons.push(filter.location);
    const hasRole = () =>
      reasons.some((reason) => reason.kind === 'role' || reason.kind === 'translated-role');
    for (const reason of englishById.get(id)?.reasons ?? []) {
      // Only the role can differ: fields, categories and locations do not
      // depend on the title, and a skill "in its title" would be claimed of
      // a translation the user never sees.
      if (reason.kind === 'role' && !hasRole()) {
        reasons.push({ kind: 'translated-role', term: reason.term });
      }
    }
    const role = roleAt.get(position);
    const similar = similarAt.get(position);
    if (!hasRole()) {
      if (role !== undefined) {
        reasons.push({
          kind: 'similar',
          term: roleLabel.get(role.roleId) ?? role.roleId,
          from: 'role',
        });
      } else if (similar !== undefined) {
        reasons.push({ kind: 'similar', term: similar.query.label, from: similar.query.from });
      }
    }
    results.push({
      row: opportunity.row,
      score,
      reasons,
      locationUnstated: filter.locationUnstated,
    });
  }
  results.sort(
    (a, b) =>
      b.score - a.score ||
      (a.row.deadlineAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.row.deadlineAt)) -
        (b.row.deadlineAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.row.deadlineAt)) ||
      a.row.opportunityId.localeCompare(b.row.opportunityId),
  );

  // Consulted, not "found something": with the absolute floor, a role far
  // from every title in the index rightly finds nothing.
  const vectors = inputs.vectors;
  const usedVectors = vectors !== null && roles.some((role) => vectors.roleRow.has(role.id));
  const parts = [
    LEXICAL_RANK_VERSION,
    ...(usedVectors ? [vectors.model] : []),
    ...(staticIndex !== null ? [STATIC_E1_PIN.id] : []),
  ];
  return {
    version: usedVectors
      ? `hybrid-v2+${parts.join('+')}`
      : staticIndex !== null
        ? HYBRID_RANK_VERSION
        : LEXICAL_RANK_VERSION,
    similarity: staticIndex !== null ? 'roles-and-cv' : usedVectors ? 'roles' : 'none',
    results,
    stats: { ...lexical.stats, matched: results.length },
  };
}
