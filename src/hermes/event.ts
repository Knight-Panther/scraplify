import { realpathSync } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import {
  crawlRuns,
  matchingBundleBuilds,
  matchingBundlePublications,
  realEstateCrawlRuns,
  sources,
} from '../db/schema/index.js';
import type { Database } from '../db/types.js';

/**
 * The event Hermes is told when a pipeline run ends (`docs/hermes-hook.md`).
 * It carries the run's exit codes, ids and counters and nothing from a
 * listing: no title, employer, description or URL.
 */

export const HERMES_EVENT_SCHEMA = 1;

export const PIPELINE_STEPS = ['crawl', 'dedupe', 'taxonomy', 'bundle', 'retention'] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];
/** A step's exit code, or `null` for one that did not run (skipped, or not reached). */
export type StepCodes = Record<PipelineStep, number | null>;

export type PipelineStatus = 'succeeded' | 'failed' | 'partial' | 'interrupted';

export interface PipelineRun {
  sourceSlug: string;
  /**
   * When `deploy/run-pipeline.sh` started. Only a crawl run started at or
   * after it belongs to this pipeline run: when the crawl ends before creating
   * one (the lock is held, the database is down), the source's latest row is
   * an earlier run's, and reporting it would repeat that run's event id, which
   * Hermes drops as a duplicate.
   */
  startedAt: string;
  steps: StepCodes;
  exitCode: number;
  /** The script was stopped by a signal before its last step. */
  interrupted: boolean;
}

export interface EventContext {
  now: Date;
  /** The release's git sha, or `null` outside a release directory. */
  release: string | null;
  host: string;
}

export interface RunFacts {
  crawlRun: {
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    fullCoverage: boolean;
    counts: PipelineCounts;
  } | null;
  bundle: { id: string; opportunities: number | null } | null;
}

export interface PipelineCounts {
  discovered: number;
  new: number;
  changed: number;
  unchanged: number;
  /** Listed but not fetched again, because the results-page row had not changed (Phase 7C). */
  skipped: number;
  missing: number;
  expired: number;
  reopened: number;
  quarantined: number;
  failed: number;
}

export interface PipelineFinishedEvent {
  event_type: 'xtelo.pipeline.finished';
  schema: typeof HERMES_EVENT_SCHEMA;
  event_id: string;
  domain: 'opportunities';
  source: string;
  status: PipelineStatus;
  exit_code: number;
  steps: StepCodes;
  crawl_run: { id: string; status: string; started_at: string; finished_at: string | null } | null;
  counts: PipelineCounts | null;
  full_coverage: boolean | null;
  bundle?: { id: string; opportunities: number | null };
  release: string | null;
  host: string;
  emitted_at: string;
}

export interface TestEvent {
  event_type: 'xtelo.test';
  schema: typeof HERMES_EVENT_SCHEMA;
  event_id: string;
  release: string | null;
  host: string;
  emitted_at: string;
}

/**
 * One real-estate crawl run (Phase 11E): `deploy/run-realestate.sh` has a
 * crawl and nothing after it, so the only step is the crawl.
 */
export interface RealEstateRun {
  sourceSlug: string;
  /** When the script started; only a crawl run started at or after it is this run's (as for `PipelineRun`). */
  startedAt: string;
  crawl: number | null;
  exitCode: number;
  interrupted: boolean;
}

/** The counters of `realestate.crawl_runs`, without the `_count` suffix. */
export interface RealEstateCounts {
  pages: number;
  rows: number;
  new: number;
  changed: number;
  bumped: number;
  unchanged: number;
  reopened: number;
  gone: number;
  verified: number;
}

export interface RealEstateRunFacts {
  crawlRun: {
    id: string;
    mode: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    counts: RealEstateCounts;
  } | null;
}

/** The same event type under `domain: realestate`, with that domain's one step and its counters. */
export interface RealEstateFinishedEvent {
  event_type: 'xtelo.pipeline.finished';
  schema: typeof HERMES_EVENT_SCHEMA;
  event_id: string;
  domain: 'realestate';
  source: string;
  status: PipelineStatus;
  exit_code: number;
  steps: { crawl: number | null };
  crawl_run: {
    id: string;
    mode: string;
    status: string;
    started_at: string;
    finished_at: string | null;
  } | null;
  counts: RealEstateCounts | null;
  release: string | null;
  host: string;
  emitted_at: string;
}

export type HermesEvent = PipelineFinishedEvent | RealEstateFinishedEvent | TestEvent;

