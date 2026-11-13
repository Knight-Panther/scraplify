import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OpportunityType } from '../domain/opportunity.js';
import { etendersGeSource } from '../policies/etenders-ge.js';
import { hrGeSource } from '../policies/hr-ge.js';
import { jobsGeSource } from '../policies/jobs-ge.js';
import { summerSchoolsEuSource } from '../policies/summerschoolsineurope-eu.js';
import { PROGRAMME_KINDS, programmeKindForListing } from './programme-kind.js';

describe('programme kinds', () => {
  it('are every opportunity type except job and tender', () => {
    expect([...PROGRAMME_KINDS].sort()).toEqual(
      OpportunityType.options.filter((type) => type !== 'job' && type !== 'tender').sort(),
    );
  });
});

describe('programmeKindForListing', () => {
  it('types every summerschoolsineurope.eu listing as a course, whatever its attributes say', () => {
    expect(programmeKindForListing(summerSchoolsEuSource.id, 'summer_school')).toBe(
      'summer_school',
    );
    expect(programmeKindForListing(summerSchoolsEuSource.id, null)).toBe('summer_school');
    expect(programmeKindForListing(summerSchoolsEuSource.id, 'grant')).toBe('summer_school');
  });

  it('a job board cannot declare a kind through its attributes', () => {
    for (const board of [jobsGeSource.id, hrGeSource.id]) {
      expect(programmeKindForListing(board, 'scholarship')).toBeUndefined();
      expect(programmeKindForListing(board, 'summer_school')).toBeUndefined();
    }
  });

  it('gives no kind for the tender board or an unknown source', () => {
    expect(programmeKindForListing(etendersGeSource.id, 'grant')).toBeUndefined();
    expect(programmeKindForListing(randomUUID(), 'grant')).toBeUndefined();
  });
});
