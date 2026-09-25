import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Pool } from 'pg';
import { ADVISORY_LOCKS, withAdvisoryLock } from '../../db/advisory-lock.js';
import { matchingBundleBuilds, matchingBundlePublications } from '../../db/schema/index.js';
import type { Database } from '../../db/types.js';
import type { MatchingArtifactStore } from './artifact-store.js';
import { ARTIFACT_FILE_NAMES, validateArtifactSet } from './contract.js';
import { activationHistory } from './build.js';

export type RollbackResult =
  | { outcome: 'rolled_back'; fromBuildId: string; toBuildId: string; publicationId: string }
  | { outcome: 'refused'; reason: 'no_active_bundle' | 'no_rollback_target' | 'target_invalid' };

/**
 * Repoints the channel to the build that was activated before the current
 * one (change.md §15 rollback step 2). The target's files are re-verified
 * against their own manifest first, so a rollback can never activate a
 * version that has been damaged or removed since it was built.
 */
export async function rollbackMatchingBundle(
  db: Database,
  pool: Pool,
  store: MatchingArtifactStore,
  options: { channel: string; activatedBy: string; now?: () => Date },
): Promise<RollbackResult> {
  const now = options.now ?? (() => new Date());
  return withAdvisoryLock(pool, ADVISORY_LOCKS.matchingBundle, async () => {
    const [active] = await db
      .select({ id: matchingBundlePublications.id, buildId: matchingBundlePublications.buildId })
      .from(matchingBundlePublications)
      .where(
        and(
          eq(matchingBundlePublications.channel, options.channel),
          isNull(matchingBundlePublications.retiredAt),
        ),
      );
    if (active === undefined) return { outcome: 'refused', reason: 'no_active_bundle' };

    const target = await rollbackTarget(db, options.channel, active.buildId);
    if (target === null) return { outcome: 'refused', reason: 'no_rollback_target' };

    const files = new Map<string, Uint8Array>();
    for (const name of ARTIFACT_FILE_NAMES) {
      const bytes = await store.readFile(target, name);
      if (bytes !== null) files.set(name, bytes);
    }
    try {
      validateArtifactSet(target, files);
    } catch {
      return { outcome: 'refused', reason: 'target_invalid' };
    }

    const publicationId = await db.transaction(async (tx) => {
      const at = now().toISOString();
      const retired = await tx
        .update(matchingBundlePublications)
        .set({ retiredAt: at })
        .where(
          and(
            eq(matchingBundlePublications.id, active.id),
            isNull(matchingBundlePublications.retiredAt),
          ),
        )
        .returning({ id: matchingBundlePublications.id });
      if (retired.length !== 1) throw new Error('active publication changed during rollback');
      const id = randomUUID();
      await tx.insert(matchingBundlePublications).values({
        id,
        channel: options.channel,
        buildId: target,
        reason: 'rollback',
        previousPublicationId: active.id,
        activatedBy: options.activatedBy,
        activatedAt: at,
      });
      return id;
    });
    return {
      outcome: 'rolled_back',
      fromBuildId: active.buildId,
      toBuildId: target,
      publicationId,
    };
  });
}

/** The verified build activated immediately before `activeBuildId` whose files still exist, or null. */
export async function rollbackTarget(
  db: Database,
  channel: string,
  activeBuildId: string,
): Promise<string | null> {
  const history = await activationHistory(db, channel);
  const at = history.indexOf(activeBuildId);
  const candidate = at > 0 ? history[at - 1] : undefined;
  if (candidate === undefined) return null;
  const [build] = await db
    .select({ state: matchingBundleBuilds.state, removed: matchingBundleBuilds.artifactsRemovedAt })
    .from(matchingBundleBuilds)
    .where(eq(matchingBundleBuilds.id, candidate));
  return build?.state === 'verified' && build.removed === null ? candidate : null;
}
