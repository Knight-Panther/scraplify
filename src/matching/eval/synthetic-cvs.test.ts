import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveProfile, type Vocabulary } from '../lexical/profile.js';

/**
 * Regression suite over invented CVs (`synthetic-cvs.json`): Georgian,
 * English, mixed, Russian and Mtavruli-cased, across the professions the
 * boards actually list, each carrying traps — role and skill words used as
 * ordinary words ("key driver of growth", "data warehouse", "Doctor of
 * Philosophy"). It exists so matcher changes are judged on many CVs rather
 * than tuned to one.
 *
 * Data-independent on purpose: an empty vocabulary, so only the curated
 * lexicon speaks and the result cannot drift with crawls. Ranking quality
 * against a real bundle is measured separately.
 */

interface SyntheticCv {
  id: string;
  lang: 'en' | 'ka' | 'mixed' | 'ru';
  text: string;
  expectRoleKeys: string[];
  forbidRoleKeys: string[];
}

const CVS: SyntheticCv[] = JSON.parse(
  readFileSync(new URL('./synthetic-cvs.json', import.meta.url), 'utf8'),
);
const EMPTY: Vocabulary = { roles: [], fields: [], locations: [] };

function appliedRoles(text: string): string[] {
  return deriveProfile(text, EMPTY)
    .terms.filter((term) => term.kind === 'role' && term.active)
    .map((term) => term.id.slice('role:'.length));
}

describe('synthetic CVs', () => {
  it.each(CVS.map((cv) => [cv.id, cv] as const))('%s: applies no trap role', (_, cv) => {
    const applied = appliedRoles(cv.text);
    expect(applied.filter((key) => cv.forbidRoleKeys.includes(key))).toEqual([]);
  });

  // Matching reads Georgian and English; a Russian CV gets the page's
  // other-alphabet notice instead, so only the no-trap check applies to it.
  const readable = CVS.filter((cv) => cv.lang !== 'ru');
  it.each(readable.map((cv) => [cv.id, cv] as const))('%s: finds its own roles', (_, cv) => {
    const applied = appliedRoles(cv.text);
    expect(cv.expectRoleKeys.filter((key) => !applied.includes(key))).toEqual([]);
  });
});
