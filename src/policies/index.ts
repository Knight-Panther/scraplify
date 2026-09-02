import { hrGePolicy, hrGeSource } from './hr-ge.js';
import { jobsGePolicy, jobsGeSource } from './jobs-ge.js';

export { hrGePolicy, hrGeSource, jobsGePolicy, jobsGeSource };

/** All registered sources and their policies, keyed by slug. */
export const sourcePolicies = {
  'jobs-ge': { source: jobsGeSource, policy: jobsGePolicy },
  'hr-ge': { source: hrGeSource, policy: hrGePolicy },
} as const;
