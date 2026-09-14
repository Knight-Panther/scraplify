import type { ListingView, ReviewQueueEntry } from '../../src/browse/queries.js';

/**
 * The review queue's derivations.
 *
 * `evidence` is jsonb, which means `unknown` at the type level and arbitrary
 * at runtime — including null, for a row written before the column existed
 * (§14.1's evidence column, added in migration 0019). Every read here checks
 * before it trusts, mirroring `ranked-row.ts`'s treatment of the same shape of
 * problem: a malformed or missing row degrades to "no reasons recorded"
 * rather than throwing, because one bad row must not take out the queue.
 */

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStrings(value: unknown): string[] {
  return asArray(value).filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
}

/**
 * The scorer's own sentences explaining a pending pair, verbatim.
 *
 * NOT for display. These come straight from `score-pair.ts` and name a spec
 * section by number ("§14.2 forbids auto-linking..."), use the scorer's own
 * vocabulary ("vacancy-level application value", "normalized organization"),
 * and exist to be checked by a developer reading `duplicate_candidates` —
 * see `reviewerReasons` for what a screen should actually render.
 */
export function evidenceReasons(evidence: unknown): string[] {
  return asStrings(asRecord(evidence).reasons);
}

/**
 * Whether this pair is a STALE LINK — two listings already merged into one
 * opportunity, re-queued because the evidence behind that merge has since
 * weakened (`run-dedupe.ts`'s "revisit automatic merges" pass). Detected by
 * the exact marker string that pass writes as the FIRST reason.
 *
 * This matters more than a translated bullet point can carry on its own:
 * "Different vacancies" on an ordinary pending pair only records a verdict,
 * but on a stale link it actually SPLITS an existing merge apart
 * (`rejectDuplicateCandidate`'s own stale-link branch). A reviewer deciding
 * between two actions with different real-world consequences needs to know
 * which one they are looking at BEFORE they decide, not buried in the
 * evidence list alongside everything else (commit gate, 2026-09-14).
 */
export function isStaleLinkPair(evidence: unknown): boolean {
  return evidenceReasons(evidence).some((reason) =>
    reason.includes('existing link no longer supported by the current ruleset'),
  );
}

/**
 * Each known scorer reason, translated into a sentence a reviewer — not a
 * developer — can read.
 *
 * `evidenceReasons` was being rendered VERBATIM on the review screen, spec
 * citations and scorer vocabulary included — exactly what `anti-patterns.md`'s
 * Vocabulary section forbids ("untranslated jargon from the codebase") — even
 * though a reviewer only ever sees the handful of shapes `scorePair` can
 * attach to a `needs_review` decision (the only decision this screen shows;
 * `confirmed_same` and `distinct` reasons never reach it). Matched by
 * characteristic substring rather than exact equality, since several reasons
 * carry a runtime-computed number or count that a fixed string can't match —
 * the number is extracted and kept in the translated sentence, not dropped.
 *
 * A reason this function does not recognise is neither shown raw (the P1 this
 * exists to fix) nor silently dropped (round 1's OWN P1: a decision made with
 * evidence hidden is still a decision made blind) — it becomes a plain
 * placeholder saying more was found than could be summarised, which is
 * honest either way.
 */
export function reviewerReasons(evidence: unknown): string[] {
  return evidenceReasons(evidence).map(translateReason);
}

function translateReason(reason: string): string {
  if (reason.includes('existing link no longer supported by the current ruleset')) {
    return 'These two are ALREADY merged into one record — the evidence behind that merge has since weakened, and a human is being asked to confirm or undo it.';
  }
  if (reason.includes('titles disagree')) {
    return 'The two titles read as different vacancies.';
  }
  if (reason.includes('vacancy-level application value is shared — contradictory')) {
    return 'But they share an application link specific to one vacancy — worth a second look.';
  }
  if (reason.includes('same organization and closely matching titles')) {
    return 'Same employer, and the titles closely match.';
  }
  if (reason.includes('forbids auto-linking on employer and title agreement alone')) {
    return "Matching employer and title alone isn't enough to link automatically — a person decides this one.";
  }
  const employerLevelMatch = reason.match(
    /shared application value is employer-level \(carried by (\d+) listings\)/,
  );
  if (employerLevelMatch) {
    return `The shared contact or link is used by ${employerLevelMatch[1]} listings from this employer — it identifies the employer, not this one vacancy.`;
  }
  if (reason.includes('posting dates are within the proximity window')) {
    return 'Both were posted around the same time.';
  }
  const vacancyLevelMatch = reason.match(
    /shared vacancy-level application value \(carried by (\d+) listings\)/,
  );
  if (vacancyLevelMatch) {
    return 'They share an application link specific to this one vacancy.';
  }
  if (reason.includes('titles agree')) {
    return 'The titles closely match.';
  }
  if (reason.includes('same normalized organization')) {
    return 'Same employer.';
  }
  // Not recognised: present rather than absent, but never the raw sentence.
  return 'The scorer found another signal for this pair that is not summarised here.';
}

/**
 * Which side of a pair should survive as the target opportunity, decided
 * deterministically rather than left as a per-pair choice.
 *
 * **An already-clustered side wins first, before first-seen date is ever
 * consulted.** Real fan-out makes this load-bearing, not a nicety: once one
 * sibling pair is accepted, that side's opportunity has more than one live
 * member, and `acceptDuplicateCandidate` refuses to move a listing OUT of a
 * cluster it shares with another. A first-seen-only rule can pick exactly the
 * wrong direction the moment that has happened — asking to move the
 * ALREADY-clustered side out, which the guard then refuses — making an
 * otherwise-safe accept of the next sibling permanently impossible through
 * this screen (commit gate, 2026-09-14). Preferring the larger cluster as
 * survivor always proposes the safe direction: extend the existing cluster,
 * never fracture it.
 *
 * Both listings are singletons until a merge happens — every listing has its
 * own opportunity from ingestion (§12.5) — so when NEITHER side is clustered
 * yet, accepting a pair genuinely can move either side into the other's; the
 * outcome is the same content either way, only the surviving opportunity id
 * differs. The EARLIER-seen listing's opportunity survives in that case,
 * because it is the one more likely to already carry other history (a prior
 * human decision, an existing ranking) worth keeping stable rather than
 * orphaning.
 */
export function pickSurvivor(pair: ReviewQueueEntry): {
  survivor: ListingView;
  moving: ListingView;
} {
  if (pair.aClusterSize !== pair.bClusterSize) {
    return pair.aClusterSize > pair.bClusterSize
      ? { survivor: pair.a, moving: pair.b }
      : { survivor: pair.b, moving: pair.a };
  }
  return pair.a.firstSeenAt <= pair.b.firstSeenAt
    ? { survivor: pair.a, moving: pair.b }
    : { survivor: pair.b, moving: pair.a };
}
