import { LATIN_TO_GEORGIAN } from '../browse/search-terms.js';
import { stem, tokenize } from '../matching/lexical/text.js';

/**
 * What the Real estate search box means, as a Postgres `tsquery` for the
 * listings' `search` column (`src/db/schema/real-estate.ts`). Every word must
 * be found; within a word, any of its variants will do:
 *
 * - the word with its Georgian case ending stripped, matched as a prefix, so
 *   "საბურთალოზე" finds "საბურთალო" (the same `stem` Browse search uses);
 * - for a Latin word, the Georgian it spells when Georgian is typed in Latin
 *   letters, so "saburtalo" finds "საბურთალო".
 *
 * Browse search runs a regular expression over every row. That holds for
 * 15,000 vacancies and would not for 117,000 listings with descriptions, so
 * this one is answered from an index.
 */

/** Words past this are ignored, which bounds the query a search box can build. */
const MAX_WORDS = 8;
/** Spellings tried for one Latin word; "c" alone can stand for four letters. */
const MAX_SPELLINGS = 24;
/** A shorter stem is matched whole: one letter as a prefix matches most of the table. */
const MIN_PREFIX_LETTERS = 2;
/** A transliteration whose stem keeps fewer Georgian letters than this is dropped as noise. */
const MIN_TRANSLIT_STEM = 3;
/** The letters the `search` column is cut into words by; anything else never matches. */
const NOT_INDEXED = /[^0-9a-zა-ჿ]/g;

function lexeme(word: string): string {
  // `word` holds only indexed letters and digits, so it needs no escaping.
  return [...word].length >= MIN_PREFIX_LETTERS ? `'${word}':*` : `'${word}'`;
}

/** Every Georgian spelling a Latin word can stand for, letter by letter, longest digraph first. */
function georgianSpellings(word: string): string[] {
  let spellings = [''];
  for (let index = 0; index < word.length; ) {
    const entry = LATIN_TO_GEORGIAN.find(([latin]) => word.startsWith(latin, index));
    if (entry === undefined) return [];
    const [latin, georgian] = entry;
    spellings = spellings
      .flatMap((spelling) => [...georgian].map((letter) => spelling + letter))
      .slice(0, MAX_SPELLINGS);
    index += latin.length;
  }
  return spellings;
}

/** The search text as a `tsquery` for `to_tsquery('simple', …)`; null when it holds nothing to look for. */
export function listingSearchQuery(text: string): string | null {
  const groups: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenize(text)) {
    const word = token.stem.replace(NOT_INDEXED, '');
    if (word === '' || seen.has(word)) continue;
    seen.add(word);

    const variants = new Set([word]);
    if (/^[a-z]{3,}$/.test(word)) {
      for (const spelling of georgianSpellings(word)) {
        const georgian = stem(spelling);
        if ([...georgian].length >= MIN_TRANSLIT_STEM) variants.add(georgian);
      }
    }
    groups.push(`(${[...variants].map(lexeme).join(' | ')})`);
    if (groups.length === MAX_WORDS) break;
  }
  return groups.length === 0 ? null : groups.join(' & ');
}
