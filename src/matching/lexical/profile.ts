import type { BundleOpportunity } from '../bundle/schema.js';
import { LEXICON, type LexiconEntry } from './lexicon.js';
import { findPhrase, phraseStems, snippet, tokenize } from './text.js';

/**
 * The browser-only match profile (Phase 8D, change.md §7 "Local profile
 * extraction"): terms derived from the CV text in this tab plus whatever the
 * user adds, removes or confirms. It lives in worker/React memory only and
 * never leaves the tab.
 *
 * Every CV-derived term carries the snippet of the CV it was found in. A
 * term with no supporting text never appears unless the user added it
 * (change.md §7: "Show a claim only with supporting local text or explicit
 * user confirmation").
 */

export type TermKind = 'role' | 'field' | 'skill' | 'location';

export interface ProfileTerm {
  /** `kind:key`, unique within a profile. */
  id: string;
  kind: TermKind;
  label: string;
  /** Stemmed phrases, any of which counts as this term (see `text.ts`). */
  forms: string[][];
  /** Taxonomy codes, for `field` terms: matched exactly against a row's taxonomy. */
  codes: string[];
  origin: 'cv' | 'user';
  /** The CV text this term was found in; null for user-added terms. */
  evidence: string | null;
  /**
   * Whether ranking uses it. CV-derived roles, fields and skills start
   * active because they only ever raise a score. A CV-derived LOCATION
   * starts inactive: locations are hard filters, and an address line is
   * weak evidence of where someone wants to work (change.md §7: "never
   * infer disqualification from weak text evidence").
   */
  active: boolean;
}

export interface MatchProfile {
  terms: ProfileTerm[];
}

/** A choosable value derived from the bundle, for the field/location pickers. */
export interface VocabularyOption {
  key: string;
  label: string;
  /** How many opportunities in the bundle carry it — the pickers sort by this. */
  count: number;
  forms: string[][];
  codes: string[];
}

export interface Vocabulary {
  /** Frequent listing titles, a Georgian role vocabulary taken from the corpus itself. */
  roles: VocabularyOption[];
  /** Taxonomy labels (profession and industry), matched by code. */
  fields: VocabularyOption[];
  locations: VocabularyOption[];
}

/** A title must recur this often, and be this short, to count as a role name. */
const ROLE_TITLE_MIN_COUNT = 3;
const ROLE_TITLE_MAX_TOKENS = 3;
/** Label parts too generic to detect in a CV ("სხვა" is hr.ge's "Other"). */
const IGNORED_LABEL_PARTS = new Set(['სხვა']);
const MIN_DETECTABLE_CHARS = 4;

export const DETECTION_CAPS: Readonly<Record<TermKind, number>> = {
  role: 8,
  field: 8,
  skill: 15,
  location: 3,
};

function formKey(form: readonly string[]): string {
  return form.join(' ');
}

export function buildVocabulary(rows: readonly BundleOpportunity[]): Vocabulary {
  const titles = new Map<string, VocabularyOption>();
  const fields = new Map<string, VocabularyOption>();
  const locations = new Map<string, VocabularyOption>();

  for (const row of rows) {
    const titleForm = phraseStems(row.title);
    if (titleForm.length > 0 && titleForm.length <= ROLE_TITLE_MAX_TOKENS) {
      const key = formKey(titleForm);
      const existing = titles.get(key);
      if (existing) existing.count++;
      else titles.set(key, { key, label: row.title, count: 1, forms: [titleForm], codes: [] });
    }

    for (const term of row.taxonomy) {
      const existing = fields.get(term.label);
      if (existing) {
        existing.count++;
        if (!existing.codes.includes(term.code)) existing.codes.push(term.code);
        continue;
      }
      // "უსაფრთხოება / დაცვა" is two ideas; either one in a CV points at it.
      const forms = term.label
        .split('/')
        .map((part) => part.trim())
        .filter((part) => part.length >= MIN_DETECTABLE_CHARS && !IGNORED_LABEL_PARTS.has(part))
        .map(phraseStems)
        .filter((form) => form.length > 0);
      fields.set(term.label, {
        key: term.label,
        label: term.label.trim(),
        count: 1,
        forms,
        codes: [term.code],
      });
    }

    for (const location of row.locations) {
      const existing = locations.get(location);
      if (existing) existing.count++;
      else {
        locations.set(location, {
          key: location,
          label: location,
          count: 1,
          forms: [phraseStems(location)].filter((form) => form.length > 0),
          codes: [],
        });
      }
    }
  }

  const byCount = (a: VocabularyOption, b: VocabularyOption) =>
    b.count - a.count || a.label.localeCompare(b.label);
  return {
    roles: [...titles.values()].filter((t) => t.count >= ROLE_TITLE_MIN_COUNT).sort(byCount),
    fields: [...fields.values()].sort(byCount),
    locations: [...locations.values()].sort(byCount),
  };
}

function lexiconForms(entry: LexiconEntry): string[][] {
  const seen = new Set<string>();
  const forms: string[][] = [];
  for (const form of entry.forms) {
    const stems = phraseStems(form);
    const key = formKey(stems);
    if (stems.length === 0 || seen.has(key)) continue;
    seen.add(key);
    forms.push(stems);
  }
  return forms;
}

function lexiconLabel(entry: LexiconEntry): string {
  return entry.en === entry.ka ? entry.en : `${entry.en} · ${entry.ka}`;
}

interface Candidate {
  term: ProfileTerm;
  /** Where it first occurred and how often — the ordering signal. */
  firstIndex: number;
  occurrences: number;
  /** The stems it actually matched on, for generic-role suppression. */
  matched: string[];
  generic: boolean;
}

