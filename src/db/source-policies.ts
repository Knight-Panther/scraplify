import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import type { SourcePolicy } from '../domain/source.js';
import { sourcePolicies, sources } from './schema/index.js';
import type { DatabaseOrTransaction } from './types.js';

export type SyncSourcePolicyOutcome = 'created' | 'no-op' | 'refused-stale';

export interface SyncSourcePolicyResult {
  outcome: SyncSourcePolicyOutcome;
  /**
   * The revision id that is CURRENT for this source once this call
   * returns, read from WITHIN the same locked transaction that decided
   * `outcome` -- not a separate query afterward (Codex-caught P1, round 10
   * continued, 2026-09-25): a caller that re-queries `sources.
   * currentPolicyRevisionId` itself after this function returns has its own
   * race, since another deployment's sync could land in the gap between
   * this transaction's commit and that later read, capturing a revision id
   * that this deployment's actual `HttpFetcher` (built from its own
   * hardcoded, un-re-read policy object) was never actually constructed
   * from. Returning it from inside the transaction that already decided it
   * closes that gap entirely. `null` only when the source has no current
   * revision at all (a standing conflict with no prior successful sync —
   * see the `refused-stale` case below; never happens for `'created'` or
   * `'no-op'`).
   */
  currentRevisionId: string | null;
}

/**
 * The ONLY writer of `source_policies` rows (round 6 of the adversarial
 * review, 2026-09-24) — no crawl adapter or script should insert into that
 * table directly. Called by each adapter's `ensureXSourceSeeded()` at the
 * start of every crawl, AND runnable standalone via
 * `src/cli/sync-source-policies.ts` (`npm run sync-policies`), so a policy
 * edit can be activated the moment it's deployed rather than waiting for
 * the next scheduled crawl — which, per this project's own incident
 * history (`docs/STATUS.md`), has silently stopped running for a week
 * before. `policy.sourceId`'s own `sources` row must already exist.
 *
 * Returns which of three outcomes happened, rather than `void`
 * (Codex-caught gap, 2026-09-25): `src/cli/sync-source-policies.ts` needs
 * to tell a real operator "your edit was NOT applied" instead of logging
 * "synced" unconditionally regardless of what actually happened.
 *
 * 1. `'created'` — no current revision exists for this source at all, or
 *    the incoming content is genuinely newer -> a new revision is created
 *    and `sources.currentPolicyRevisionId` repointed at it.
 * 2. `'no-op'` — a current revision exists and its content is identical to
 *    the incoming policy. Re-running this on every crawl must not spam a
 *    new revision row when nothing actually changed.
 * 3. `'refused-stale'` — a current revision exists, content differs, but
 *    the incoming policy's `reviewDate` is NOT strictly newer (older, OR
 *    tied — see below) than the current revision's. An older worker or a
 *    stale deployment re-syncing a policy file that predates what's
 *    already live must not silently downgrade a newer, more restrictive
 *    decision (the race `docs/THREAT_MODEL.md` names explicitly for this
 *    boundary).
 *
 * A TIE on `reviewDate` is treated as `'refused-stale'`, not accepted as
 * newer (Codex-caught P1, 2026-09-25): this project's real policy files
 * use date-at-midnight timestamps, so two genuinely different revisions
 * reviewed the same calendar day are a real, not hypothetical, case. A
 * strict `<` comparison would have let a stale worker's differently-
 * content policy through whenever it happened to share today's date with
 * whatever's already current — exactly the downgrade this guard exists to
 * stop, just gated on the wrong operator. Requiring a STRICTLY later
 * `reviewDate` to ever repoint the current revision means an ambiguous
 * same-day conflict fails closed (refused, logged) rather than picked
 * arbitrarily; resolving it for real means bumping the date, which is
 * exactly the audit-trail discipline `docs/scraplify-concept.md` §5.3
 * already asks a policy revision to carry.
 *
 * The ENTIRE read-decide-write sequence runs inside one transaction, with
 * `SELECT ... FOR UPDATE` locking the `sources` row for its duration
 * (migration-safety-reviewer, 2026-09-24): this prevents literal write-write
 * corruption (two callers both deciding to write off the same stale read),
 * but on its own it does NOT make same-date ties safe against two genuinely
 * DIFFERENT deployments syncing concurrently — it only means they run fully
 * sequentially rather than truly in parallel, and whichever's transaction
 * happens to acquire the lock first still wins outright under a bare date
 * comparison, arbitrarily. `sources.policyConflictAt` (round 9, 2026-09-25,
 * Codex-caught P1) closes that gap: the moment a same-date, differing-
 * content tie is detected, this flag is set, and every subsequent sync for
 * that source — including the "winner"'s own next routine re-sync of its
 * unchanged, apparently-matching content — is refused too, regardless of
 * arrival order. This turns first-writer-wins into fail-closed-until-an-
 * operator-resolves-it-with-a-later-date, so a stale/permissive policy can
 * never quietly govern indefinitely just because its sync happened to reach
 * the database first.
 */
