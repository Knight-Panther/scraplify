import { describe, expect, it } from 'vitest';
import type { BundleOpportunity } from '../bundle/schema.js';
import type { MatchProfile, ProfileTerm } from '../lexical/profile.js';
import { userTerm } from '../lexical/profile.js';
import { phraseStems } from '../lexical/text.js';
import {
  cvLines,
  HYBRID_RANK_VERSION,
  indexHybrid,
  needsStaticModel,
  rankHybrid,
  withStaticModel,
} from './hybrid.js';
import { parseStaticModel } from './static-embed.js';
import type { TitleDictionary } from './title-english.js';
import { parseTitleVectors, quantizeRows, type TitleVectors } from './title-vectors.js';

let seq = 0;
function row(title: string, overrides: Partial<BundleOpportunity> = {}): BundleOpportunity {
  seq++;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  return {
    opportunityId: id,
    canonicalRevisionId: id,
    semanticInputHash: 'a'.repeat(64),
    type: 'job',
    title,
    organization: null,
    deadlineAt: null,
    locations: [],
    taxonomy: [],
    sources: [{ sourceSlug: 'jobs-ge', sourceListingId: id, canonicalUrl: 'https://www.jobs.ge/' }],
    ...overrides,
  };
}

// A two-dimension toy model: "bookkeeping" words point one way, "zoo"
// words the other, and "bookkeeper" sits close to (not on) the first.
const PIECES: [string, number, [number, number]][] = [
  ['▁ბუღალტერი', -3, [4, 0]],
  ['▁ზოოლოგი', -3, [0, 4]],
  ['▁accountant', -3, [4, 0]],
  ['▁zookeeper', -3, [0, 4]],
  ['▁bookkeeper', -3, [4, 1]],
];
const MODEL = parseStaticModel(
  {
    dims: 2,
    unkId: 3,
    scales: [0.25, 0.25],
    pieces: [
      ['<s>', 0],
      ['<pad>', 0],
      ['</s>', 0],
      ['<unk>', 0],
      ...PIECES.map(([piece, score]) => [piece, score]),
    ],
  },
  Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, ...PIECES.flatMap(([, , vector]) => vector)]),
);

const entry = (word: string, en: string) => [phraseStems(word)[0], { word, en: [en] }] as const;
const DICTIONARY: TitleDictionary = {
  textVersion: 'test',
  entries: Object.fromEntries([entry('ბუღალტერი', 'accountant'), entry('ზოოლოგი', 'zookeeper')]),
};

const NOW = Date.parse('2026-09-25T12:00:00Z');

function profile(...terms: (ProfileTerm | null)[]): MatchProfile {
  return { terms: terms.filter((term): term is ProfileTerm => term !== null) };
}

function rank(rows: BundleOpportunity[], matchProfile: MatchProfile, lines: string[] = []) {
  const index = withStaticModel(indexHybrid(rows), MODEL, DICTIONARY);
  return rankHybrid(
    matchProfile,
    { lines, derived: matchProfile.terms },
    index,
    { dictionary: DICTIONARY, vectors: null },
    { now: NOW },
  );
}

/**
 * Title vectors for `rows`: the lexicon's Accountant role points one way,
 * and each title gets the vector `titleVector` gives it.
 */
function vectorsFor(
  rows: BundleOpportunity[],
  titleVector: (title: string) => [number, number],
): TitleVectors {
  const titles = [...new Set(rows.map((r) => r.title))];
  const { table, scales } = quantizeRows([[1, 0], ...titles.map(titleVector)]);
  return parseTitleVectors(
    {
      schemaVersion: 2,
      bundleId: '00000000-0000-4000-8000-000000000000',
      model: 'test-model',
      dims: 2,
      roles: [{ id: 'role:accountant', text: 'Accountant' }],
      titles,
      titleOf: rows.map((r) => titles.indexOf(r.title)),
      scales,
    },
    table,
    rows.length,
  );
}

