import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { getSourceHealth } from '../../browse/queries.js';
import { assessSourceHealth, type HealthAlert } from '../../browse/source-health.js';
import { ADVISORY_LOCKS, withAdvisoryLock } from '../../db/advisory-lock.js';
import { matchingBundleBuilds, matchingBundlePublications } from '../../db/schema/index.js';
import type { Database } from '../../db/types.js';
import type { MatchingArtifactStore } from './artifact-store.js';
import {
  ARTIFACT_FILE_NAMES,
  isSupportedSchema,
  MANIFEST_FILE,
  MATCHING_BUNDLE_SCHEMA_VERSION,
  MATCHING_FEATURE_CONTRACT,
  type MatchingBuildErrorCode,
  type MatchingManifest,
  MIN_COUNT_RATIO_VS_ACTIVE,
  OPPORTUNITIES_FILE,
  type OpportunitiesFile,
  sha256Hex,
  validateArtifactSet,
} from './contract.js';
import { findProvenanceDrift, readCorpusSnapshot } from './snapshot.js';

/**
 * Builds, verifies and atomically activates a matching bundle (Phase 8C).
 *
 * The one invariant everything here serves: an interrupted, invalid or
 * incompatible build never replaces the active bundle. Concretely:
 * - the build row is committed as `building` first, so a crash leaves an
 *   honest record the next run marks `interrupted`;
 * - files are written to the store atomically, then read BACK and checked
 *   against their own manifest before anything is activated;
 * - every row is re-checked against the live database (current canonical
 *   revision, live public member at the same URL);
 * - activation is one transaction that retires the old pointer and inserts
 *   the new one, and a partial unique index allows only one live pointer;
 * - any failure before that transaction leaves the previous bundle active,
 *   records a bounded error code, and removes the failed files.
 *
 * Runs under its own advisory lock and the dedupe lock, so canonical
 * revisions and memberships cannot move between snapshot and verification.
 */

export interface BuildOptions {
  channel: string;
  /** Who activates, recorded on the publication — a fixed identifier. */
  activatedBy: string;
  now?: () => Date;
  /** Restrict the corpus to these sources (tests). */
  sourceSlugs?: readonly string[];
  /** Build past a failing upstream health gate; recorded on the build. */
  overrideHealthGate?: boolean;
  /** Activate even when the corpus shrank below half of the active bundle. */
  allowCountDrop?: boolean;
  /**
   * Also hold the dedupe lock (default true) so canonical revisions and
   * memberships cannot move between snapshot and verification. Tests scoped
   * to their own disposable source turn it off, so they don't collide with
   * the dedupe-lock suite's own global lock assertions.
   */
  holdDedupeLock?: boolean;
  /** Test seams. */
  schemaVersion?: number;
  upstreamAlerts?: (db: Database, now: string) => Promise<HealthAlert[]>;
  afterArtifactsWritten?: (bundleId: string) => Promise<void>;
}

export type BuildResult =
  | { outcome: 'activated'; buildId: string; publicationId: string; opportunityCount: number }
  | { outcome: 'failed'; buildId: string; errorCode: MatchingBuildErrorCode };

class BuildFailure extends Error {
  constructor(readonly code: MatchingBuildErrorCode) {
    super(code);
  }
}

async function defaultUpstreamAlerts(db: Database, now: string): Promise<HealthAlert[]> {
  const sources = await getSourceHealth(db);
  return sources.flatMap((source) => assessSourceHealth(source, now));
}

export async function buildMatchingBundle(
  db: Database,
  pool: Pool,
  store: MatchingArtifactStore,
  options: BuildOptions,
): Promise<BuildResult> {
  return withAdvisoryLock(pool, ADVISORY_LOCKS.matchingBundle, () =>
    options.holdDedupeLock === false
      ? buildLocked(db, store, options)
      : withAdvisoryLock(pool, ADVISORY_LOCKS.dedupe, () => buildLocked(db, store, options)),
  );
}

