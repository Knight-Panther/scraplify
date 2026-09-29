import { describe, expect, it } from 'vitest';
import type { BundleOpportunity } from '../bundle/schema.js';
import { phraseStems } from '../lexical/text.js';
import type { TitleDictionary } from './title-english.js';
import {
  parseTitleVectors,
  quantizeRows,
  ROLE_LIST_LENGTH,
  roleSimilarList,
  type TitleVectorsMeta,
} from './title-vectors.js';
import {
  buildTitleVectors,
  lexiconRoles,
  type TitleEmbedder,
  titleKey,
} from './title-vectors-build.js';

const BUNDLE = '00000000-0000-4000-8000-000000000000';

let seq = 0;
function row(title: string): BundleOpportunity {
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
  };
}

const DICTIONARY: TitleDictionary = {
  textVersion: 'test',
  entries: { [phraseStems('ბუღალტერი')[0] as string]: { word: 'ბუღალტერი', en: ['accountant'] } },
};

function meta(overrides: Partial<TitleVectorsMeta> = {}): TitleVectorsMeta {
  return {
    schemaVersion: 2,
    bundleId: BUNDLE,
    model: 'test-model',
    dims: 2,
    roles: [{ id: 'role:accountant', text: 'Accountant' }],
    titles: ['accountant', 'zoo guide'],
    titleOf: [0, 1, 0],
    scales: [0.01, 0.01, 0.01],
    ...overrides,
  };
}

describe('quantizeRows', () => {
  it('keeps a cosine within 0.01 of the float one', () => {
    const a = [0.6, 0.8];
    const b = [0.8, 0.6];
    const { table, scales } = quantizeRows([a, b]);
    const dot =
      ((table[0] ?? 0) * (table[2] ?? 0) + (table[1] ?? 0) * (table[3] ?? 0)) *
      (scales[0] ?? 0) *
      (scales[1] ?? 0);
    expect(Math.abs(dot - 0.96)).toBeLessThan(0.01);
  });

  it('refuses a zero, non-finite or ragged row', () => {
    expect(() => quantizeRows([[0, 0]])).toThrow();
    expect(() => quantizeRows([[Number.NaN, 1]])).toThrow();
    expect(() => quantizeRows([[1, 0], [1]])).toThrow();
  });
});

describe('parseTitleVectors', () => {
  const table = new Int8Array(6);

  it('maps each opportunity to its title row, after the roles', () => {
    const vectors = parseTitleVectors(meta(), table, 3);
    expect([...vectors.titleRow]).toEqual([1, 2, 1]);
    expect(vectors.roleRow.get('role:accountant')).toBe(0);
  });

  it('refuses every mismatch between the files and the bundle', () => {
    expect(() => parseTitleVectors(meta(), new Int8Array(5), 3)).toThrow('table size');
    expect(() => parseTitleVectors(meta({ scales: [0.01] }), table, 3)).toThrow('scale count');
    expect(() => parseTitleVectors(meta(), table, 4)).toThrow('opportunity count');
    expect(() => parseTitleVectors(meta({ titleOf: [0, 2, 0] }), table, 3)).toThrow('title index');
    expect(() =>
      parseTitleVectors(
        meta({
          roles: [
            { id: 'role:accountant', text: 'Accountant' },
            { id: 'role:accountant', text: 'Accountant' },
          ],
          titles: ['accountant'],
          titleOf: [0, 0, 0],
        }),
        table,
        3,
      ),
    ).toThrow('duplicate role');
  });
});

describe('roleSimilarList', () => {
  it('scores each eligible row by its best role and skips ineligible ones', () => {
    const { table, scales } = quantizeRows([
      [1, 0],
      [0.95, 0.31],
      [0, 1],
    ]);
    const vectors = parseTitleVectors(
      meta({ titles: ['accountant', 'zoo guide'], titleOf: [0, 1, 0], scales }),
      table,
      3,
    );
    const hits = roleSimilarList(
      ['role:accountant', 'role:unknown'],
      vectors,
      Uint8Array.from([1, 1, 0]),
      0,
      0,
    );
    expect(hits.map((hit) => hit.position)).toEqual([0, 1]);
    expect(hits[0]?.roleId).toBe('role:accountant');
    expect(roleSimilarList(['role:unknown'], vectors, Uint8Array.from([1, 1, 1]))).toEqual([]);
    // With the default floor, a title far from every role is left out.
    expect(
      roleSimilarList(['role:accountant'], vectors, Uint8Array.from([1, 1, 1])).map(
        (h) => h.position,
      ),
    ).toEqual([0, 2]);
    expect(ROLE_LIST_LENGTH).toBe(100);
  });

  it('calls nothing similar when every title is far from every role', () => {
    const { table, scales } = quantizeRows([
      [1, 0],
      [0.5, 0.87],
      [0.45, 0.89],
    ]);
    const vectors = parseTitleVectors(
      meta({ titles: ['cook', 'waiter'], titleOf: [0, 1, 0], scales }),
      table,
      3,
    );
    // Both cosines are about 0.5: within the relative floor of each other, but under the absolute one.
    expect(roleSimilarList(['role:accountant'], vectors, Uint8Array.from([1, 1, 1]))).toEqual([]);
    expect(
      roleSimilarList(['role:accountant'], vectors, Uint8Array.from([1, 1, 1]), 0.8, 0).length,
    ).toBe(3);
  });
});

describe('buildTitleVectors', () => {
  const calls: { texts: readonly string[]; as: string }[] = [];
  const embedder: TitleEmbedder = {
    model: 'test-model',
    dims: 2,
    embed: async (texts, as) => {
      calls.push({ texts, as });
      return texts.map((_, i) => [1, i + 1]);
    },
  };

  it('embeds every lexicon role as a query and each distinct title key once, as a passage', async () => {
    const rows = [row('ბუღალტერი'), row('Accountant'), row('Zoo  Guide'), row('zoo guide')];
    const { meta: built, table } = await buildTitleVectors(rows, DICTIONARY, embedder, {
      schemaVersion: 2,
      bundleId: BUNDLE,
    });
    expect(built.roles).toEqual(lexiconRoles());
    expect(built.roles).toContainEqual({ id: 'role:accountant', text: 'Accountant' });
    // The Georgian title and the English one share the key "accountant".
    expect(built.titles).toEqual(['accountant', 'zoo guide']);
    expect(built.titleOf).toEqual([0, 0, 1, 1]);
    expect(calls.map((call) => call.as)).toEqual(['query', 'passage']);
    expect(table.length).toBe((built.roles.length + 2) * 2);
    expect(() => parseTitleVectors(built, table, rows.length)).not.toThrow();
  });

  it('keys a title the dictionary cannot carry over by the title itself', () => {
    expect(titleKey('ზოოლოგი', DICTIONARY)).toBe('ზოოლოგი');
    expect(titleKey('Senior  Java Developer', DICTIONARY)).toBe('senior java developer');
  });

  it('refuses an embedder that returns the wrong shape', async () => {
    const short: TitleEmbedder = { ...embedder, embed: async () => [[1, 0]] };
    await expect(
      buildTitleVectors([row('x')], DICTIONARY, short, { schemaVersion: 2, bundleId: BUNDLE }),
    ).rejects.toThrow('wrong number');
    const flat: TitleEmbedder = { ...embedder, dims: 3 };
    await expect(
      buildTitleVectors([row('x')], DICTIONARY, flat, { schemaVersion: 2, bundleId: BUNDLE }),
    ).rejects.toThrow('wrong dimension');
  });
});
