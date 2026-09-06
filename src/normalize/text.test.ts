import { describe, expect, it } from 'vitest';
import { normalizeApplicationValue, normalizeTitle, trigramSimilarity } from './text.js';

describe('normalizeTitle', () => {
  it('folds punctuation so the corpus pair with and without slash spacing matches', () => {
    // Both forms are real: the same job written `გადამზიდი/დისტრიბუტორი` on one
    // board and `გადამზიდი / დისტრიბუტორი` on the other.
    expect(normalizeTitle('გადამზიდი/დისტრიბუტორი')).toBe(
      normalizeTitle('გადამზიდი / დისტრიბუტორი'),
    );
  });

  it('returns null for text that normalizes away entirely', () => {
    for (const input of [null, undefined, '', '   ', '...']) {
      expect(normalizeTitle(input)).toBeNull();
    }
  });
});

describe('trigramSimilarity', () => {
  it('rates the corpus senior/junior analyst pair high but not identical', () => {
    // The hard negative: two genuinely different vacancies differing by one
    // morpheme. Similarity alone cannot separate them, which is why the dedupe
    // scorer never auto-links on title agreement.
    const senior = normalizeTitle('ბიუჯეტირებისა და რეპორტინგის უფროსი ანალიტიკოსი') ?? '';
    const junior = normalizeTitle('ბიუჯეტირებისა და რეპორტინგის უმცროსი ანალიტიკოსი') ?? '';
    const similarity = trigramSimilarity(senior, junior);
    expect(similarity).toBeGreaterThan(0.8);
    expect(similarity).toBeLessThan(1);
  });

  it('scores identical strings 1 and unrelated strings low', () => {
    expect(trigramSimilarity('ანალიტიკოსი', 'ანალიტიკოსი')).toBe(1);
    expect(trigramSimilarity('ბუღალტერი', 'მძღოლი')).toBeLessThan(0.2);
  });
});

describe('normalizeApplicationValue', () => {
  it('preserves URL path and query case', () => {
    // Paths and query values are case-sensitive. Lowercasing them collapsed
    // distinct ATS vacancy links into one key, and a shared vacancy-level
    // value is half of the only automatic merge path — so this was a
    // false-merge vector (adversarial review, 2026-09-06).
    expect(normalizeApplicationValue('url', 'https://smrtr.io/BB-Nd')).toBe(
      'https://smrtr.io/BB-Nd',
    );
    expect(normalizeApplicationValue('url', 'https://cleverstaff.net/i/vacancy-aPSWVf')).toBe(
      'https://cleverstaff.net/i/vacancy-aPSWVf',
    );
  });

  it('keeps two ATS links that differ only by case distinct', () => {
    const upper = normalizeApplicationValue('url', 'https://ats.example/Job/ABC?token=XyZ');
    const lower = normalizeApplicationValue('url', 'https://ats.example/job/abc?token=xyz');
    expect(upper).not.toBe(lower);
  });

  it('still folds scheme and host, which are case-insensitive', () => {
    expect(normalizeApplicationValue('url', 'HTTPS://SMRTR.IO/BB-Nd')).toBe(
      'https://smrtr.io/BB-Nd',
    );
  });

  it('strips tracking parameters but keeps identifying ones', () => {
    // ATS identifiers frequently live in the query string, so a blanket strip
    // would collapse every vacancy at one ATS into a single key.
    expect(
      normalizeApplicationValue('url', 'https://ats.example/apply?job=A1&utm_source=jobsge'),
    ).toBe('https://ats.example/apply?job=A1');
  });

  it('lowercases an email but does not rewrite its local part', () => {
    expect(normalizeApplicationValue('email', ' Info@IPKLI.com ')).toBe('info@ipkli.com');
    // Sub-addressing and dots are provider-specific conventions; rewriting an
    // employer's stated address on a guess is how a matching key becomes a
    // source of false merges.
    expect(normalizeApplicationValue('email', 'hr+jobs@example.com')).toBe('hr+jobs@example.com');
  });

  it('treats form and unspecified application methods as carrying no identity', () => {
    // 35 hr.ge listings apply via 'form' and 22 jobs.ge via 'unspecified'. If
    // those compared equal they would merge into one enormous cluster.
    expect(normalizeApplicationValue('form', 'form')).toBeNull();
    expect(normalizeApplicationValue('unspecified', 'unspecified')).toBeNull();
    expect(normalizeApplicationValue('email', '')).toBeNull();
  });
});