async function buildLocked(
  db: Database,
  store: MatchingArtifactStore,
  options: BuildOptions,
): Promise<BuildResult> {
  const now = options.now ?? (() => new Date());
  const schemaVersion = options.schemaVersion ?? MATCHING_BUNDLE_SCHEMA_VERSION;
  await markInterruptedBuilds(db, store, options.channel, now().toISOString());

  const buildId = randomUUID();
  const startedAt = now().toISOString();
  await db.insert(matchingBundleBuilds).values({
    id: buildId,
    channel: options.channel,
    schemaVersion,
    featureContract: MATCHING_FEATURE_CONTRACT,
    state: 'building',
    startedAt,
    healthGateOverridden: options.overrideHealthGate === true,
  });

  let filesWritten = false;
  try {
    if (!isSupportedSchema(schemaVersion)) throw new BuildFailure('incompatible_schema');

    const alerts = await (options.upstreamAlerts ?? defaultUpstreamAlerts)(db, startedAt);
    const critical = alerts.filter(
      (alert) =>
        alert.level === 'critical' &&
        (options.sourceSlugs === undefined || options.sourceSlugs.includes(alert.sourceSlug)),
    );
    if (critical.length > 0 && options.overrideHealthGate !== true) {
      throw new BuildFailure('upstream_unhealthy');
    }

    const snapshot = await readCorpusSnapshot(db, {
      asOf: startedAt,
      ...(options.sourceSlugs === undefined ? {} : { sourceSlugs: options.sourceSlugs }),
    });
    if (snapshot.rows.length === 0) throw new BuildFailure('empty_bundle');

    const opportunitiesFile: OpportunitiesFile = {
      schemaVersion,
      bundleId: buildId,
      opportunities: snapshot.rows,
    };
    const opportunitiesBytes = new TextEncoder().encode(JSON.stringify(opportunitiesFile));
    const manifest: MatchingManifest = {
      schemaVersion,
      bundleId: buildId,
      featureContract: MATCHING_FEATURE_CONTRACT,
      model: null,
      generatedAt: startedAt,
      corpusWatermark: snapshot.corpusWatermark,
      sourceFreshness: snapshot.sourceFreshness,
      counts: {
        opportunities: snapshot.rows.length,
        sources: snapshot.rows.reduce((sum, row) => sum + row.sources.length, 0),
      },
      files: {
        [OPPORTUNITIES_FILE]: {
          sha256: sha256Hex(opportunitiesBytes),
          bytes: opportunitiesBytes.byteLength,
        },
      },
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

    try {
      await store.writeVersion(
        buildId,
        new Map([
          [MANIFEST_FILE, manifestBytes],
          [OPPORTUNITIES_FILE, opportunitiesBytes],
        ]),
      );
      filesWritten = true;
    } catch {
      throw new BuildFailure('artifact_write_failed');
    }
    await options.afterArtifactsWritten?.(buildId);

    // Read back what the store actually holds, not what was meant to be written.
    const stored = new Map<string, Uint8Array>();
    for (const name of ARTIFACT_FILE_NAMES) {
      const bytes = await store.readFile(buildId, name);
      if (bytes !== null) stored.set(name, bytes);
    }
    try {
      validateArtifactSet(buildId, stored);
    } catch {
      throw new BuildFailure('artifact_verify_failed');
    }
    if ((await findProvenanceDrift(db, snapshot.rows)).length > 0) {
      throw new BuildFailure('provenance_drift');
    }

    const artifacts = {
      [MANIFEST_FILE]: { sha256: sha256Hex(manifestBytes), bytes: manifestBytes.byteLength },
      ...manifest.files,
    };

    const publicationId = await db.transaction(async (tx) => {
      const [active] = await tx
        .select({
          id: matchingBundlePublications.id,
          opportunityCount: matchingBundleBuilds.opportunityCount,
        })
        .from(matchingBundlePublications)
        .innerJoin(
          matchingBundleBuilds,
          eq(matchingBundleBuilds.id, matchingBundlePublications.buildId),
        )
        .where(
          and(
            eq(matchingBundlePublications.channel, options.channel),
            isNull(matchingBundlePublications.retiredAt),
          ),
        )
        .for('update', { of: matchingBundlePublications });

      if (
        active?.opportunityCount != null &&
        options.allowCountDrop !== true &&
        snapshot.rows.length < active.opportunityCount * MIN_COUNT_RATIO_VS_ACTIVE
      ) {
        throw new BuildFailure('count_anomaly');
      }

      const finishedAt = now().toISOString();
      await tx
        .update(matchingBundleBuilds)
        .set({
          state: 'verified',
          finishedAt,
          corpusWatermark: snapshot.corpusWatermark,
          opportunityCount: snapshot.rows.length,
          exclusions: snapshot.exclusions,
          artifacts,
          manifestSha256: artifacts[MANIFEST_FILE].sha256,
        })
        .where(eq(matchingBundleBuilds.id, buildId));
      if (active !== undefined) {
        await tx
          .update(matchingBundlePublications)
          .set({ retiredAt: finishedAt })
          .where(eq(matchingBundlePublications.id, active.id));
      }
      const id = randomUUID();
      await tx.insert(matchingBundlePublications).values({
        id,
        channel: options.channel,
        buildId,
        reason: 'build',
        previousPublicationId: active?.id ?? null,
        activatedBy: options.activatedBy,
        activatedAt: finishedAt,
      });
      return id;
    });

    await collectGarbage(db, store, options.channel, now().toISOString());
    return {
      outcome: 'activated',
      buildId,
      publicationId,
      opportunityCount: snapshot.rows.length,
    };
  } catch (err) {
    const errorCode = err instanceof BuildFailure ? err.code : 'internal_error';
    if (filesWritten) await store.removeVersion(buildId).catch(() => undefined);
    await db
      .update(matchingBundleBuilds)
      .set({
        state: 'failed',
        errorCode,
        finishedAt: now().toISOString(),
        ...(filesWritten ? { artifactsRemovedAt: now().toISOString() } : {}),
      })
      .where(eq(matchingBundleBuilds.id, buildId));
    if (errorCode === 'internal_error') throw err;
    return { outcome: 'failed', buildId, errorCode };
  }
}

/** A `building` row still present when the lock is free was left by a crashed run. */
async function markInterruptedBuilds(
  db: Database,
  store: MatchingArtifactStore,
  channel: string,
  now: string,
): Promise<void> {
  const stale = await db
    .select({ id: matchingBundleBuilds.id })
    .from(matchingBundleBuilds)
    .where(
      and(eq(matchingBundleBuilds.channel, channel), eq(matchingBundleBuilds.state, 'building')),
    );
  for (const { id } of stale) {
    await store.removeVersion(id);
    await db
      .update(matchingBundleBuilds)
      .set({ state: 'failed', errorCode: 'interrupted', finishedAt: now, artifactsRemovedAt: now })
      .where(eq(matchingBundleBuilds.id, id));
  }
}

/**
 * Builds in the order they were first activated on this channel. The
 * rollback target is the one before the active build in this order, and
 * garbage collection keeps the active build plus two predecessors, so the
 * target always still has its files.
 */
export async function activationHistory(db: Database, channel: string): Promise<string[]> {
  const rows = await db
    .select({
      buildId: matchingBundlePublications.buildId,
      firstActivatedAt: sql<string>`min(${matchingBundlePublications.activatedAt})`,
    })
    .from(matchingBundlePublications)
    .where(eq(matchingBundlePublications.channel, channel))
    .groupBy(matchingBundlePublications.buildId)
    .orderBy(asc(sql`min(${matchingBundlePublications.activatedAt})`));
  return rows.map((row) => row.buildId);
}

export const RETAINED_PREDECESSORS = 2;

async function collectGarbage(
  db: Database,
  store: MatchingArtifactStore,
  channel: string,
  now: string,
): Promise<void> {
  const [active] = await db
    .select({ buildId: matchingBundlePublications.buildId })
    .from(matchingBundlePublications)
    .where(
      and(
        eq(matchingBundlePublications.channel, channel),
        isNull(matchingBundlePublications.retiredAt),
      ),
    );
  if (active === undefined) return;
  const history = await activationHistory(db, channel);
  const at = history.indexOf(active.buildId);
  const keep = new Set(history.slice(Math.max(0, at - RETAINED_PREDECESSORS), at + 1));

  const candidates = await db
    .select({ id: matchingBundleBuilds.id })
    .from(matchingBundleBuilds)
    .where(
      and(
        eq(matchingBundleBuilds.channel, channel),
        eq(matchingBundleBuilds.state, 'verified'),
        isNull(matchingBundleBuilds.artifactsRemovedAt),
      ),
    )
    .orderBy(desc(matchingBundleBuilds.startedAt));
  const removable = candidates.map((row) => row.id).filter((id) => !keep.has(id));
  for (const id of removable) await store.removeVersion(id);
  if (removable.length > 0) {
    await db
      .update(matchingBundleBuilds)
      .set({ artifactsRemovedAt: now })
      .where(inArray(matchingBundleBuilds.id, removable));
  }
}
