import { describe, expect, it } from 'vitest';
import type { BundleOpportunity } from '../bundle/schema.js';
import type { MatchProfile, ProfileTerm } from '../lexical/profile.js';
import { userTerm } from '../lexical/profile.js';
import { phraseStems } from '../lexical/text.js';
import { cvLines, indexHybrid, rankHybrid } from './hybrid.js';
import { parseStaticModel } from './static-embed.js';
import type { TitleDictionary } from './title-english.js';

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
  const index = indexHybrid(rows, MODEL, DICTIONARY);
  return rankHybrid(
    matchProfile,
    { lines, derived: matchProfile.terms },
    index,
    MODEL,
    DICTIONARY,
    { now: NOW },
  );
}

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
    const index = indexHybrid([accountant], MODEL, DICTIONARY);
    const run = (current: MatchProfile) =>
      rankHybrid(
        current,
        { lines: ['senior bookkeeper'], derived: [derived] },
        index,
        MODEL,
        DICTIONARY,
        {
          now: NOW,
        },
      ).results.length;
    expect(run(profile({ ...derived, active: false }))).toBe(0);
    expect(run(profile())).toBe(0);
    expect(run(profile(derived))).toBe(1);
  });
});
