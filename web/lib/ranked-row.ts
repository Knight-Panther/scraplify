import type { ListingView } from '../../src/browse/queries.js';
import type { RankedOpportunityView } from '../../src/ranking/run-ranking.js';

/**
 * The ranked screen's derivations.
 *
 * The whole point of this screen is the *why*, not the number. §17.2 stores
 * the explanation alongside the score rather than recomputing it on read —
 * because recomputing would use today's ruleset against a ranking produced by
 * an older one and silently show a rationale that never applied — so
 * everything here reads what was stored and never re-derives a score.
 *
 * `componentScores` and `hardFilterReasons` are jsonb, which means `unknown`
 * at the type level and arbitrary at runtime. Every read below checks before
 * it trusts: a malformed row degrades to "no breakdown recorded" rather than
 * throwing, because one bad row must not take out the list.
 */

/** One weighted component of a score, exactly as the scorer recorded it. */
export interface Component {
  /** The stored key: `skills`, `role`, `language`, `professionPreference`. */
  key: string;
  /** 0-1, before weighting. */
  score: number;
  /** This component's share of the total. The four sum to 1. */
  weight: number;
  /** What the profile and the listing agreed on, in the scorer's own words. */
  matched: string[];
  /** What the listing asked for and the profile did not supply. */
  missing: string[];
  /**
   * `score * weight` — what this component actually contributed.
   *
   * Computed rather than stored, and it is the number that explains a rank:
   * a component scoring 1.00 at weight 0.05 moves a result far less than one
   * scoring 0.33 at weight 0.45, and showing the raw score alone invites
   * exactly that misreading.
   */
  contribution: number;
}

export interface HardFilter {
  /** The stored key, e.g. `excluded_profession`. */
  filter: string;
  /** The scorer's own sentence, e.g. `listing mentions excluded profession "მძღოლი"`. */
  detail: string;
}

export interface RankedRow {
  opportunityId: string;
  title: string;
  status: string;
  /** Null for a hard-filtered opportunity: there is no score to give. */
  score: number | null;
  eligible: boolean;
  /** Highest contribution first — the reason this rank is where it is. */
  components: Component[];
  /** Why it was excluded, when it was. Empty for an eligible opportunity. */
  hardFilters: HardFilter[];
  /** Distinct employer names across live members, in member order. */
  employers: string[];
  /** One entry per board, so a cross-posted result links out to both. */
  sources: { sourceSlug: string; url: string; status: string }[];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStrings(value: unknown): string[] {
  return asArray(value).filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Components, strongest contribution first.
 *
 * Ordered by what each actually moved the result, not by the scorer's own
 * array order or by raw score — the reader's question is "why is this here",
 * and the answer is whichever component contributed most.
 */
function components(value: unknown): Component[] {
  const parsed: Component[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    const key = typeof record.component === 'string' ? record.component : '';
    const score = asNumber(record.score);
    const weight = asNumber(record.weight);
    // A component missing its key, score or weight cannot be explained
    // honestly, so it is dropped rather than rendered with a guessed value.
    if (key === '' || score === null || weight === null) continue;
    parsed.push({
      key,
      score,
      weight,
      matched: asStrings(record.matched),
      missing: asStrings(record.missing),
      contribution: score * weight,
    });
  }
  // Ties are not hypothetical: skills at 0.33 × 0.45 and preferred field at
  // 1.00 × 0.15 both contribute exactly 0.15, and that pair occurs throughout
  // the corpus. Left to `sort` alone the order would fall back to whatever
  // order the scorer happened to write its array in — an implementation
  // detail of the scorer presented as a ranking of importance. Broken by
  // WEIGHT instead, because between two factors that contributed the same, the
  // more heavily weighted one is the bigger lever and the more useful thing to
  // read first; then by key, so the order is total and cannot shift between
  // renders.
  return parsed.sort(
    (a, b) => b.contribution - a.contribution || b.weight - a.weight || a.key.localeCompare(b.key),
  );
}

function hardFilters(value: unknown): HardFilter[] {
  const parsed: HardFilter[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    const filter = typeof record.filter === 'string' ? record.filter : '';
    const detail = typeof record.detail === 'string' ? record.detail : '';
    if (filter === '' && detail === '') continue;
    parsed.push({ filter, detail });
  }
  return parsed;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function toRankedRow(
  ranked: RankedOpportunityView,
  members: readonly ListingView[] = [],
): RankedRow {
  const sources: RankedRow['sources'] = [];
  for (const member of members) {
    // One entry per BOARD: a board that listed the same vacancy twice would
    // otherwise render as two identical links.
    if (sources.some((source) => source.sourceSlug === member.sourceSlug)) continue;
    sources.push({
      sourceSlug: member.sourceSlug,
      url: member.canonicalUrl,
      status: member.status,
    });
  }

  return {
    opportunityId: ranked.opportunityId,
    title: ranked.canonicalTitle,
    status: ranked.canonicalStatus,
    score: ranked.score,
    eligible: ranked.eligible,
    components: components(ranked.componentScores),
    hardFilters: hardFilters(ranked.hardFilterReasons),
    employers: distinct(
      members.flatMap((member) =>
        member.organization === null || member.organization.trim() === ''
          ? []
          : [member.organization.trim()],
      ),
    ),
    sources,
  };
}

/**
 * English names for the scorer's component keys.
 *
 * The keys are internal identifiers — `professionPreference` is not a label a
 * person should read — and this is the only place they become words, the same
 * arrangement `labels.ts` uses for the database enums. An unrecognised key
 * degrades to a marked fallback rather than printing the raw key.
 */
const COMPONENT_LABELS: Record<string, { short: string; explanation: string }> = {
  skills: {
    short: 'skills',
    explanation: 'Skills the listing asks for, against the skills the profile claims.',
  },
  role: {
    short: 'role',
    explanation: 'How closely the job title matches the roles the profile is aimed at.',
  },
  language: {
    short: 'languages',
    explanation: 'Languages the listing requires, against the languages the profile claims.',
  },
  professionPreference: {
    short: 'preferred field',
    explanation: 'Whether the listing falls in a field the profile said it wanted.',
  },
};

export function componentLabel(key: string): { short: string; explanation: string } {
  return (
    COMPONENT_LABELS[key] ?? {
      short: 'unrecognised factor',
      explanation: `This build has no label for the scoring factor "${key}".`,
    }
  );
}
