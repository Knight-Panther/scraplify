import { and, desc, eq, isNull } from 'drizzle-orm';
import { matchingBundleBuilds, matchingBundlePublications } from '../../db/schema/index.js';
import type { Database } from '../../db/types.js';
import { BUNDLE_AGE_WARNING_HOURS, MAX_BUNDLE_AGE_HOURS } from './contract.js';
import { rollbackTarget } from './rollback.js';

/**
 * What `/admin/matching` and `npm run health:check` report about the
 * bundle pipeline. Every value is read from the build and publication
 * records; nothing is estimated.
 */

export interface MatchingBuildSummary {
  id: string;
  state: string;
  startedAt: string;
  finishedAt: string | null;
  opportunityCount: number | null;
  exclusions: Record<string, number> | null;
  errorCode: string | null;
  healthGateOverridden: boolean;
  artifactsRemoved: boolean;
}

export interface MatchingBundleStatus {
  active: {
    buildId: string;
    publicationId: string;
    reason: string;
    activatedAt: string;
    activatedBy: string;
    builtAt: string;
    /** Latest source confirmation the bundle's data covers — how fresh the data is, not the build. */
    corpusWatermark: string | null;
    opportunityCount: number | null;
    schemaVersion: number;
    featureContract: string;
  } | null;
  rollbackTargetBuildId: string | null;
  recentBuilds: MatchingBuildSummary[];
}

export async function getMatchingBundleStatus(
  db: Database,
  channel: string,
  recentLimit = 10,
): Promise<MatchingBundleStatus> {
  const [active] = await db
    .select({
      buildId: matchingBundlePublications.buildId,
      publicationId: matchingBundlePublications.id,
      reason: matchingBundlePublications.reason,
      activatedAt: matchingBundlePublications.activatedAt,
      activatedBy: matchingBundlePublications.activatedBy,
      builtAt: matchingBundleBuilds.finishedAt,
      corpusWatermark: matchingBundleBuilds.corpusWatermark,
      opportunityCount: matchingBundleBuilds.opportunityCount,
      schemaVersion: matchingBundleBuilds.schemaVersion,
      featureContract: matchingBundleBuilds.featureContract,
    })
    .from(matchingBundlePublications)
    .innerJoin(
      matchingBundleBuilds,
      eq(matchingBundleBuilds.id, matchingBundlePublications.buildId),
    )
    .where(
      and(
        eq(matchingBundlePublications.channel, channel),
        isNull(matchingBundlePublications.retiredAt),
      ),
    );

  const builds = await db
    .select()
    .from(matchingBundleBuilds)
    .where(eq(matchingBundleBuilds.channel, channel))
    .orderBy(desc(matchingBundleBuilds.startedAt))
    .limit(recentLimit);

  return {
    active:
      active === undefined
        ? null
        : {
            ...active,
            activatedAt: iso(active.activatedAt),
            builtAt: iso(active.builtAt ?? active.activatedAt),
            corpusWatermark: active.corpusWatermark === null ? null : iso(active.corpusWatermark),
          },
    rollbackTargetBuildId:
      active === undefined ? null : await rollbackTarget(db, channel, active.buildId),
    recentBuilds: builds.map((build) => ({
      id: build.id,
      state: build.state,
      startedAt: iso(build.startedAt),
      finishedAt: build.finishedAt === null ? null : iso(build.finishedAt),
      opportunityCount: build.opportunityCount,
      exclusions: (build.exclusions as Record<string, number> | null) ?? null,
      errorCode: build.errorCode,
      healthGateOverridden: build.healthGateOverridden,
      artifactsRemoved: build.artifactsRemovedAt !== null,
    })),
  };
}

/** Postgres's text timestamp format ("2026-09-25 17:04:08.067+00") to ISO-8601, which `web/lib/format.ts` expects. */
function iso(value: string): string {
  return new Date(value).toISOString();
}

export type MatchingAlertCode =
  | 'no_active_bundle'
  | 'bundle_stale'
  | 'bundle_aging'
  | 'last_build_failed'
  | 'build_possibly_stuck';

export interface MatchingAlert {
  level: 'critical' | 'warning';
  code: MatchingAlertCode;
  message: string;
}

const HOUR_MS = 60 * 60 * 1000;
const STUCK_BUILD_HOURS = 2;

/** Hours since the active bundle's data was built; null with no active bundle. */
export function activeBundleAgeHours(status: MatchingBundleStatus, now: string): number | null {
  if (status.active === null) return null;
  return (Date.parse(now) - Date.parse(status.active.builtAt)) / HOUR_MS;
}

export function assessMatchingHealth(status: MatchingBundleStatus, now: string): MatchingAlert[] {
  const alerts: MatchingAlert[] = [];
  const age = activeBundleAgeHours(status, now);
  if (age === null) {
    alerts.push({
      level: 'warning',
      code: 'no_active_bundle',
      message: 'no matching bundle has been published; CV matching is unavailable',
    });
  } else if (age > MAX_BUNDLE_AGE_HOURS) {
    alerts.push({
      level: 'critical',
      code: 'bundle_stale',
      message: `active bundle is ${Math.floor(age)}h old (limit ${MAX_BUNDLE_AGE_HOURS}h); CV matching is refused until a new build activates`,
    });
  } else if (age > BUNDLE_AGE_WARNING_HOURS) {
    alerts.push({
      level: 'warning',
      code: 'bundle_aging',
      message: `active bundle is ${Math.floor(age)}h old; matching stops at ${MAX_BUNDLE_AGE_HOURS}h`,
    });
  }

  const latest = status.recentBuilds[0];
  if (latest?.state === 'failed') {
    alerts.push({
      level: 'warning',
      code: 'last_build_failed',
      message: `last build failed (${latest.errorCode ?? 'unknown'}); the previous bundle stayed active`,
    });
  } else if (
    latest?.state === 'building' &&
    (Date.parse(now) - Date.parse(latest.startedAt)) / HOUR_MS > STUCK_BUILD_HOURS
  ) {
    alerts.push({
      level: 'warning',
      code: 'build_possibly_stuck',
      message: `a build has been running since ${latest.startedAt}`,
    });
  }
  return alerts;
}
