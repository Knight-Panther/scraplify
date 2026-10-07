import { etendersGePolicy, etendersGeSource, isEtendersGeUrlAllowed } from './etenders-ge.js';
import { hrGePolicy, hrGeSource, isHrGeUrlAllowed } from './hr-ge.js';
import { isJobsGeUrlAllowed, jobsGePolicy, jobsGeSource } from './jobs-ge.js';

export {
  etendersGePolicy,
  etendersGeSource,
  hrGePolicy,
  hrGeSource,
  isEtendersGeUrlAllowed,
  isHrGeUrlAllowed,
  isJobsGeUrlAllowed,
  jobsGePolicy,
  jobsGeSource,
};

/** All registered sources and their policies, keyed by slug. */
export const sourcePolicies = {
  'jobs-ge': { source: jobsGeSource, policy: jobsGePolicy },
  'hr-ge': { source: hrGeSource, policy: hrGePolicy },
  'etenders-ge': { source: etendersGeSource, policy: etendersGePolicy },
} as const;
