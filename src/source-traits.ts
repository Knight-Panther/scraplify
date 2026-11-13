import { etendersGeSource } from './policies/etenders-ge.js';
import { ssGeSource } from './policies/ss-ge.js';
import { summerSchoolsEuSource } from './policies/summerschoolsineurope-eu.js';

/**
 * Per-source facts that change how the rest of the system treats a board,
 * declared once here rather than as slug checks scattered across callers.
 */

/**
 * Sources whose runs never claim full coverage, because closure is read from
 * each listing's own page rather than inferred from absence (etenders.ge
 * states "completed", "failed" or "terminated" itself; `docs/addEtender.md`
 * §14.2). For these, a completed run is a complete sync, and "no
 * full-coverage run yet" is not a fault.
 */
export const SOURCES_WITHOUT_FULL_COVERAGE: readonly string[] = [etendersGeSource.slug];

/**
 * Sources that carry no vacancies: the tender board, and the programme
 * sources (Phase 15: courses, scholarships, grants and the like). The CV
 * Ranked bundle holds vacancies only (owner, 2026-10-07 and 2026-11-09), so
 * its health gate neither reads nor waits on these: a slow, failed or
 * never-crawled run of one of them must not freeze the vacancy bundle.
 */
export const NON_VACANCY_SOURCES: readonly string[] = [
  etendersGeSource.slug,
  summerSchoolsEuSource.slug,
];

/**
 * Sources whose listings are real estate, kept in the `realestate` schema and
 * never in `source_listings` or `crawl_runs`
 * (`docs/real-estate-implementation-guideline.md` §8). They share the
 * `sources` and `source_policies` tables for the policy record alone, so
 * whatever walks every source as a job board must leave these out: source
 * health (and with it `health:check` and the matching bundle's gate) and
 * retention's locks.
 */
export const REAL_ESTATE_SOURCES: readonly string[] = [ssGeSource.slug];
