import { describe, expect, it } from 'vitest';
import { ssGeSource } from './policies/ss-ge.js';
import { REAL_ESTATE_SOURCES, TENDER_ONLY_SOURCES } from './source-traits.js';

describe('source traits', () => {
  it('lists ss.ge as a real-estate source, and no job or tender board', () => {
    expect(REAL_ESTATE_SOURCES).toEqual([ssGeSource.slug]);
    expect(REAL_ESTATE_SOURCES.some((slug) => TENDER_ONLY_SOURCES.includes(slug))).toBe(false);
  });
});
