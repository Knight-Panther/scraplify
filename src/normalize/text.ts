/**
 * Shared text normalization and similarity used by dedupe signals.
 *
 * Like the organization normalizer, everything here produces MATCHING keys
 * and comparison scores — never display values, and never anything that
 * overwrites what a source actually wrote (§14.2).
 */

/** Bump when any rule here changes; recorded on every decision that used it. */
export const TEXT_NORMALIZER_VERSION = 'v1';

const QUOTE_CHARACTERS = /["'`„“”«»‘’]/g;
const PUNCTUATION_TO_SPACE = /[.,;:!?()[\]{}\\/|_+*&@#~^<>-]+/g;

/**
 * Normalizes a job title for comparison: NFKC, quotes removed, punctuation
 * folded to spaces, lowercased, whitespace collapsed.
 *
 * Punctuation folding is what makes the corpus's real pair
 * `გადამზიდი/დისტრიბუტორი` and `გადამზიდი / დისტრიბუტორი` — the same job
 * written with and without spaces around the slash on the two boards —
 * compare equal instead of merely similar.
 */
export function normalizeTitle(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const tokens = raw
    .normalize('NFKC')
    .replace(QUOTE_CHARACTERS, '')
    .replace(PUNCTUATION_TO_SPACE, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return tokens.length === 0 ? null : tokens.join(' ');
}

/**
 * Character trigrams of a normalized string, padded so short strings still
 * produce usable grams. Mirrors what PostgreSQL's `pg_trgm` does, kept in
 * application code so scoring stays testable and database-independent —
 * `pg_trgm` remains the right tool for *candidate generation* at scale
 * (§14.1 stage 3), where an index must avoid all-pairs comparison, but the
 * final weighted score should not depend on which database is underneath.
 */
export function trigrams(value: string): Set<string> {
  const padded = `  ${value} `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

/**
 * Jaccard similarity over character trigrams, in [0, 1].
 *
 * Chosen over an edit distance because it is robust to word reordering,
 * which Georgian job titles genuinely vary in, and because it degrades
 * gracefully on the long compound titles this corpus is full of
 * (`ბიუჯეტირებისა და რეპორტინგის უფროსი ანალიტიკოსი`). Two identical
 * strings score 1; two sharing no trigrams score 0.
 *
 * Note the deliberately hard case this must NOT rate highly: the corpus
 * contains `...უფროსი ანალიტიკოსი` (senior analyst) and
 * `...უმცროსი ანალიტიკოსი` (junior analyst) from the same employer. They are
 * different vacancies that differ by two characters in a long string, so
 * trigram similarity alone rates them very close — which is exactly why
 * §14.2 forbids auto-linking on title-and-employer agreement and why the
 * scorer requires an independent per-vacancy signal.
 */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const gramsA = trigrams(a);
  const gramsB = trigrams(b);
  if (gramsA.size === 0 || gramsB.size === 0) return 0;
  let shared = 0;
  for (const gram of gramsA) if (gramsB.has(gram)) shared++;
  const union = gramsA.size + gramsB.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Normalizes an application contact value into a comparable key, or null if
 * it carries no usable identity.
 *
 * Email: lowercased and trimmed. Deliberately NOT stripped of sub-addressing
 * (`+tag`) or dots — those are provider-specific conventions, and rewriting
 * an employer's stated contact address on a guess is exactly the kind of
 * semantic judgement that turns a matching key into a source of false merges.
 *
 * URL: host lowercased, default ports and a trailing slash dropped, and
 * tracking parameters removed — but every other query parameter preserved,
 * because for ATS links the identifier frequently LIVES in the query string
 * and stripping it would collapse every vacancy at that ATS into one key.
 */
const TRACKING_PARAMETERS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'referrer',
  'source',
]);

export function normalizeApplicationValue(
  type: string | null | undefined,
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (type === 'email') {
    return trimmed.toLowerCase();
  }

  if (type === 'url') {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      // Not parseable as a URL — fall back to the raw lowercased string
      // rather than discarding a value the source did provide.
      return trimmed.toLowerCase();
    }
    for (const parameter of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.has(parameter.toLowerCase())) {
        parsed.searchParams.delete(parameter);
      }
    }
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    const path =
      parsed.pathname.endsWith('/') && parsed.pathname !== '/'
        ? parsed.pathname.slice(0, -1)
        : parsed.pathname;
    const query = parsed.searchParams.toString();
    return `${parsed.protocol}//${parsed.host}${path}${query ? `?${query}` : ''}`.toLowerCase();
  }

  // 'form', 'unspecified', and anything else carry no cross-source identity:
  // "apply through the site's own form" is true of thousands of listings and
  // says nothing about which vacancy this is.
  return null;
}
