import { describe, expect, it } from 'vitest';
import { SYNTHETIC_PROFILES } from './synthetic-profiles.js';

describe('SYNTHETIC_PROFILES', () => {
  it("meets change.md §12's minimum of 15 profiles", () => {
    expect(SYNTHETIC_PROFILES.length).toBeGreaterThanOrEqual(15);
  });

  it('has unique, non-empty ids and text', () => {
    const ids = SYNTHETIC_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const profile of SYNTHETIC_PROFILES) {
      expect(profile.text.trim().length).toBeGreaterThan(0);
      expect(profile.summary.trim().length).toBeGreaterThan(0);
    }
  });

  it('covers all three language categories', () => {
    const languages = new Set(SYNTHETIC_PROFILES.map((p) => p.language));
    expect(languages).toEqual(new Set(['en', 'ka', 'mixed']));
  });

  it('every profile claiming Georgian text actually contains Georgian script', () => {
    const georgianScript = /[Ⴀ-ჿ]/;
    for (const profile of SYNTHETIC_PROFILES) {
      if (profile.language === 'ka' || profile.language === 'mixed') {
        expect(georgianScript.test(profile.text)).toBe(true);
      }
    }
  });
});