/** Every stem phrase any candidate so far has claimed, to avoid duplicates across sources. */
function claims(
  candidates: readonly Candidate[],
  kind: TermKind,
  form: readonly string[],
): boolean {
  const key = formKey(form);
  return candidates.some(
    (candidate) =>
      candidate.term.kind === kind && candidate.term.forms.some((f) => formKey(f) === key),
  );
}

/** Where each stem occurs in the CV, so a form is only checked where its first stem is. */
type StemIndex = ReadonlyMap<string, readonly number[]>;

function indexStems(stems: readonly string[]): StemIndex {
  const index = new Map<string, number[]>();
  stems.forEach((stem, position) => {
    const positions = index.get(stem);
    if (positions) positions.push(position);
    else index.set(stem, [position]);
  });
  return index;
}

function detect(
  stems: readonly string[],
  index: StemIndex,
  forms: readonly string[][],
): { index: number; length: number; occurrences: number } | null {
  let first: { index: number; length: number } | null = null;
  let occurrences = 0;
  for (const form of forms) {
    const head = form[0];
    // "hr" and "qa" are fine as whole tokens; a single character is too
    // likely to be an initial or a stray PDF glyph.
    if (head === undefined || (form.length === 1 && head.length < 2)) continue;
    for (const position of index.get(head) ?? []) {
      if (!form.every((stem, offset) => stems[position + offset] === stem)) continue;
      occurrences++;
      if (first === null || position < first.index)
        first = { index: position, length: form.length };
    }
  }
  return first === null ? null : { ...first, occurrences };
}

/**
 * Derives suggested profile terms from CV text. Pure and deterministic:
 * the same text and vocabulary always produce the same profile.
 */
export function deriveProfile(text: string, vocabulary: Vocabulary): MatchProfile {
  const tokens = tokenize(text);
  const stems = tokens.map((token) => token.stem);
  const stemIndex = indexStems(stems);
  const candidates: Candidate[] = [];

  const add = (
    kind: TermKind,
    key: string,
    label: string,
    forms: string[][],
    codes: string[],
    generic = false,
  ) => {
    if (forms.length === 0) return;
    if (forms.some((form) => claims(candidates, kind, form))) return;
    const hit = detect(stems, stemIndex, forms);
    if (hit === null) return;
    const firstToken = tokens[hit.index];
    const lastToken = tokens[hit.index + hit.length - 1];
    if (firstToken === undefined || lastToken === undefined) return;
    candidates.push({
      term: {
        id: `${kind}:${key}`,
        kind,
        label,
        forms,
        codes,
        origin: 'cv',
        evidence: snippet(text, firstToken.start, lastToken.end),
        active: kind !== 'location',
      },
      firstIndex: hit.index,
      occurrences: hit.occurrences,
      matched: stems.slice(hit.index, hit.index + hit.length),
      generic,
    });
  };

  // Curated bilingual entries first, so an English CV's "accountant" and a
  // corpus title ბუღალტერი collapse into one bilingual term, not two.
  for (const entry of LEXICON) {
    add(entry.kind, entry.key, lexiconLabel(entry), lexiconForms(entry), [], entry.generic);
  }
  for (const role of vocabulary.roles) {
    add('role', `title:${role.key}`, role.label, role.forms, []);
  }
  for (const field of vocabulary.fields) {
    add('field', field.key, field.label, field.forms, field.codes);
  }
  for (const location of vocabulary.locations) {
    add('location', location.key, location.label, location.forms, []);
  }

  // "manager" is noise once "sales manager" was found in the same place.
  const specific = candidates.filter(
    (candidate) => candidate.term.kind === 'role' && !candidate.generic,
  );
  const kept = candidates.filter(
    (candidate) =>
      !candidate.generic ||
      !specific.some((other) => findPhrase(other.matched, candidate.matched) !== -1),
  );

  const terms: ProfileTerm[] = [];
  for (const kind of ['role', 'field', 'skill', 'location'] as const) {
    terms.push(
      ...kept
        .filter((candidate) => candidate.term.kind === kind)
        .sort((a, b) => b.occurrences - a.occurrences || a.firstIndex - b.firstIndex)
        .slice(0, DETECTION_CAPS[kind])
        .map((candidate) => candidate.term),
    );
  }
  return { terms };
}

/**
 * A term the user typed. If it names a curated entry in either language,
 * the entry's bilingual forms come with it, so typing "Accountant" also
 * matches Georgian titles.
 */
export function userTerm(kind: 'role' | 'skill', text: string): ProfileTerm | null {
  const label = text.trim().replace(/\s+/g, ' ');
  const stems = phraseStems(label);
  if (stems.length === 0) return null;
  const key = formKey(stems);
  const entry = LEXICON.find(
    (candidate) =>
      candidate.kind === kind && lexiconForms(candidate).some((form) => formKey(form) === key),
  );
  return {
    id: `${kind}:${entry?.key ?? `user:${key}`}`,
    kind,
    label: entry ? lexiconLabel(entry) : label,
    forms: entry ? lexiconForms(entry) : [stems],
    codes: [],
    origin: 'user',
    evidence: null,
    active: true,
  };
}

/** A field or location the user picked from the bundle's own vocabulary. */
export function vocabularyTerm(kind: 'field' | 'location', option: VocabularyOption): ProfileTerm {
  const alias =
    kind === 'location'
      ? LEXICON.find(
          (entry) =>
            entry.kind === 'location' &&
            lexiconForms(entry).some((form) =>
              option.forms.some((f) => formKey(f) === formKey(form)),
            ),
        )
      : undefined;
  return {
    id: `${kind}:${option.key}`,
    kind,
    label: option.label,
    forms: alias ? lexiconForms(alias) : option.forms,
    codes: option.codes,
    origin: 'user',
    evidence: null,
    active: true,
  };
}
