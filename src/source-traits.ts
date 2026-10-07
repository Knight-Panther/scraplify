import { etendersGeSource } from './policies/etenders-ge.js';

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
 * Sources that carry tenders and nothing else. The CV Ranked bundle holds
 * vacancies only (owner, 2026-10-07), so its health gate neither reads nor
 * waits on these: a slow or failed etenders.ge run must not freeze the
 * vacancy bundle.
 */
export const TENDER_ONLY_SOURCES: readonly string[] = [etendersGeSource.slug];
