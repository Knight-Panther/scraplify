import { describe, expect, it } from 'vitest';
import { ndcgAtK, recallAtK } from './metrics.js';

describe('recallAtK', () => {
  const judgments = new Map([
    ['a', 3 as const],
    ['b', 0 as const],
    ['c', 2 as const],
    ['d', 0 as const],
    ['e', 1 as const],
  ]);

  it('counts only relevant ids (grade > 0) found in the top K', () => {
    const ranked = ['b', 'a', 'd', 'c', 'e'];
    expect(recallAtK(ranked, judgments, 3)).toBeCloseTo(1 / 3);
    expect(recallAtK(ranked, judgments, 5)).toBeCloseTo(1);
  });

  it('is unaffected by unjudged ids appearing before K', () => {
    const ranked = ['x', 'y', 'a', 'c', 'e'];
    expect(recallAtK(ranked, judgments, 2)).toBeCloseTo(0);
    expect(recallAtK(ranked, judgments, 5)).toBeCloseTo(1);
  });

  it('is vacuously 1 when nothing is relevant', () => {
    const allZero = new Map([
      ['a', 0 as const],
      ['b', 0 as const],
    ]);
    expect(recallAtK(['a', 'b'], allZero, 1)).toBe(1);
  });

  it('rejects a non-positive-integer k', () => {
    expect(() => recallAtK(['a'], judgments, 0)).toThrow();
    expect(() => recallAtK(['a'], judgments, 1.5)).toThrow();
  });
});

describe('ndcgAtK', () => {
  // Hand-computed: grades a=3, b=2, c=1.
  // Ideal DCG@3 = 7/log2(2) + 3/log2(3) + 1/log2(4) = 7 + 1.892789... + 0.5
  const judgments = new Map([
    ['a', 3 as const],
    ['b', 2 as const],
    ['c', 1 as const],
  ]);
  const idealDcg = 7 / Math.log2(2) + 3 / Math.log2(3) + 1 / Math.log2(4);

  it('is 1 for the ideal ordering', () => {
    expect(ndcgAtK(['a', 'b', 'c'], judgments, 3)).toBeCloseTo(1);
  });

  it('matches the hand-computed value for a reversed ordering', () => {
    const dcg = 1 / Math.log2(2) + 3 / Math.log2(3) + 7 / Math.log2(4);
    expect(ndcgAtK(['c', 'b', 'a'], judgments, 3)).toBeCloseTo(dcg / idealDcg);
  });

  it('treats an id missing from judgments as grade 0, not excluded', () => {
    // Top-1 unjudged pushes the top relevant grade to rank 2.
    const dcgAt2 = 0 / Math.log2(2) + 7 / Math.log2(3);
    const idealDcgAt2 = 7 / Math.log2(2) + 3 / Math.log2(3);
    expect(ndcgAtK(['unjudged', 'a'], judgments, 2)).toBeCloseTo(dcgAt2 / idealDcgAt2);
  });

  it('is vacuously 1 when nothing is relevant', () => {
    const allZero = new Map([
      ['a', 0 as const],
      ['b', 0 as const],
    ]);
    expect(ndcgAtK(['b', 'a'], allZero, 2)).toBe(1);
  });

  it('rejects a non-positive-integer k', () => {
    expect(() => ndcgAtK(['a'], judgments, 0)).toThrow();
    expect(() => ndcgAtK(['a'], judgments, -1)).toThrow();
  });
});
