/**
 * Tokenizing and light stemming for browser CV matching (Phase 8D,
 * `lexical-rank-v1`). Browser-safe: no Node import, so the CV worker runs
 * exactly this code.
 *
 * Matching keys only. Nothing here produces display text, and the offsets on
 * each token exist so evidence snippets can quote the CV's own wording
 * rather than a normalized form of it.
 */

/** Bump when any rule here changes; it is part of `LEXICAL_RANK_VERSION`. */
export const LEXICAL_TEXT_VERSION = 'v2';

export interface Token {
  /** The stemmed matching key. */
  stem: string;
  /** Offsets into the ORIGINAL text, for evidence snippets. */
  start: number;
  end: number;
}

/**
 * Letters and digits, plus `+` and `#` so "C++" and "C#" survive as skills
 * rather than collapsing to "c". Everything else separates tokens, except
 * the invisible characters below.
 *
 * Soft hyphens, zero-width spaces/joiners, word joiners and BOMs sit INSIDE
 * words in real documents (Word's optional hyphen arrives from mammoth as
 * U+00AD; PDFs carry zero-width spaces), and splitting on them turned
 * "ბუღალ\u00ADტერი" into two tokens that match nothing. They stay inside the
 * match, so offsets still point at the original text, and are dropped from
 * the key.
 */
const TOKEN = /[\p{L}\p{N}+#\u00AD\u200B-\u200D\u2060\uFEFF]+/gu;
export const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/gu;
const GEORGIAN = /[Ⴀ-ჿᲐ-Ჿ]/u;

/**
 * Georgian case and postposition endings, longest first so `-ებისთვის` is
 * removed whole rather than as `-ის`. Georgian is agglutinative: "manager"
 * appears in a CV as მენეჯერი, მენეჯერის, მენეჯერად, მენეჯერთან... and a
 * whole-word test on the raw form would miss nearly all of them.
 *
 * Deliberately conservative: it strips endings and never reconstructs a
 * stem, so syncopated forms (ბუღალტერი → ბუღალტრის) still differ. A stem
 * must keep at least three letters, which keeps short words from being
 * stripped down to noise that matches everything.
 */
const GEORGIAN_SUFFIXES = [
  'ებისთვის',
  'ებისგან',
  'ისთვის',
  'ისგან',
  'ისკენ',
  'ებთან',
  'ებიდან',
  'ებამდე',
  'ებში',
  'ებზე',
  'ებმა',
  'ებით',
  'ებად',
  'ების',
  'ებს',
  'ები',
  'თვის',
  'იდან',
  'ამდე',
  'თან',
  'დან',
  'გან',
  'ში',
  'ზე',
  'მა',
  'ის',
  'ით',
  'ად',
  'ს',
  'ი',
  'ო',
  'მ',
  'თ',
  'დ',
] as const;

const MIN_GEORGIAN_STEM = 3;

export function stem(token: string): string {
  if (GEORGIAN.test(token)) {
    for (const suffix of GEORGIAN_SUFFIXES) {
      if (token.endsWith(suffix) && token.length - suffix.length >= MIN_GEORGIAN_STEM) {
        return token.slice(0, -suffix.length);
      }
    }
    return token;
  }
  // Latin: only a plural `s`, so "developers" meets "developer" and
  // "sales" meets "sale". Nothing cleverer — an English stemmer that turned
  // "management" into "manag" would start matching "manager" titles to
  // unrelated text.
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

export function tokenize(text: string): Token[] {
  const normalized = text.normalize('NFKC');
  // NFKC can change lengths (ligatures, full-width forms); offsets are only
  // trusted when it did not, and otherwise point into the normalized text,
  // which is what the snippet helper then quotes.
  const tokens: Token[] = [];
  for (const match of normalized.matchAll(TOKEN)) {
    const raw = match[0].replace(INVISIBLE, '').toLowerCase();
    // A token that is only `+`/`#` carries no meaning on its own.
    if (!/[\p{L}\p{N}]/u.test(raw)) continue;
    tokens.push({ stem: stem(raw), start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/** Stems for a short phrase (a title, label, alias or user-typed term). */
export function phraseStems(text: string): string[] {
  return tokenize(text).map((token) => token.stem);
}

/**
 * Index of the first place `needle` occurs as a contiguous run of stems in
 * `haystack`, or -1. Whole tokens only: a bare substring test would let "go"
 * or "r" match inside ordinary words (the same reason
 * `src/ranking/score-opportunity.ts` matches whole words).
 */
export function findPhrase(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const SNIPPET_RADIUS = 48;

/**
 * A short quote of the CV around a match, shown as the local evidence for a
 * suggested profile term. Cut at whitespace where possible, with whitespace
 * collapsed so a PDF's line breaks do not fragment it. Built from the user's
 * own document and shown only to them, in their own tab.
 */
export function snippet(text: string, start: number, end: number): string {
  const normalized = text.normalize('NFKC');
  let from = Math.max(0, start - SNIPPET_RADIUS);
  let to = Math.min(normalized.length, end + SNIPPET_RADIUS);
  // Drop the partial word at each edge of the window, never the match itself.
  if (from > 0) {
    const firstBreak = normalized.slice(from, start).search(/\s/);
    if (firstBreak !== -1) from += firstBreak + 1;
  }
  if (to < normalized.length) {
    const tail = normalized.slice(end, to);
    const lastBreak = Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('\n'));
    if (lastBreak !== -1) to = end + lastBreak;
  }
  const body = normalized.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${body}${to < normalized.length ? '…' : ''}`;
}
