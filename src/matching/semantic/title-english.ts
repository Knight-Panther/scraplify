import { tokenize } from '../lexical/text.js';

/**
 * English keys for Georgian vacancy titles, made by word lookup in a static,
 * reviewed dictionary (`title-dictionary.json`). No model and no LLM run
 * here or anywhere in production: the dictionary was drafted offline once
 * and reviewed by hand.
 *
 * Why: almost every title on jobs.ge and hr.ge is Georgian, and an English
 * CV compared with Georgian titles only meets the few the curated lexicon
 * bridges. An English key per title gives it a second index to search.
 * The spike (spike/semantic, E4) measured this recovering ~73% of what
 * LLM-translated titles gained, with nothing to run or pay for.
 *
 * Browser-safe: pure, no Node import.
 */

export interface TitleDictionary {
  textVersion: string;
  entries: Readonly<Record<string, { word: string; en: readonly string[] }>>;
}

const GEORGIAN = /\p{Script=Georgian}/u;

export interface EnglishTitle {
  /** The English key; empty when no word of the title could be carried over. */
  text: string;
  /** Georgian words with no dictionary entry, for coverage reporting. */
  unknown: string[];
}

/**
 * Each Georgian word becomes its first English equivalent; Latin words
 * ("SMM", "Java") are kept as written; a Georgian word the dictionary does
 * not know is dropped from the key and reported, never guessed.
 */
export function englishTitle(title: string, dictionary: TitleDictionary): EnglishTitle {
  const normalized = title.normalize('NFKC');
  const parts: string[] = [];
  const unknown: string[] = [];
  for (const token of tokenize(normalized)) {
    const surface = normalized.slice(token.start, token.end);
    if (!GEORGIAN.test(surface)) {
      parts.push(surface);
      continue;
    }
    const entry = dictionary.entries[token.stem];
    if (entry === undefined) unknown.push(surface);
    else if (entry.en[0] !== undefined) parts.push(entry.en[0]);
  }
  return { text: parts.join(' '), unknown };
}

/** Share of Georgian title words the dictionary knows, over a set of titles. */
export function dictionaryCoverage(
  titles: readonly string[],
  dictionary: TitleDictionary,
): { words: number; known: number; unknownWords: Map<string, number> } {
  let words = 0;
  let known = 0;
  const unknownWords = new Map<string, number>();
  for (const title of titles) {
    const normalized = title.normalize('NFKC');
    for (const token of tokenize(normalized)) {
      if (!GEORGIAN.test(normalized.slice(token.start, token.end))) continue;
      words++;
      if (dictionary.entries[token.stem] !== undefined) known++;
      else unknownWords.set(token.stem, (unknownWords.get(token.stem) ?? 0) + 1);
    }
  }
  return { words, known, unknownWords };
}