describe('rankHybrid with title vectors', () => {
  const accountant = userTerm('role', 'Accountant');
  if (accountant === null) throw new Error('no term');
  const near = (title: string): [number, number] =>
    title === 'Ledger officer' ? [0.9, 0.1] : title === 'Zoo guide' ? [0, 1] : [0.6, 0.8];

  it('ranks titles close to an active role, with no static model at all', () => {
    const ledger = row('Ledger officer');
    const zoo = row('Zoo guide');
    const rows = [zoo, ledger];
    const result = rankHybrid(
      profile(accountant),
      { lines: [], derived: [accountant] },
      indexHybrid(rows),
      { dictionary: DICTIONARY, vectors: vectorsFor(rows, near) },
      { now: NOW },
    );
    // The zoo title is under 0.8 of the best cosine, so it is not offered.
    expect(result.results.map((r) => r.row.opportunityId)).toEqual([ledger.opportunityId]);
    expect(result.results[0]?.reasons).toEqual([
      { kind: 'similar', term: accountant.label, from: 'role' },
    ]);
    expect(result.similarity).toBe('roles');
    expect(result.version).toMatch(/^hybrid-v2\+.*\+test-model$/);
  });

  it('still reports role similarity when every title is too far from the role to be offered', () => {
    const rows = [row('Zoo guide')];
    const result = rankHybrid(
      profile(accountant),
      { lines: [], derived: [accountant] },
      indexHybrid(rows),
      { dictionary: DICTIONARY, vectors: vectorsFor(rows, near) },
      { now: NOW },
    );
    expect(result.results).toEqual([]);
    // Nothing was close, which is not the same as having no similarity to ask.
    expect(result.similarity).toBe('roles');
    expect(result.version).toMatch(/^hybrid-v2\+.*\+test-model$/);
  });

  it('ranks a title that is both a word match and closest to the role first, named by the word match', () => {
    const exact = row('ბუღალტერი');
    const ledger = row('Ledger officer');
    const rows = [ledger, exact];
    const onRole = (title: string): [number, number] =>
      title === 'ბუღალტერი' ? [1, 0] : near(title);
    const result = rankHybrid(
      profile(accountant),
      { lines: [], derived: [accountant] },
      indexHybrid(rows),
      { dictionary: DICTIONARY, vectors: vectorsFor(rows, onRole) },
      { now: NOW },
    );
    expect(result.results.map((r) => r.row.opportunityId)).toEqual([
      exact.opportunityId,
      ledger.opportunityId,
    ]);
    // A row with a word match is explained by it, not by similarity.
    expect(result.results[0]?.reasons.map((reason) => reason.kind)).toEqual(['role']);
    expect(result.results[1]?.reasons.map((reason) => reason.kind)).toEqual(['similar']);
  });

  it('asks for the static model only when a role has no vector the CV did not give it', () => {
    const rows = [row('Ledger officer')];
    const vectors = vectorsFor(rows, near);
    const zookeeper = userTerm('role', 'Zookeeper');
    if (zookeeper === null) throw new Error('no term');
    const derived = { lines: [], derived: [accountant] };
    expect(needsStaticModel(profile(accountant), derived, vectors)).toBe(false);
    // Typed by the user, and outside the lexicon: only the static model can compare it.
    expect(needsStaticModel(profile(accountant, zookeeper), derived, vectors)).toBe(true);
    // Found in the CV itself: left to the lexical list, as in the judged runs.
    expect(
      needsStaticModel(
        profile(accountant, zookeeper),
        { lines: [], derived: [accountant, zookeeper] },
        vectors,
      ),
    ).toBe(false);
    // No role with a vector, or no vectors at all.
    expect(needsStaticModel(profile(), derived, vectors)).toBe(true);
    expect(needsStaticModel(profile(accountant), derived, null)).toBe(true);
  });

  it('adds the static lists when a typed role needs them, and keeps the old version without vectors', () => {
    const zoo = row('ზოოლოგი');
    const rows = [zoo];
    const zookeeper = userTerm('role', 'Zookeeper');
    const index = withStaticModel(indexHybrid(rows), MODEL, DICTIONARY);
    // The title is close enough to Accountant for the role list to take part.
    const withVectors = rankHybrid(
      profile(accountant, zookeeper),
      { lines: [], derived: [accountant] },
      index,
      { dictionary: DICTIONARY, vectors: vectorsFor(rows, () => [0.9, 0.1]) },
      { now: NOW },
    );
    expect(withVectors.results[0]?.reasons).toContainEqual({
      kind: 'translated-role',
      term: 'Zookeeper',
    });
    expect(withVectors.version).toMatch(/\+test-model\+static-e1-v1$/);
    expect(withVectors.similarity).toBe('roles-and-cv');
    const without = rankHybrid(
      profile(zookeeper),
      { lines: [], derived: [] },
      index,
      { dictionary: DICTIONARY, vectors: null },
      { now: NOW },
    );
    expect(without.version).toBe(HYBRID_RANK_VERSION);
  });

  it('ranks by words alone, and says so, when it has neither', () => {
    const rows = [row('ბუღალტერი')];
    const result = rankHybrid(
      profile(accountant),
      { lines: [], derived: [accountant] },
      indexHybrid(rows),
      { dictionary: DICTIONARY, vectors: null },
      { now: NOW },
    );
    expect(result.similarity).toBe('none');
    expect(result.results).toHaveLength(1);
  });
});

