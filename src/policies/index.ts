import { hrGePolicy, hrGeSource, isHrGeUrlAllowed } from './hr-ge.js';
import { isJobsGeUrlAllowed, jobsGePolicy, jobsGeSource } from './jobs-ge.js';

export {
  hrGePolicy,
  hrGeSource,
  isHrGeUrlAllowed,
  isJobsGeUrlAllowed,
  jobsGePolicy,
  jobsGeSource,
};

/** All registered sources and their policies, keyed by slug. */
export const sourcePolicies = {
  'jobs-ge': { source: jobsGeSource, policy: jobsGePolicy },
  'hr-ge': { source: hrGeSource, policy: hrGePolicy },
} as const;
