import { etendersGePolicy, etendersGeSource, isEtendersGeUrlAllowed } from './etenders-ge.js';
import { hrGePolicy, hrGeSource, isHrGeUrlAllowed } from './hr-ge.js';
import { isJobsGeUrlAllowed, jobsGePolicy, jobsGeSource } from './jobs-ge.js';
import { isSsGeUrlAllowed, ssGePolicy, ssGeSource } from './ss-ge.js';
import {
  isSummerSchoolsEuUrlAllowed,
  summerSchoolsEuPolicy,
  summerSchoolsEuSource,
} from './summerschoolsineurope-eu.js';

export {
  etendersGePolicy,
  etendersGeSource,
  hrGePolicy,
  hrGeSource,
  isEtendersGeUrlAllowed,
  isHrGeUrlAllowed,
  isJobsGeUrlAllowed,
  isSsGeUrlAllowed,
  isSummerSchoolsEuUrlAllowed,
  jobsGePolicy,
  jobsGeSource,
  ssGePolicy,
  ssGeSource,
  summerSchoolsEuPolicy,
  summerSchoolsEuSource,
};

/** All registered sources and their policies, keyed by slug. */
export const sourcePolicies = {
  'jobs-ge': { source: jobsGeSource, policy: jobsGePolicy },
  'hr-ge': { source: hrGeSource, policy: hrGePolicy },
  'etenders-ge': { source: etendersGeSource, policy: etendersGePolicy },
  'ss-ge': { source: ssGeSource, policy: ssGePolicy },
  'summerschoolsineurope-eu': { source: summerSchoolsEuSource, policy: summerSchoolsEuPolicy },
} as const;