/** Postgres's text timestamp ("2026-10-13 12:47:12.809+00") as ISO-8601 UTC. */
function iso(value: string): string {
  return new Date(value).toISOString();
}

/**
 * What the database recorded for this pipeline run: its crawl run, and the
 * bundle it activated. Reads only; the worker role already reads both tables.
 */
export async function readRunFacts(
  db: Database,
  run: PipelineRun,
  bundleChannel: string,
): Promise<RunFacts> {
  // Looked up whatever the crawl step's code: a run interrupted during its
  // crawl has no code for it yet, and its row is still there, unsettled.
  let crawlRun: RunFacts['crawlRun'] = null;
  const [row] = await db
    .select({
      id: crawlRuns.id,
      status: crawlRuns.status,
      startedAt: crawlRuns.startedAt,
      finishedAt: crawlRuns.finishedAt,
      fullCoverage: crawlRuns.fullCoverage,
      discovered: crawlRuns.discoveredCount,
      new: crawlRuns.newCount,
      changed: crawlRuns.changedCount,
      unchanged: crawlRuns.unchangedCount,
      skipped: crawlRuns.skippedCount,
      missing: crawlRuns.missingCount,
      expired: crawlRuns.expiredCount,
      reopened: crawlRuns.reopenedCount,
      quarantined: crawlRuns.quarantinedCount,
      failed: crawlRuns.failedCount,
    })
    .from(crawlRuns)
    .innerJoin(sources, eq(sources.id, crawlRuns.sourceId))
    .where(and(eq(sources.slug, run.sourceSlug), gte(crawlRuns.startedAt, run.startedAt)))
    .orderBy(desc(crawlRuns.startedAt))
    .limit(1);
  if (row !== undefined) {
    const { id, status, startedAt, finishedAt, fullCoverage, ...counts } = row;
    crawlRun = {
      id,
      status,
      startedAt: iso(startedAt),
      finishedAt: finishedAt === null ? null : iso(finishedAt),
      fullCoverage,
      counts,
    };
  }

  // The builder exits 0 only when it activated a build
  // (src/cli/build-matching-bundle.ts), so the live publication is this run's
  // unless another source's pipeline has published since, and then that newer
  // one is the bundle a reader would get anyway.
  let bundle: RunFacts['bundle'] = null;
  if (run.steps.bundle === 0) {
    const [active] = await db
      .select({
        id: matchingBundleBuilds.id,
        opportunities: matchingBundleBuilds.opportunityCount,
      })
      .from(matchingBundlePublications)
      .innerJoin(
        matchingBundleBuilds,
        eq(matchingBundleBuilds.id, matchingBundlePublications.buildId),
      )
      .where(
        and(
          eq(matchingBundlePublications.channel, bundleChannel),
          isNull(matchingBundlePublications.retiredAt),
          gte(matchingBundlePublications.activatedAt, run.startedAt),
        ),
      )
      .limit(1);
    bundle = active ?? null;
  }
  return { crawlRun, bundle };
}

/**
 * `partial` is the crawl ending partial with nothing else wrong: its CLI
 * exits 1 for that, so the exit code alone cannot tell it from a failure.
 * Once any other step failed too, the run is `failed`.
 */
function pipelineStatus(run: PipelineRun, facts: RunFacts): PipelineStatus {
  if (run.interrupted) return 'interrupted';
  if (run.exitCode === 0) return 'succeeded';
  const othersFailed = PIPELINE_STEPS.some(
    (step) => step !== 'crawl' && run.steps[step] !== null && run.steps[step] !== 0,
  );
  return facts.crawlRun?.status === 'partial' && !othersFailed ? 'partial' : 'failed';
}

export function buildPipelineEvent(
  run: PipelineRun,
  facts: RunFacts,
  context: EventContext,
): PipelineFinishedEvent {
  const emittedAt = context.now.toISOString();
  const crawlRun = facts.crawlRun;
  return {
    event_type: 'xtelo.pipeline.finished',
    schema: HERMES_EVENT_SCHEMA,
    event_id:
      crawlRun === null
        ? `${run.sourceSlug}:nocrawl:${emittedAt}`
        : `${run.sourceSlug}:${crawlRun.id}`,
    domain: 'opportunities',
    source: run.sourceSlug,
    status: pipelineStatus(run, facts),
    exit_code: run.exitCode,
    steps: run.steps,
    crawl_run:
      crawlRun === null
        ? null
        : {
            id: crawlRun.id,
            status: crawlRun.status,
            started_at: crawlRun.startedAt,
            finished_at: crawlRun.finishedAt,
          },
    counts: crawlRun?.counts ?? null,
    full_coverage: crawlRun?.fullCoverage ?? null,
    ...(facts.bundle === null ? {} : { bundle: facts.bundle }),
    release: context.release,
    host: context.host,
    emitted_at: emittedAt,
  };
}

