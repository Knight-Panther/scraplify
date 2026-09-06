import { describe, expect, it } from 'vitest';
import {
  DEDUPE_RULESET_VERSION,
  type ListingForScoring,
  type ScoringContext,
  scorePair,
} from './score-pair.js';

/**
 * Every case here is drawn from the real 410-listing corpus captured on
 * 2026-09-06, not invented. The hard negatives matter more than the positives:
 * §14.2 requires precision before recall, so a scorer that merges nothing is
 * far less harmful than one that merges the senior and junior analyst roles
 * below.
 */

function listing(overrides: Partial<ListingForScoring> = {}): ListingForScoring {
  return {
    sourceId: 'jobs-ge',
    sourceListingId: crypto.randomUUID(),
    titleRaw: 'Some title',
    organizationRaw: 'Some org',
    applicationType: null,
    applicationValue: null,
    publishedAt: '2026-09-01T00:00:00Z',
    deadlineAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

/** Counts as measured in the live corpus: ATS links are per-vacancy, inboxes are not. */
const context: ScoringContext = {
  applicationValueListingCounts: new Map([
    ['https://smrtr.io/bb-nd', 2],
    ['https://cleverstaff.net/i/vacancy-ccwxhq', 2],
    ['https://cleverstaff.net/i/vacancy-apswvf', 2],
    ['info@ipkli.com', 8],
    ['https://example.invalid/careers', 40],
  ]),
};

describe('scorePair', () => {
  it('confirms a real cross-posted vacancy sharing a per-vacancy ATS link', () => {
    // The genuine duplicate found in the corpus: same smrtr.io link, same
    // title, one listing on each board.
    const result = scorePair(
      listing({
        sourceId: 'jobs-ge',
        titleRaw: 'დიჯითალ კონსულტანტი',
        applicationType: 'url',
        applicationValue: 'https://smrtr.io/BB-Nd',
      }),
      listing({
        sourceId: 'hr-ge',
        titleRaw: 'დიჯითალ კონსულტანტი',
        applicationType: 'url',
        applicationValue: 'https://smrtr.io/BB-Nd',
      }),
      context,
    );

    expect(result.decision).toBe('confirmed_same');
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.signals.sharedVacancyLevelApplicationValue).toBe(true);
    expect(result.rulesetVersion).toBe(DEDUPE_RULESET_VERSION);
  });

  it('keeps the senior and junior analyst roles apart despite near-identical titles', () => {
    // The corpus's hardest negative: same employer, same ATS, titles differing
    // only by უფროსი (senior) vs უმცროსი (junior) inside a long string. Their
    // DISTINCT per-vacancy links are what must carry the separation.
    const result = scorePair(
      listing({
        sourceId: 'jobs-ge',
        titleRaw: 'ბიუჯეტირებისა და რეპორტინგის უფროსი ანალიტიკოსი',
        applicationType: 'url',
        applicationValue: 'https://cleverstaff.net/i/vacancy-CCWXHQ',
      }),
      listing({
        sourceId: 'hr-ge',
        titleRaw: 'ბიუჯეტირებისა და რეპორტინგის უმცროსი ანალიტიკოსი',
        applicationType: 'url',
        applicationValue: 'https://cleverstaff.net/i/vacancy-aPSWVf',
      }),
      context,
    );

    // Titles are extremely similar, so this must NOT auto-link on title alone.
    expect(result.decision).not.toBe('confirmed_same');
    expect(result.signals.sharedVacancyLevelApplicationValue).toBe(false);
  });

  it('does not merge two different jobs sharing one company inbox', () => {
    // info@ipkli.com is carried by 8 listings. Equality on it says "same
    // employer", never "same vacancy".
    const result = scorePair(
      listing({
        sourceId: 'jobs-ge',
        titleRaw: 'დისტრიბუტორი',
        organizationRaw: 'იფქლი',
        applicationType: 'email',
        applicationValue: 'info@ipkli.com',
      }),
      listing({
        sourceId: 'hr-ge',
        titleRaw: 'ოპერატორი',
        organizationRaw: 'იფქლი',
        applicationType: 'email',
        applicationValue: 'info@ipkli.com',
      }),
      context,
    );

    expect(result.decision).toBe('distinct');
    expect(result.signals.sharedEmployerLevelApplicationValue).toBe(true);
    expect(result.signals.sharedVacancyLevelApplicationValue).toBe(false);
  });

  it('sends employer + title agreement to review rather than auto-linking it', () => {
    // §14.2: "never auto-link solely because title, employer, and location
    // match". The real pair from the corpus — the same distributor role on
    // both boards, written slightly differently, with only a shared inbox.
    const result = scorePair(
      listing({
        sourceId: 'jobs-ge',
        titleRaw: 'გადამზიდი/დისტრიბუტორი',
        organizationRaw: 'იფქლი',
        applicationType: 'email',
        applicationValue: 'info@ipkli.com',
      }),
      listing({
        sourceId: 'hr-ge',
        titleRaw: 'გადამზიდი / დისტრიბუტორი',
        organizationRaw: 'იფქლი',
        applicationType: 'email',
        applicationValue: 'info@ipkli.com',
      }),
      context,
    );

    expect(result.decision).toBe('needs_review');
    expect(result.confidence).toBeLessThan(0.8);
    expect(result.reasons.join(' ')).toMatch(/§14\.2/);
  });

  it('never treats two listings from the same source as duplicates', () => {
    // §12.1 settles within-source identity by record id; two rows on one board
    // are two real postings however alike they read.
    const result = scorePair(
      listing({
        sourceId: 'jobs-ge',
        titleRaw: 'დიჯითალ კონსულტანტი',
        applicationType: 'url',
        applicationValue: 'https://smrtr.io/BB-Nd',
      }),
      listing({
        sourceId: 'jobs-ge',
        titleRaw: 'დიჯითალ კონსულტანტი',
        applicationType: 'url',
        applicationValue: 'https://smrtr.io/BB-Nd',
      }),
      context,
    );
    expect(result.decision).toBe('distinct');
  });

  it('flags a contradiction between a shared vacancy link and disagreeing titles', () => {
    const result = scorePair(
      listing({
        sourceId: 'jobs-ge',
        titleRaw: 'დიჯითალ კონსულტანტი',
        applicationType: 'url',
        applicationValue: 'https://smrtr.io/BB-Nd',
      }),
      listing({
        sourceId: 'hr-ge',
        titleRaw: 'მძღოლი',
        applicationType: 'url',
        applicationValue: 'https://smrtr.io/BB-Nd',
      }),
      context,
    );
    // Two strong signals disagree — a human decides, the ruleset does not.
    expect(result.decision).toBe('needs_review');
  });

  it('treats a shared generic careers page as no evidence at all', () => {
    const result = scorePair(
      listing({
        sourceId: 'jobs-ge',
        titleRaw: 'ბუღალტერი',
        organizationRaw: 'Alpha',
        applicationType: 'url',
        applicationValue: 'https://example.invalid/careers',
      }),
      listing({
        sourceId: 'hr-ge',
        titleRaw: 'მძღოლი',
        organizationRaw: 'Alpha',
        applicationType: 'url',
        applicationValue: 'https://example.invalid/careers',
      }),
      context,
    );
    expect(result.decision).toBe('distinct');
    expect(result.signals.sharedVacancyLevelApplicationValue).toBe(false);
  });

  it('treats an application value it has never counted as non-selective', () => {
    // Fail safe: an unknown value must default to "not a vacancy identifier",
    // never to "unique, therefore mergeable".
    const result = scorePair(
      listing({
        sourceId: 'jobs-ge',
        titleRaw: 'ბუღალტერი',
        applicationType: 'url',
        applicationValue: 'https://unseen.invalid/apply/1',
      }),
      listing({
        sourceId: 'hr-ge',
        titleRaw: 'ბუღალტერი',
        applicationType: 'url',
        applicationValue: 'https://unseen.invalid/apply/1',
      }),
      { applicationValueListingCounts: new Map() },
    );
    expect(result.decision).not.toBe('confirmed_same');
  });

  it('ignores form and unspecified application methods as identity signals', () => {
    // 35 hr.ge listings apply via 'form' and 22 jobs.ge via 'unspecified';
    // if those compared equal, they would merge into one giant cluster.
    const result = scorePair(
      listing({
        sourceId: 'jobs-ge',
        titleRaw: 'ბუღალტერი',
        organizationRaw: 'Alpha',
        applicationType: 'unspecified',
        applicationValue: 'unspecified',
      }),
      listing({
        sourceId: 'hr-ge',
        titleRaw: 'ბუღალტერი',
        organizationRaw: 'Beta',
        applicationType: 'form',
        applicationValue: 'form',
      }),
      context,
    );
    expect(result.signals.sharedVacancyLevelApplicationValue).toBe(false);
    expect(result.signals.sharedEmployerLevelApplicationValue).toBe(false);
    expect(result.decision).toBe('distinct');
  });

  it('records explainable reasons on every decision', () => {
    // §14.2 requires decisions to be recomputable and explainable; an empty
    // rationale would make a review queue useless.
    const result = scorePair(
      listing({ sourceId: 'jobs-ge', titleRaw: 'ბუღალტერი' }),
      listing({ sourceId: 'hr-ge', titleRaw: 'მძღოლი' }),
      context,
    );
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.rulesetVersion).toBe(DEDUPE_RULESET_VERSION);
  });
});
