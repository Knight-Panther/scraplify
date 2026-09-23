import { describe, expect, it } from 'vitest';
import { MULTILINGUAL_E5_SMALL_PIN } from '../../models/multilingual-e5-small.js';
import { SYNTHETIC_PROFILES } from './synthetic-profiles.js';
import golden from './golden-vectors.node.json' with { type: 'json' };

/**
 * Guards the committed Node-side golden output (produced by
 * `npm run matching:embed-eval-corpus`, Phase 8A Stage 4) against the kind of
 * malformed-vector defect change.md §14 calls out explicitly: wrong
 * dimension, NaN/Infinite values, and a model-pin mismatch. This is the fixed
 * reference Stage 5's browser-Worker parity test compares against — if this
 * file's own vectors are broken, that comparison would be meaningless before
 * it even starts.
 */
describe('golden-vectors.node.json', () => {
  it('was generated against the currently pinned model/revision', () => {
    expect(golden.model.repo).toBe(MULTILINGUAL_E5_SMALL_PIN.repo);
    expect(golden.model.revision).toBe(MULTILINGUAL_E5_SMALL_PIN.revision);
    expect(golden.model.dtype).toBe(MULTILINGUAL_E5_SMALL_PIN.dtype);
  });

  it('has one vector per synthetic profile, in the same order, right-sized and finite', () => {
    expect(golden.profiles.length).toBe(SYNTHETIC_PROFILES.length);
    golden.profiles.forEach((entry, i) => {
      expect(entry.id).toBe(SYNTHETIC_PROFILES[i]?.id);
      expect(entry.vector.length).toBe(MULTILINGUAL_E5_SMALL_PIN.hiddenSize);
      for (const value of entry.vector) {
        expect(Number.isFinite(value)).toBe(true);
      }
    });
  });

  it('has at least one real, traceable opportunity vector, right-sized and finite', () => {
    expect(golden.opportunities.length).toBeGreaterThan(0);
    for (const entry of golden.opportunities) {
      expect(typeof entry.opportunityId).toBe('string');
      expect(entry.opportunityId.length).toBeGreaterThan(0);
      expect(entry.vector.length).toBe(MULTILINGUAL_E5_SMALL_PIN.hiddenSize);
      for (const value of entry.vector) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('every vector is L2-normalized, per the pinned normalize:true setting', () => {
    const allVectors = [...golden.profiles, ...golden.opportunities].map((e) => e.vector);
    for (const vector of allVectors) {
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1, 3);
    }
  });
});
