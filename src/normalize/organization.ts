/**
 * Organization-name normalization: turns a raw employer string as a source
 * wrote it into a stable MATCHING KEY.
 *
 * The output is never displayed and never overwrites anything. A listing's
 * `organizationRaw` stays exactly as the source wrote it (§14.2: "preserve
 * every source description"), the organization's `canonicalName` stays the
 * human-readable form, and this key exists only so candidate generation
 * (§14.1 stage 3) can look up "have we seen this employer before?" with an
 * index instead of an all-pairs comparison.
 *
 * That framing decides how aggressive the rules should be. A key collision
 * between two genuinely different employers is NOT a correctness bug here —
 * §14.2 forbids auto-linking on a name match alone, so a collision only ever
 * produces a candidate pair for scoring, which further evidence then
 * separates. Being slightly too aggressive costs a little review work; being
 * too timid silently loses real duplicates, which is the failure this whole
 * phase exists to prevent. The rules below therefore fold away formatting
 * noise, but never attempt semantic judgement (no stemming, no transliteration
 * between Georgian and Latin, no "Group" ~ "ჯგუფი" equivalence).
 */

/**
 * Bump when a rule below changes. Stored alongside every normalized value
 * (organizations.normalizerVersion) so a rule change is a visible, re-runnable
 * data migration rather than an invisible re-clustering of history — §14.2's
 * "record ruleset/model versions so decisions can be recomputed".
 */
export const ORGANIZATION_NORMALIZER_VERSION = 'v1';

/**
 * Legal-form tokens stripped when they appear as a whole word.
 *
 * Whole-word only, and this matters concretely: `სს` ("JSC") is a two-letter
 * token that occurs inside ordinary Georgian words, so a substring replace
 * would corrupt real names. Georgian forms confirmed present in the live
 * corpus (`შპს იუ ეიჩ უაი საქართველო`); the Latin ones are included because
 * both boards carry English-language employer names and the cost of listing
 * them is nil.
 */
const LEGAL_FORM_TOKENS = new Set([
  // Georgian
  'შპს', // LLC
  'სს', // JSC
  'ააიპ', // non-commercial legal entity
  'სსიპ', // legal entity of public law
  'ი/მ', // individual entrepreneur
  'ინდმეწარმე',
  // Latin
  'llc',
  'ltd',
  'ltda',
  'limited',
  'jsc',
  'inc',
  'co',
  'corp',
  'corporation',
  'gmbh',
  'llp',
  'plc',
]);

/**
 * Quote-like characters removed outright. Georgian text commonly wraps trade
 * names in „…" or «…», and the same employer appears quoted on one board and
 * bare on the other.
 */
const QUOTE_CHARACTERS = /["'`„“”«»‘’]/g;

/**
 * Characters folded to a space before tokenizing. Deliberately includes `.`
 * so domain-style names normalize toward their spoken form — the live corpus
 * carries `Shop.ge`, `HOME.GE`, `elplus.ge` and `კოტეჯები.ჯი`, and folding
 * the dot lets `Shop.ge` and `Shop GE` meet. It also turns `მ. იაშვილის` into
 * two clean tokens rather than one with a trailing dot.
 */
const PUNCTUATION_TO_SPACE = /[.,;:!?()[\]{}\\/|_+*&@#~^<>-]+/g;

/**
 * The normalized matching key, or null when the input carries no usable
 * signal at all (empty, whitespace, or nothing but punctuation and legal
 * forms). Null is deliberate rather than an empty string: an organization
 * whose name normalizes away entirely must NOT silently join a bucket keyed
 * on '' with every other such listing — that is precisely the accidental
 * mass-merge §14.2 warns against. Callers treat null as "no organization
 * signal available", the same as a missing name.
 */
export function normalizeOrganizationName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  const folded = raw
    // NFKC, not NFC: also folds compatibility forms (full-width Latin,
    // ligatures) that would otherwise produce two keys for one name.
    .normalize('NFKC')
    .replace(QUOTE_CHARACTERS, '')
    .replace(PUNCTUATION_TO_SPACE, ' ')
    // Lowercasing is what makes hr.ge's shouted names (AUTOPAPA, KEYPOINT)
    // meet jobs.ge's ordinary casing. Georgian Mkhedruli is caseless so this
    // is a no-op there, but it does map Mtavruli (the uppercase form added in
    // Unicode 11) down to Mkhedruli, which is exactly what we want.
    .toLowerCase();

  const tokens = folded
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .filter((token) => !LEGAL_FORM_TOKENS.has(token));

  if (tokens.length === 0) return null;
  return tokens.join(' ');
}

/**
 * True when two raw names share a normalized key. A thin wrapper, but it
 * keeps callers from re-implementing the null handling: two names that BOTH
 * normalize to null are not a match, even though `null === null`.
 */
export function organizationNamesMatch(
  rawA: string | null | undefined,
  rawB: string | null | undefined,
): boolean {
  const a = normalizeOrganizationName(rawA);
  const b = normalizeOrganizationName(rawB);
  return a !== null && b !== null && a === b;
}