export async function syncSourcePolicy(
  db: DatabaseOrTransaction,
  policy: SourcePolicy,
): Promise<SyncSourcePolicyResult> {
  const incomingContent = policyContent(policy);

  // NO unlocked fast path (Codex-caught P1, round 10, 2026-09-25 --
  // removing a round-6 optimization that turned out to be unsafe): an
  // earlier version of this function read the current revision unlocked and
  // returned 'no-op' immediately when content already matched, to avoid
  // opening a transaction for the overwhelmingly common case of a crawl
  // re-syncing unchanged content. But an unlocked read can be answered from
  // a snapshot that's already stale by the time the caller acts on it -- if
  // another deployment updates `currentPolicyRevisionId` or sets
  // `policyConflictAt` in the instant between this read and the return, the
  // caller would begin fetching under a policy the database has since
  // superseded or flagged conflicted, exactly the scenario this whole guard
  // exists to catch. Every call now re-reads and re-decides under the same
  // `SELECT ... FOR UPDATE` lock as an accepted write, whether or not it
  // ends up writing anything -- a single row-lock acquisition against an
  // uncontended row is negligible next to this project's own multi-second
  // per-request crawl delays, so there is no real performance cost being
  // traded away here, only a race being closed.
  return await db.transaction(async (tx): Promise<SyncSourcePolicyResult> => {
    const [source] = await tx
      .select({
        currentPolicyRevisionId: sources.currentPolicyRevisionId,
        policyConflictAt: sources.policyConflictAt,
      })
      .from(sources)
      .where(eq(sources.id, policy.sourceId))
      .for('update');
    if (source === undefined) {
      throw new Error(
        `syncSourcePolicy: no sources row for sourceId ${policy.sourceId} -- seed the source itself before syncing its policy.`,
      );
    }

    const current =
      source.currentPolicyRevisionId === null
        ? undefined
        : (
            await tx
              .select()
              .from(sourcePolicies)
              .where(eq(sourcePolicies.id, source.currentPolicyRevisionId))
          )[0];

    if (current !== undefined) {
      const contentMatches = isDeepStrictEqual(policyContent(current), incomingContent);
      if (contentMatches && source.policyConflictAt === null) {
        return { outcome: 'no-op', currentRevisionId: current.id };
      }

      // `reviewDate` is itself part of `policyContent()`, so `contentMatches`
      // true implies the two dates are equal too -- the only way to reach
      // this point with `contentMatches` true is a standing conflict flag
      // (handled by the shared `else` branch below, which refuses without
      // needing its own case here).
      const incomingTime = new Date(policy.reviewDate).getTime();
      const currentTime = new Date(current.reviewDate).getTime();

      if (incomingTime > currentTime) {
        // Genuinely, unambiguously newer -- falls through to accept below,
        // clearing any standing conflict flag as part of that same write.
        // This IS the resolution path this project's own docs describe: an
        // operator bumps the reviewDate to a value strictly later than
        // whatever's current, and that alone disambiguates the conflict.
        if (source.policyConflictAt !== null) {
          console.warn(
            `syncSourcePolicy: resolving a prior same-date conflict for source ${policy.sourceId} -- ` +
              `incoming reviewDate ${policy.reviewDate} is strictly later than the current revision's ` +
              `(${current.reviewDate}), so it is accepted and the conflict flag is cleared.`,
          );
        }
      } else if (incomingTime === currentTime && !contentMatches) {
        // Codex-caught P1, round 9, 2026-09-25: a bare `<=` comparison
        // against `current` is a first-writer-wins race when two genuinely
        // different deployments sync the SAME reviewDate concurrently --
        // whichever's transaction takes the `sources` row lock first sees
        // the OLD (older-dated) current, is accepted unconditionally, and
        // becomes current; the second then hits this exact branch and is
        // refused as "stale," even though it may be the correct, more
        // restrictive edit and the first writer may be a stale worker's
        // outdated file that merely happened to share today's date. Because
        // `src/cli/run-jobs-ge-crawl.ts`/`run-hr-ge-crawl.ts` wire whichever
        // content wins straight into the http fetcher with no further
        // validation, a stale/permissive winner would keep governing every
        // future crawl indefinitely, undetected, while the correct
        // deployment's OWN crawls keep aborting (round 8's `refused-stale`
        // abort) forever. Fixed with `sources.policyConflictAt`: setting it
        // here means EVERY future sync for this source -- including the
        // winner's own next routine re-sync of its unchanged, apparently-
        // matching content -- is refused too (see the `contentMatches &&
        // policyConflictAt === null` guard above and the shared `else`
        // branch below), so the ambiguity fails closed for both sides
        // rather than silently resolving in favor of whoever got there
        // first. Only a genuinely later `reviewDate` (the `incomingTime >
        // currentTime` branch above) clears it -- exactly the "bump the
        // date to resolve the conflict" remediation this project's docs
        // already ask an operator to perform.
        await tx
          .update(sources)
          .set({ policyConflictAt: new Date().toISOString() })
          .where(eq(sources.id, policy.sourceId));
        console.warn(
          `syncSourcePolicy: AMBIGUOUS same-date conflict for source ${policy.sourceId} -- the current ` +
            `revision and this incoming one both carry reviewDate ${policy.reviewDate} but differ in content. ` +
            'Neither can be trusted as the intended policy, so EVERY sync for this source (including one whose ' +
            "content already matches whatever's current) will be refused until an operator resolves this with " +
            'a genuinely later reviewDate.',
        );
        return { outcome: 'refused-stale', currentRevisionId: current.id };
      } else {
        // Either genuinely older (ordinary staleness -- current stays
        // exactly as it was, no flag touched either way), or content
        // matches but a standing conflict from an earlier collision hasn't
        // been resolved yet (matching content alone never clears it).
        if (source.policyConflictAt !== null) {
          console.warn(
            `syncSourcePolicy: refusing to sync source ${policy.sourceId} -- a prior same-date policy ` +
              `conflict (flagged ${source.policyConflictAt}) has not been resolved yet. Resync with a ` +
              "genuinely later reviewDate to resolve it; matching the current revision's content does not " +
              'clear this on its own.',
          );
        } else {
          console.warn(
            `syncSourcePolicy: refusing to activate a policy revision for source ${policy.sourceId} ` +
              `(reviewDate ${policy.reviewDate}) not strictly newer than the current revision's ` +
              `(${current.reviewDate}) -- not applied. This is expected if an older worker or a stale ` +
              'deployment just tried to sync.',
          );
        }
        return { outcome: 'refused-stale', currentRevisionId: current.id };
      }
    } else if (source.policyConflictAt !== null) {
      // No current revision at all, yet a standing conflict flag exists --
      // shouldn't arise from this function's own logic (the flag is only
      // ever set alongside an existing current revision, never cleared
      // except by an accepted write that also sets a fresh current), but
      // fails closed rather than silently treating this as a first-ever
      // sync if it somehow did.
      return { outcome: 'refused-stale', currentRevisionId: null };
    }

    // A FRESH id, not `policy.id` (the constant hardcoded in the TS policy
    // file) -- deliberate, not an oversight. `source_policies.id` is a
    // PRIMARY KEY, and the exact bug this round exists to fix is a
    // content-only edit (`reviewDate`, `display`, anything) that leaves
    // `id` unchanged (commit 677ebf7's own precedent). If this insert used
    // `policy.id` as the row's identity, that exact scenario would try to
    // INSERT a row whose id already exists (the current revision, since
    // its content differs but its id doesn't) and crash the crawl with a
    // duplicate-key error -- a worse failure mode than round 5's silent
    // staleness. Generating the revision's own identity here decouples
    // "the developer's chosen version label" (`policyVersion`, itself
    // part of this row's compared content, so a label-only edit still
    // creates a real revision) from "this specific row's database
    // identity," so a forgotten version bump can never collide with an
    // existing row.
    const revisionId = randomUUID();
    await tx.insert(sourcePolicies).values({
      id: revisionId,
      sourceId: policy.sourceId,
      policyVersion: policy.policyVersion,
      allowedAcquisitionModes: policy.allowedAcquisitionModes,
      allowedPathPatterns: policy.allowedPathPatterns,
      disallowedPathPatterns: policy.disallowedPathPatterns,
      disallowedHosts: policy.disallowedHosts,
      allowedHosts: policy.allowedHosts,
      authenticationScope: policy.authenticationScope,
      rateLimit: policy.rateLimit,
      termsUrl: policy.termsUrl,
      robotsUrl: policy.robotsUrl,
      retention: policy.retention,
      display: policy.display,
      linkedResources: policy.linkedResources,
      reviewDate: policy.reviewDate,
      evidence: policy.evidence,
      notes: policy.notes,
      decisionOwner: policy.decisionOwner,
    });
    await tx
      .update(sources)
      // policyConflictAt: null unconditionally -- either it was already
      // null (the ordinary case) or this write is the genuinely-later-date
      // resolution of a standing conflict (see the `incomingTime >
      // currentTime` branch above), and either way an accepted write means
      // there is no more ambiguity left to flag.
      .set({ currentPolicyRevisionId: revisionId, policyConflictAt: null })
      .where(eq(sources.id, policy.sourceId));
    return { outcome: 'created', currentRevisionId: revisionId };
  });
}

