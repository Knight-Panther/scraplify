import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEXICAL_TEXT_VERSION, phraseStems } from '../lexical/text.js';
import { dictionaryCoverage, englishTitle, type TitleDictionary } from './title-english.js';

const DICTIONARY: TitleDictionary = JSON.parse(
  readFileSync(new URL('./title-dictionary.json', import.meta.url), 'utf8'),
);

describe('title dictionary', () => {
  it('is keyed by the current stemmer', () => {
    // Keys are stems; if the stemming rules change, every key must be redone.
    expect(DICTIONARY.textVersion).toBe(LEXICAL_TEXT_VERSION);
    for (const [stem, entry] of Object.entries(DICTIONARY.entries)) {
      expect(phraseStems(entry.word), entry.word).toEqual([stem]);
    }
  });

  it('carries the reviewed corrections', () => {
    expect(englishTitle('მოლარე', DICTIONARY).text).toBe('cashier');
    // "სითი" (City Mall) once became "it" and matched IT vacancies.
    expect(englishTitle('სითი', DICTIONARY).text).toBe('city');
  });
});

describe('englishTitle', () => {
  it('translates Georgian words, keeps Latin ones and reports unknown words', () => {
    const result = englishTitle('SMM მენეჯერი ზზზზზზ', DICTIONARY);
    expect(result.text).toBe('SMM manager');
    expect(result.unknown).toEqual(['ზზზზზზ']);
  });

  it('reads inflected forms through the stem', () => {
    expect(englishTitle('გაყიდვების მენეჯერის', DICTIONARY).text).toBe('sales manager');
  });

  it('measures coverage over a set of titles', () => {
    const coverage = dictionaryCoverage(['გაყიდვების მენეჯერი', 'ზზზზზზ'], DICTIONARY);
    expect(coverage).toMatchObject({ words: 3, known: 2 });
    expect([...coverage.unknownWords.keys()]).toEqual([phraseStems('ზზზზზზ')[0]]);
  });
});
