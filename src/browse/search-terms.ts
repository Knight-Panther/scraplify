import { INVISIBLE, stem, tokenize } from '../matching/lexical/text.js';
import titleDictionaryJson from '../matching/semantic/title-dictionary.json' with { type: 'json' };
import type { TitleDictionary } from '../matching/semantic/title-english.js';

/**
 * What a Browse or Listings search box means, as one Postgres regular
 * expression per word (Phase 10A). Every word must match somewhere in the
 * searched fields, in any order; within a word, any of its variants will do:
 *
 * - the word itself, with the Georgian case ending stripped (the same `stem`
 *   CV matching uses), so "მენეჯერის" finds "მენეჯერი";
 * - its translations in the reviewed title dictionary, both ways, so
 *   "accountant" finds "ბუღალტერი" and "მზარეული" finds "Cook";
 * - for a Latin word, the Georgian it spells when Georgian is typed in Latin
 *   letters, so "mdzgoli" finds "მძღოლი".
 *
 * No model and no lookup outside this file: the dictionary is the same
 * reviewed one the CV matching bundle uses (`title-english.ts`).
 *
 * The patterns are for `~*` (case-insensitive) and are always passed as
 * bound parameters, never spliced into SQL.
 */

export interface SearchTerm {
  /** The word as typed, lowercased: for tests and diagnostics, never matched. */
  word: string;
  /** A Postgres ARE pattern; it also compiles as a JavaScript `u` regex. */
  pattern: string;
}

/** Words past this are ignored, which bounds the query a search box can build. */
export const MAX_SEARCH_WORDS = 8;
/** Variants past this for one word are ignored, for the same reason. */
const MAX_VARIANTS = 16;
/** A Latin word shorter than this is not read as Georgian typed in Latin letters. */
const MIN_TRANSLIT_LETTERS = 4;
/** A transliteration whose stem keeps fewer Georgian letters than this is dropped as noise. */
const MIN_TRANSLIT_STEM = 3;

/**
 * Not a letter or digit of the scripts the corpus uses: what "the start of a
 * word" means for a short variant. Explicit code-point ranges rather than
 * `[[:alnum:]]` or `\m`, whose meaning depends on the database locale
 * (the host runs C.UTF-8, local Postgres en_US.utf8).
 */
const NOT_WORD = '[^0-9a-zа-яёა-ჿᲐ-Ჿ]';

const dictionary = titleDictionaryJson as TitleDictionary;

/** English word (stemmed, lowercased) → the dictionary's Georgian stems for it. */
const georgianFor = new Map<string, Set<string>>();
for (const [georgianStem, entry] of Object.entries(dictionary.entries)) {
  for (const english of entry.en) {
    // Single words only: a phrase ("delivery driver") would need the query's
    // words matched as a phrase, and its head word alone over-reaches.
    if (/\s/.test(english)) continue;
    const key = stem(english.toLowerCase());
    let stems = georgianFor.get(key);
    if (stems === undefined) {
      stems = new Set();
      georgianFor.set(key, stems);
    }
    stems.add(georgianStem);
  }
}

/**
 * Georgian typed in Latin letters, letter by letter: each Latin letter or
 * digraph becomes the Georgian letters it can stand for. Longest first, so
 * "dz" is ძ rather than დ then ზ. The first letter of each set is the usual
 * reading; it builds the one spelling whose stem decides how much of the
 * word to keep (see `transliteration`).
 */
const LATIN_TO_GEORGIAN: readonly (readonly [string, string])[] = [
  ['dz', 'ძ'],
  ['ts', 'ცწ'],
  ['ch', 'ჩჭ'],
  ['sh', 'შ'],
  ['zh', 'ჟ'],
  ['kh', 'ხ'],
  ['gh', 'ღ'],
  ['a', 'ა'],
  ['b', 'ბ'],
  ['g', 'გღ'],
  ['d', 'დ'],
  ['e', 'ე'],
  ['v', 'ვ'],
  ['z', 'ზ'],
  ['t', 'თტ'],
  ['i', 'ი'],
  ['k', 'კქ'],
  ['l', 'ლ'],
  ['m', 'მ'],
  ['n', 'ნ'],
  ['o', 'ო'],
  ['p', 'პფ'],
  ['j', 'ჯ'],
  ['r', 'რ'],
  ['s', 'ს'],
  ['u', 'უ'],
  ['f', 'ფ'],
  ['q', 'ქყ'],
  ['y', 'ყ'],
  ['x', 'ხ'],
  ['c', 'ცჩწჭ'],
  ['w', 'წ'],
  ['h', 'ჰ'],
];