describe('cvLines', () => {
  it('keeps short lines and drops contact details, prose and repeats', () => {
    const text = [
      '• Senior bookkeeper',
      'name@example.com',
      '+995 555 12 34 56',
      'I kept the books of a small company for many years and liked it very much',
      'senior bookkeeper',
      'ab',
      'ᲑᲣᲦᲐᲚᲢᲔᲠᲘ',
    ].join('\n');
    expect(cvLines(text)).toEqual(['Senior bookkeeper', 'ᲑᲣᲦᲐᲚᲢᲔᲠᲘ']);
  });
});

describe('rankHybrid', () => {
  it('reaches a title by similarity alone and names the CV line it is close to', () => {
    const accountant = row('ბუღალტერი');
    const zoo = row('ზოოლოგი');
    const result = rank([zoo, accountant], profile(), ['bookkeeper']);
    // The zoo title is far below the best match's similarity, so it is cut.
    expect(result.results.map((r) => r.row.opportunityId)).toEqual([accountant.opportunityId]);
    expect(result.results[0]?.reasons).toEqual([
      { kind: 'similar', term: 'bookkeeper', from: 'cv' },
    ]);
  });

  it('ranks word matches ahead of rows reached only by similarity', () => {
    const accountant = row('ბუღალტერი');
    const zoo = row('ზოოლოგი');
    const result = rank([accountant, zoo], profile(userTerm('role', 'ზოოლოგი')), ['bookkeeper']);
    expect(result.results[0]?.row.opportunityId).toBe(zoo.opportunityId);
    expect(result.results[0]?.reasons.map((reason) => reason.kind)).toEqual(['role']);
    expect(result.results[1]?.reasons.map((reason) => reason.kind)).toEqual(['similar']);
  });

  it("matches a role against a Georgian title's English key", () => {
    const zoo = row('ზოოლოგი');
    const result = rank([zoo], profile(userTerm('role', 'Zookeeper')));
    expect(result.results[0]?.reasons).toContainEqual({
      kind: 'translated-role',
      term: 'Zookeeper',
    });
  });

  it('applies the deadline and location filters to similarity-only rows too', () => {
    const closed = row('ბუღალტერი', { deadlineAt: '2026-09-01T00:00:00Z' });
    const elsewhere = row('ბუღალტერი', { locations: ['ბათუმი'] });
    const unstated = row('ბუღალტერი');
    const tbilisi = userTerm('role', 'თბილისი');
    const location = tbilisi && { ...tbilisi, id: 'location:tbilisi', kind: 'location' as const };
    const result = rank([closed, elsewhere, unstated], profile(location), ['bookkeeper']);
    expect(result.results.map((r) => r.row.opportunityId)).toEqual([unstated.opportunityId]);
    expect(result.results[0]?.locationUnstated).toBe(true);
    expect(result.stats).toMatchObject({ excludedDeadline: 1, excludedLocation: 1, matched: 1 });
  });

  it('drops a CV line holding a term the user switched off or removed', () => {
    const accountant = row('ბუღალტერი');
    const derived = userTerm('role', 'Bookkeeper');
    if (derived === null) throw new Error('no term');
    const index = withStaticModel(indexHybrid([accountant]), MODEL, DICTIONARY);
    const run = (current: MatchProfile) =>
      rankHybrid(
        current,
        { lines: ['senior bookkeeper'], derived: [derived] },
        index,
        { dictionary: DICTIONARY, vectors: null },
        { now: NOW },
      ).results.length;
    expect(run(profile({ ...derived, active: false }))).toBe(0);
    expect(run(profile())).toBe(0);
    expect(run(profile(derived))).toBe(1);
  });
});
