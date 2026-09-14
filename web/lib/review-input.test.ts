import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InvalidReviewInputError,
  readCandidateId,
  readMovingListingId,
  readSurvivorListingId,
} from './review-input.js';

// The three readers share one implementation, so one pass over the bad-input
// shapes exercises all of them; a representative reader carries the assertion.
describe('readCandidateId', () => {
  it('accepts a uuid, trimmed', () => {
    const id = randomUUID();
    const form = new FormData();
    form.set('candidateId', ` ${id} `);
    expect(readCandidateId(form)).toBe(id);
  });

  /**
   * Postgres answers a malformed uuid with an error rather than an empty
   * result, so a mangled form field would reach the database as a 500 instead
   * of being refused here — the same reasoning `decision-input.ts` applies to
   * `opportunityId`.
   */
  it('refuses anything that is not a uuid', () => {
    for (const value of ['', '   ', 'not-a-uuid', "'; delete from duplicate_candidates--", '123']) {
      const form = new FormData();
      form.set('candidateId', value);
      expect(() => readCandidateId(form)).toThrow(InvalidReviewInputError);
    }
  });

  it('refuses a missing field', () => {
    expect(() => readCandidateId(new FormData())).toThrow(InvalidReviewInputError);
  });
});

describe('readSurvivorListingId and readMovingListingId', () => {
  it('read their own named field, not each other’s', () => {
    const survivor = randomUUID();
    const moving = randomUUID();
    const form = new FormData();
    form.set('survivorListingId', survivor);
    form.set('movingListingId', moving);
    expect(readSurvivorListingId(form)).toBe(survivor);
    expect(readMovingListingId(form)).toBe(moving);
  });

  it('refuses a malformed value on either field', () => {
    const form = new FormData();
    form.set('survivorListingId', 'not-a-uuid');
    form.set('movingListingId', randomUUID());
    expect(() => readSurvivorListingId(form)).toThrow(InvalidReviewInputError);
  });
});