interface Variant {
  /** Regex source, already escaped. */
  body: string;
  /** Length in letters, which decides how loosely it may match. */
  length: number;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literal(text: string): Variant {
  return { body: escapeRegex(text), length: [...text].length };
}

/**
 * A Latin word read as Georgian typed in Latin letters, as a regex of
 * letter sets, cut to the Georgian stem: "mdzgolis" becomes მძ[გღ]ოლ, which
 * also finds "მძღოლი". Null when the word has a letter outside the map or
 * too little is left once the ending goes.
 */
function transliteration(word: string): Variant | null {
  if (!/^[a-z]+$/.test(word) || word.length < MIN_TRANSLIT_LETTERS) return null;
  const letters: string[] = [];
  let at = 0;
  while (at < word.length) {
    const match = LATIN_TO_GEORGIAN.find(([latin]) => word.startsWith(latin, at));
    if (match === undefined) return null;
    letters.push(match[1]);
    at += match[0].length;
  }
  const usual = letters.map((set) => [...set][0]).join('');
  const kept = [...stem(usual)].length;
  if (kept < MIN_TRANSLIT_STEM) return null;
  const body = letters
    .slice(0, kept)
    .map((set) => ([...set].length === 1 ? set : `[${set}]`))
    .join('');
  return { body, length: kept };
}

/**
 * How loosely a variant matches, by length: two letters or fewer must be a
 * whole word ("IT" is not inside "digital"), three must start a word ("GIZ"
 * at the start of "GIZ - …"), and four or more may sit anywhere in a word,
 * which Georgian compounds need ("მექანიკოს" inside "ავტომექანიკოსი").
 */
function alternative(variant: Variant): string {
  if (variant.length >= 4) return variant.body;
  if (variant.length === 3) return `(?:^|${NOT_WORD})${variant.body}`;
  return `(?:^|${NOT_WORD})${variant.body}(?:$|${NOT_WORD})`;
}

const GEORGIAN = /\p{Script=Georgian}/u;

function variantsFor(surface: string, wordStem: string): Variant[] {
  const variants: Variant[] = [literal(wordStem)];
  if (GEORGIAN.test(wordStem)) {
    for (const english of dictionary.entries[wordStem]?.en ?? []) {
      variants.push(literal(english.toLowerCase()));
    }
  } else {
    for (const georgianStem of georgianFor.get(wordStem) ?? []) {
      variants.push(literal(georgianStem));
    }
    const georgian = transliteration(surface);
    if (georgian !== null) variants.push(georgian);
  }
  return variants;
}

/**
 * The words a misspelt search word can be corrected to: the dictionary's own
 * English words and Georgian title words. `known` also holds the Georgian
 * stems, so a correctly spelt word in any case form is never "corrected".
 */
const vocabulary = (() => {
  const words = new Set<string>();
  const known = new Set<string>();
  for (const [georgianStem, entry] of Object.entries(dictionary.entries)) {
    known.add(georgianStem);
    words.add(entry.word.toLowerCase());
    for (const english of entry.en) {
      if (!/\s/.test(english)) words.add(english.toLowerCase());
    }
  }
  for (const word of words) known.add(word);
  return { words: [...words].map((word) => ({ word, letters: [...word] })), known };
})();

/** Edit distance with adjacent swaps (optimal string alignment), over code points. */
function editDistance(a: readonly string[], b: readonly string[]): number {
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    const row = rows[i] as number[];
    const above = rows[i - 1] as number[];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        (above[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (above[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, ((rows[i - 2] as number[])[j - 2] as number) + 1);
      }
      row[j] = best;
    }
  }
  return (rows[a.length] as number[])[b.length] as number;
}

/**
 * The closest dictionary word to a word the dictionary does not know: one
 * edit away for words of four to six letters, two for longer ones. Null
 * when the word is known, too short, has a digit, or nothing is that close.
 * The first closest word in dictionary order wins a tie, so it is stable.
 */
function correction(surface: string, wordStem: string): string | null {
  const letters = [...surface];
  if (letters.length < 4 || /\d/.test(surface)) return null;
  if (vocabulary.known.has(surface) || vocabulary.known.has(wordStem)) return null;
  const budget = letters.length >= 7 ? 2 : 1;
  let best: string | null = null;
  let bestDistance = budget + 1;
  for (const candidate of vocabulary.words) {
    if (Math.abs(candidate.letters.length - letters.length) > budget) continue;
    const distance = editDistance(letters, candidate.letters);
    if (distance < bestDistance) {
      best = candidate.word;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The search text with each misspelt word replaced by its closest dictionary
 * word ("acountant" → "accountant", "ბუღალტეი" → "ბუღალტერი"), for a "Did
 * you mean" link when a search finds nothing. Null when no word changes.
 * The caller still checks that the corrected search finds something before
 * offering it.
 */
export function suggestSearch(text: string): string | null {
  const normalized = text.normalize('NFKC');
  let suggestion = '';
  let last = 0;
  for (const token of tokenize(normalized)) {
    const surface = normalized.slice(token.start, token.end).replace(INVISIBLE, '').toLowerCase();
    const fix = correction(surface, token.stem);
    if (fix === null) continue;
    suggestion += normalized.slice(last, token.start) + fix;
    last = token.end;
  }
  return last === 0 ? null : (suggestion + normalized.slice(last)).trim();
}

/** The search text as terms; empty when it holds no letter or digit. */
export function searchTerms(text: string): SearchTerm[] {
  const normalized = text.normalize('NFKC');
  const terms: SearchTerm[] = [];
  const seen = new Set<string>();
  for (const token of tokenize(normalized)) {
    if (seen.has(token.stem)) continue;
    seen.add(token.stem);
    const surface = normalized.slice(token.start, token.end).replace(INVISIBLE, '').toLowerCase();
    const alternatives = [...new Set(variantsFor(surface, token.stem).map(alternative))].slice(
      0,
      MAX_VARIANTS,
    );
    terms.push({ word: surface, pattern: `(?:${alternatives.join('|')})` });
    if (terms.length === MAX_SEARCH_WORDS) break;
  }
  return terms;
}
