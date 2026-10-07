import { describe, expect, it } from 'vitest';
import { MAX_SEARCH_WORDS, searchTerms, suggestSearch } from './search-terms.js';

/**
 * The patterns are Postgres AREs for `~*`; the constructs used (non-capturing
 * groups, bracket sets with code-point ranges) mean the same in a JavaScript
 * `iu` regex, so these tests read them that way. The DB tests in
 * `queries.test.ts` and `public-queries.test.ts` run them through Postgres.
 */
function matchesAll(query: string, text: string): boolean {
  const terms = searchTerms(query);
  return terms.length > 0 && terms.every((term) => new RegExp(term.pattern, 'iu').test(text));
}

describe('searchTerms', () => {
  it('has no terms for empty or punctuation-only text', () => {
    expect(searchTerms('')).toEqual([]);
    expect(searchTerms('   ')).toEqual([]);
    expect(searchTerms(' - / , ')).toEqual([]);
  });

  it('finds a buyer by its abbreviation, in any letter case', () => {
    const buyer = 'GIZ - გერმანიის საერთაშორისო თანამშრომლობის საზოგადოება';
    expect(matchesAll('GIZ', buyer)).toBe(true);
    expect(matchesAll('giz', buyer)).toBe(true);
  });

  it('matches every word anywhere, in any order', () => {
    const row =
      'Development of Three Animated Educational Videos on Sustainable Forest Management GIZ';
    expect(matchesAll('forest video', row)).toBe(true);
    expect(matchesAll('GIZ forest', row)).toBe(true);
    expect(matchesAll('forest pipeline', row)).toBe(false);
  });

  it('carries an English word to the Georgian titles the dictionary gives for it', () => {
    expect(matchesAll('accountant', 'მთავარი ბუღალტერი')).toBe(true);
    expect(matchesAll('accountants', 'ბუღალტრის ასისტენტი')).toBe(true);
    expect(matchesAll('driver', 'მძღოლი-ექსპედიტორი')).toBe(true);
    expect(matchesAll('accountant', 'მძღოლი')).toBe(false);
  });

  it('carries a Georgian word to its English equivalents', () => {
    expect(matchesAll('მზარეული', 'Cook')).toBe(true);
    expect(matchesAll('მზარეულის', 'Senior Cook')).toBe(true);
  });

  it('strips Georgian case endings from the search word', () => {
    expect(matchesAll('მენეჯერის', 'გაყიდვების მენეჯერი')).toBe(true);
    expect(matchesAll('ბათუმში', '["ბათუმი"]')).toBe(true);
  });

  it('reads a Latin word as Georgian typed in Latin letters', () => {
    expect(matchesAll('mdzgoli', 'მძღოლი')).toBe(true);
    expect(matchesAll('bugalteri', 'მთავარი ბუღალტერი')).toBe(true);
    expect(matchesAll('mzareuli', 'მზარეული')).toBe(true);
    expect(matchesAll('menejeri', 'გაყიდვების მენეჯერი')).toBe(true);
    // Too short to be read as Georgian: three letters would match too much.
    expect(matchesAll('gza', 'გზა')).toBe(false);
  });

  it('keeps short words to whole words and word starts', () => {
    expect(matchesAll('IT', 'IT სპეციალისტი')).toBe(true);
    expect(matchesAll('IT', 'Digital Marketing Specialist')).toBe(false);
    expect(matchesAll('GIZ', 'Vizgiz Ltd')).toBe(false);
  });

  it('lets a long word match inside a Georgian compound', () => {
    expect(matchesAll('მექანიკოსი', 'ავტომექანიკოსი')).toBe(true);
  });

  it('escapes regex characters typed into the box', () => {
    expect(matchesAll('C++', 'C++ developer')).toBe(true);
    expect(matchesAll('C#', 'C# developer')).toBe(true);
    for (const text of ['a.b', '(x', '[', 'a|b', '\\', '$100', 'x*']) {
      for (const term of searchTerms(text)) {
        expect(() => new RegExp(term.pattern, 'iu')).not.toThrow();
      }
    }
  });

  it('caps the number of words and drops repeated ones', () => {
    const many = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    expect(searchTerms(many)).toHaveLength(MAX_SEARCH_WORDS);
    expect(searchTerms('manager managers manager')).toHaveLength(1);
  });

  it('suggests the closest dictionary word for a misspelt one', () => {
    expect(suggestSearch('acountant')).toBe('accountant');
    expect(suggestSearch('accauntant tbilisi')).toBe('accountant tbilisi');
    expect(suggestSearch('ბუღალტეი')).toBe('ბუღალტერი');
    expect(suggestSearch('Senior drivr')).toBe('Senior driver');
  });

  it('suggests nothing for known, short or numeric words', () => {
    expect(suggestSearch('accountant')).toBeNull();
    expect(suggestSearch('ბუღალტრის')).toBeNull();
    expect(suggestSearch('GIZ')).toBeNull();
    expect(suggestSearch('1c8')).toBeNull();
    expect(suggestSearch('')).toBeNull();
  });

  it('normalizes compatibility forms before matching', () => {
    // Full-width Latin, as some mobile keyboards produce.
    expect(matchesAll('ＧＩＺ', 'GIZ - buyer')).toBe(true);
  });
});