/**
 * The fields that represent actual policy CONTENT, shared between a
 * `SourcePolicy` (from a `src/policies/*.ts` file) and a stored
 * `source_policies` row (a `SourcePolicyRow`, whose jsonb columns come back
 * from drizzle typed as `unknown`) -- excludes row identity (`id`,
 * `sourceId`) and revision metadata (`createdAt`, which doesn't exist on
 * `SourcePolicy` at all). Destructuring rather than an object spread with
 * omitted keys so a field renamed on either side fails to typecheck instead
 * of silently comparing the wrong shape; the parameter type is deliberately
 * loose on the jsonb-shaped fields (`unknown`, the honest type a database
 * round-trip actually has) since both callers pass a value structurally
 * compatible with it and `isDeepStrictEqual` needs no narrower type to
 * compare correctly.
 */
function policyContent(row: {
  policyVersion: string;
  allowedAcquisitionModes: unknown;
  allowedPathPatterns: unknown;
  disallowedPathPatterns: unknown;
  disallowedHosts: unknown;
  allowedHosts: unknown;
  authenticationScope: string;
  rateLimit: unknown;
  termsUrl: string | null;
  robotsUrl: string;
  retention: unknown;
  display: unknown;
  linkedResources: unknown;
  reviewDate: string;
  evidence: unknown;
  notes: string;
  decisionOwner: string;
}) {
  const {
    policyVersion,
    allowedAcquisitionModes,
    allowedPathPatterns,
    disallowedPathPatterns,
    disallowedHosts,
    allowedHosts,
    authenticationScope,
    rateLimit,
    termsUrl,
    robotsUrl,
    retention,
    display,
    linkedResources,
    reviewDate,
    evidence,
    notes,
    decisionOwner,
  } = row;
  return {
    policyVersion,
    allowedAcquisitionModes,
    allowedPathPatterns,
    disallowedPathPatterns,
    disallowedHosts,
    allowedHosts,
    authenticationScope,
    rateLimit,
    termsUrl,
    robotsUrl,
    retention,
    display,
    linkedResources,
    // Normalized to a fixed ISO format, not compared as the raw string
    // (Codex-caught test failure, 2026-09-25): a `timestamp` column
    // round-trips through Postgres in its own string shape, which need not
    // match whatever format a caller's literal happened to use (e.g. no
    // `.000` milliseconds) even for the exact same instant -- comparing the
    // raw strings would flag two genuinely identical policies as different
    // and spam a needless revision on every resync.
    reviewDate: new Date(reviewDate).toISOString(),
    evidence,
    notes,
    decisionOwner,
  };
}
