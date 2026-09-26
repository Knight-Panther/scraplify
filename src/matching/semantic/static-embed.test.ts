import { describe, expect, it } from 'vitest';
import {
  cosine,
  createTokenizer,
  embed,
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
