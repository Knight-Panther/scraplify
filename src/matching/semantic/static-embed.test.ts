import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STATIC_E1_PIN } from '../models/static-e1.js';
import {
  cosine,
  createTokenizer,
  embed,
  parseStaticModel,
  type StaticTable,
  type UnigramVocab,
} from './static-embed.js';

// A toy vocabulary with the real model's layout: ids 0–3 are <s>, <pad>,
// </s>, <unk>; content pieces follow with log-probability scores.
const VOCAB: UnigramVocab = {
  unkId: 3,
  pieces: [
    ['<s>', 0],
    ['<pad>', 0],
    ['</s>', 0],
    ['<unk>', 0],
    ['▁', -2],
    ['▁manager', -3],
    ['▁man', -4],
    ['ager', -5],
    ['▁მენეჯერი', -3],
    ['s', -2],
  ],
};

describe('createTokenizer', () => {
  const tokenizer = createTokenizer(VOCAB);

  it('prefers the highest-scoring split', () => {
    // "▁manager" (-3) beats "▁man" + "ager" (-9).
    expect(tokenizer.encode('manager')).toEqual([5]);
    expect(tokenizer.encode('managers')).toEqual([5, 9]);
  });

  it('marks each word start and collapses whitespace', () => {
    expect(tokenizer.encode('  manager\n\tმენეჯერი  ')).toEqual([5, 8]);
  });

  it('reads Mtavruli capitals as ordinary Georgian', () => {
    expect(tokenizer.encode('ᲛᲔᲜᲔᲯᲔᲠᲘ')).toEqual([8]);
  });

  it('falls back to <unk> for characters no piece covers', () => {
    expect(tokenizer.encode('ж')).toEqual([4, 3]);
    expect(tokenizer.encode('')).toEqual([]);
  });
});

describe('embed', () => {
  const table: StaticTable = {
    dims: 2,
    scales: Float32Array.from([0.5, 0.5]),
    rows: Int8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 4, 0, 4, 0, 0, 0, 0, 4, 0, 0]),
  };

  it('averages the pieces, skips special ids and normalises', () => {
    const vector = embed([5, 3], table);
    expect(Array.from(vector)).toEqual([1, 0]);
    expect(cosine(embed([5], table), embed([8], table))).toBeCloseTo(0);
  });

  it('is all zeros when nothing is known', () => {
    expect(Array.from(embed([0, 3], table))).toEqual([0, 0]);
  });
});

describe('parseStaticModel', () => {
  const json = { dims: 2, unkId: 3, scales: [1, 1], pieces: VOCAB.pieces };
  const table = new Uint8Array(VOCAB.pieces.length * 2);

  it('builds a tokenizer and table from well-formed files', () => {
    const model = parseStaticModel(json, table);
    expect(model.table.dims).toBe(2);
    expect(model.tokenizer.encode('manager')).toEqual([5]);
  });

  it('refuses shapes the embedder could not use', () => {
    expect(() => parseStaticModel(null, table)).toThrow();
    expect(() => parseStaticModel({ ...json, scales: [1] }, table)).toThrow('scales');
    expect(() => parseStaticModel({ ...json, unkId: 99 }, table)).toThrow('unkId');
    expect(() => parseStaticModel({ ...json, pieces: [['a', 'b']] }, table)).toThrow('pieces');
    expect(() => parseStaticModel(json, table.subarray(1))).toThrow('table size');
  });
});

describe('the shipped model', () => {
  const dir = new URL(`../../../matching-models/${STATIC_E1_PIN.id}/`, import.meta.url);
  const files = Object.fromEntries(
    Object.keys(STATIC_E1_PIN.files).map((name) => [name, readFileSync(new URL(name, dir))]),
  );

  it('matches its pin byte for byte', () => {
    for (const [name, expected] of Object.entries(STATIC_E1_PIN.files)) {
      const bytes = files[name] as Buffer;
      expect(bytes.byteLength, name).toBe(expected.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(expected.sha256);
    }
  });

  it('loads, and ranks a related title above an unrelated one in each language', () => {
    const model = parseStaticModel(
      JSON.parse((files['model.json'] as Buffer).toString('utf8')),
      new Uint8Array(files['table.int8'] as Buffer),
    );
    expect(model.table.dims).toBe(STATIC_E1_PIN.dims);
    expect(model.table.rows.length).toBe(STATIC_E1_PIN.rows * STATIC_E1_PIN.dims);
    const vector = (text: string) => embed(model.tokenizer.encode(text), model.table);
    const closer = (anchor: string, near: string, far: string) =>
      cosine(vector(anchor), vector(near)) - cosine(vector(anchor), vector(far));
    // Similarity is compared within a language: English CV text meets
    // Georgian titles through their dictionary English keys, not directly.
    expect(closer('accountant', 'financial analyst', 'truck driver')).toBeGreaterThan(0.1);
    expect(closer('ბუღალტერი', 'ფინანსური ანალიტიკოსი', 'მძღოლი')).toBeGreaterThan(0.1);
  });
});