/** What `realestate.crawl_runs` recorded for this run. Reads only. */
export async function readRealEstateRunFacts(
  db: Database,
  run: RealEstateRun,
): Promise<RealEstateRunFacts> {
  const [row] = await db
    .select({
      id: realEstateCrawlRuns.id,
      mode: realEstateCrawlRuns.mode,
      status: realEstateCrawlRuns.status,
      startedAt: realEstateCrawlRuns.startedAt,
      finishedAt: realEstateCrawlRuns.finishedAt,
      pages: realEstateCrawlRuns.pageCount,
      rows: realEstateCrawlRuns.rowCount,
      new: realEstateCrawlRuns.newCount,
      changed: realEstateCrawlRuns.changedCount,
      bumped: realEstateCrawlRuns.bumpedCount,
      unchanged: realEstateCrawlRuns.unchangedCount,
      reopened: realEstateCrawlRuns.reopenedCount,
      gone: realEstateCrawlRuns.goneCount,
      verified: realEstateCrawlRuns.verifiedCount,
    })
    .from(realEstateCrawlRuns)
    .innerJoin(sources, eq(sources.id, realEstateCrawlRuns.sourceId))
    .where(and(eq(sources.slug, run.sourceSlug), gte(realEstateCrawlRuns.startedAt, run.startedAt)))
    .orderBy(desc(realEstateCrawlRuns.startedAt))
    .limit(1);
  if (row === undefined) return { crawlRun: null };
  const { id, mode, status, startedAt, finishedAt, ...counts } = row;
  return {
    crawlRun: {
      id,
      mode,
      status,
      startedAt: iso(startedAt),
      finishedAt: finishedAt === null ? null : iso(finishedAt),
      counts,
    },
  };
}

/** As for a pipeline run: `partial` is the crawl ending partial, which its CLI also exits 1 for. */
export function buildRealEstateEvent(
  run: RealEstateRun,
  facts: RealEstateRunFacts,
  context: EventContext,
): RealEstateFinishedEvent {
  const emittedAt = context.now.toISOString();
  const crawlRun = facts.crawlRun;
  let status: PipelineStatus = 'failed';
  if (run.interrupted) status = 'interrupted';
  else if (run.exitCode === 0) status = 'succeeded';
  else if (crawlRun?.status === 'partial') status = 'partial';
  return {
    event_type: 'xtelo.pipeline.finished',
    schema: HERMES_EVENT_SCHEMA,
    event_id:
      crawlRun === null
        ? `${run.sourceSlug}:nocrawl:${emittedAt}`
        : `${run.sourceSlug}:${crawlRun.id}`,
    domain: 'realestate',
    source: run.sourceSlug,
    status,
    exit_code: run.exitCode,
    steps: { crawl: run.crawl },
    crawl_run:
      crawlRun === null
        ? null
        : {
            id: crawlRun.id,
            mode: crawlRun.mode,
            status: crawlRun.status,
            started_at: crawlRun.startedAt,
            finished_at: crawlRun.finishedAt,
          },
    counts: crawlRun?.counts ?? null,
    release: context.release,
    host: context.host,
    emitted_at: emittedAt,
  };
}

/** A hand-fired event that proves the path to Hermes without a pipeline run. */
export function buildTestEvent(context: EventContext): TestEvent {
  const emittedAt = context.now.toISOString();
  return {
    event_type: 'xtelo.test',
    schema: HERMES_EVENT_SCHEMA,
    event_id: `test:${emittedAt}`,
    release: context.release,
    host: context.host,
    emitted_at: emittedAt,
  };
}

/**
 * A release lives in `/opt/xtelo/releases/<full sha>` and runs through the
 * `/opt/xtelo/current` link (`docs/RUNBOOK.md` §1), so the directory's real
 * name is the sha. Anywhere else there is no release to name.
 */
export function releaseFromDirectory(directory: string): string | null {
  try {
    const name = path.basename(realpathSync(directory));
    return /^[0-9a-f]{40}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}
