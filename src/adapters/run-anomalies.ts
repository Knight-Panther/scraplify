import { and, eq, sql } from 'drizzle-orm';
import { recordParserIncident } from '../db/ingest.js';
import { parserIncidents } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import type { ParserIncidentKind, ParserIncidentSeverity } from '../domain/incident.js';

/**
 * Durable records for whole-run anomalies (concept §21.3; Phase 7A, stage 7-3).
 *
 * Both adapters already evaluate a set of whole-run health guards and downgrade
 * a run that fails one to `partial`, which keeps it away from closure. What
 * they did not do is leave any record a person would see: the downgrade lived
 * only in a log line, so `/health`'s incident count stayed at zero through a
 * real count collapse.
 *
 * Only called for a run whose walk genuinely FINISHED — not incremental, not
 * stopped by a block/backoff, and (hr.ge) not resumed mid-index. Those other
 * `partial` runs are routine operating states, already surfaced as a degraded
 * last run on `/health`; recording an incident for each would bury the
 * anomalies this exists for.
 */

export const RUN_GUARD_ORIGIN = 'run_guard';

export interface RunGuard {
  /** Stable identifier, e.g. `baseline` or `quarantineRate`. */
  name: string;
  ok: boolean;
  /** Whether a failure of this guard means the listing count itself collapsed. */
  countGuard: boolean;
}

/** A surge is only meaningful against a real baseline, not a near-empty one. */
export const MIN_SURGE_BASELINE = 100;
export const DEFAULT_SURGE_RATIO = 2;

export interface RunAnomalyInput {
  sourceId: string;
  crawlRunId: string | null;
  detectedAt: string;
  guards: readonly RunGuard[];
  discoveredCount: number;
  /** discoveredCount of this source's last completed FULL-coverage run, or null if none. */
  baselineDiscoveredCount: number | null;
  /** The measured figures the guards were evaluated on, stored as evidence. */
  measurements: Record<string, unknown>;
  surgeRatio?: number;
}

export interface RunAnomaly {
  kind: ParserIncidentKind;
  severity: ParserIncidentSeverity;
  evidence: Record<string, unknown>;
}

/** Pure: which incidents a finished run warrants. */
export function detectRunAnomalies(input: RunAnomalyInput): RunAnomaly[] {
  const anomalies: RunAnomaly[] = [];
  const failed = input.guards.filter((guard) => !guard.ok);
  if (failed.length > 0) {
    anomalies.push({
      kind: failed.some((guard) => guard.countGuard) ? 'count_collapse' : 'other',
      severity: 'critical',
      evidence: {
        origin: RUN_GUARD_ORIGIN,
        failedGuards: failed.map((guard) => guard.name),
        discoveredCount: input.discoveredCount,
        baselineDiscoveredCount: input.baselineDiscoveredCount,
        ...input.measurements,
      },
    });
  }

  const ratio = input.surgeRatio ?? DEFAULT_SURGE_RATIO;
  if (
    input.baselineDiscoveredCount !== null &&
    input.baselineDiscoveredCount >= MIN_SURGE_BASELINE &&
    input.discoveredCount > input.baselineDiscoveredCount * ratio
  ) {
    // Not a guard, and it does not downgrade the run: a surge cannot drive
    // closure (more listings seen means fewer missing), so it is recorded for
    // a person to check (duplicated pagination? a parser matching extra
    // elements?) without blocking anything.
    anomalies.push({
      kind: 'count_surge',
      severity: 'warning',
      evidence: {
        origin: RUN_GUARD_ORIGIN,
        discoveredCount: input.discoveredCount,
        baselineDiscoveredCount: input.baselineDiscoveredCount,
        surgeRatio: ratio,
      },
    });
  }
  return anomalies;
}

/**
 * Records each detected anomaly, unless an unresolved run-level incident of the
 * same kind is already open for this source. A daily schedule hitting the same
 * broken selector would otherwise add an identical incident every run; the
 * first one already demands attention, and resolving it re-arms recording.
 */
export async function recordRunAnomalies(
  db: DatabaseOrTransaction,
  input: RunAnomalyInput,
): Promise<RunAnomaly[]> {
  const recorded: RunAnomaly[] = [];
  for (const anomaly of detectRunAnomalies(input)) {
    const [open] = await db
      .select({ id: parserIncidents.id })
      .from(parserIncidents)
      .where(
        and(
          eq(parserIncidents.sourceId, input.sourceId),
          eq(parserIncidents.kind, anomaly.kind),
          eq(parserIncidents.resolved, false),
          sql`${parserIncidents.evidence}->>'origin' = ${RUN_GUARD_ORIGIN}`,
        ),
      )
      .limit(1);
    if (open !== undefined) continue;
    await recordParserIncident(db, {
      sourceId: input.sourceId,
      crawlRunId: input.crawlRunId,
      detectedAt: input.detectedAt,
      ...anomaly,
    });
    recorded.push(anomaly);
  }
  return recorded;
}
