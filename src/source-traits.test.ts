import { describe, expect, it } from 'vitest';
import { etendersGeSource } from './policies/etenders-ge.js';
import { hrGeSource } from './policies/hr-ge.js';
import { jobsGeSource } from './policies/jobs-ge.js';
import { ssGeSource } from './policies/ss-ge.js';
import { summerSchoolsEuSource } from './policies/summerschoolsineurope-eu.js';
import { NON_VACANCY_SOURCES, REAL_ESTATE_SOURCES } from './source-traits.js';

describe('source traits', () => {
  it('lists ss.ge as a real-estate source, and no job, tender or programme board', () => {
    expect(REAL_ESTATE_SOURCES).toEqual([ssGeSource.slug]);
    expect(REAL_ESTATE_SOURCES.some((slug) => NON_VACANCY_SOURCES.includes(slug))).toBe(false);
  });

  it('lists the tender board and the programme sources as non-vacancy sources, never a job board', () => {
    expect([...NON_VACANCY_SOURCES].sort()).toEqual(
      [etendersGeSource.slug, summerSchoolsEuSource.slug].sort(),
    );
    expect(NON_VACANCY_SOURCES).not.toContain(jobsGeSource.slug);
    expect(NON_VACANCY_SOURCES).not.toContain(hrGeSource.slug);
  });
});
