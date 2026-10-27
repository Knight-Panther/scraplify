import { z } from 'zod';
import { etendersGeSource } from '../policies/etenders-ge.js';
import { hrGeSource } from '../policies/hr-ge.js';
import { jobsGeSource } from '../policies/jobs-ge.js';
import { ssGeSource } from '../policies/ss-ge.js';
import { type HermesEvent, REAL_ESTATE_STOP_REASONS } from './event.js';

/**
 * The exact shape of an event, checked by the sender before it signs anything.
 *
 * The outbox is written by the crawl pipeline, which reads pages from the
 * open web, and whatever the sender signs Hermes treats as coming from this
 * host. So the sender signs nothing but an event of exactly this shape: known
 * keys only, and every value an id, a code, a bounded count, a time in one
 * fixed form, this host's own name, or one of a fixed set of words. There is
 * no field that could carry a sentence, which is what
 * keeps a listing's text (or anything a compromised crawl might write into the
 * outbox) from reaching Hermes under this host's signature.
 *
 * A new source, counter or event type has to be added here in the same
 * change, or its events are refused and moved to the dead directory.
 */

/**
 * The sources `deploy/run-pipeline.sh` runs.
 *
 * A new source goes here in the change that adds it to that script: without
 * it the crawl runs as before and Hermes is told nothing about it.
 * `schema.test.ts` fails when the two lists differ.
 */
export const PIPELINE_SOURCES: readonly string[] = [
  jobsGeSource.slug,
  hrGeSource.slug,
  etendersGeSource.slug,
];

/**
 * The sources `deploy/run-realestate.sh` runs (Phase 11E), under the same
 * rule: a new one goes here in the change that adds it to that script, and
 * `schema.test.ts` fails when the two lists differ.
 */
export const REAL_ESTATE_PIPELINE_SOURCES: readonly string[] = [ssGeSource.slug];

/** A time exactly as `toISOString` writes it: one form, a fixed length. */
const time = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => !Number.isNaN(Date.parse(value)));
const exitCode = z.number().int().min(0).max(255);
/** No board has a billion listings; a bound keeps a count a short number. */
const count = z.number().int().min(0).max(1_000_000_000);
const base = {
  schema: z.literal(1),
  event_id: z.string(),
  release: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  // Not a pattern: a hostname's letters, dots and hyphens are enough to spell
  // a sentence. `parseHermesEvent` takes the one name it may be instead.
  host: z.string(),
  emitted_at: time,
};

/** The id a finished run's event must have: its source and its crawl run, or when there was none. */
function madeOfItself(event: {
  event_id: string;
  source: string;
  emitted_at: string;
  crawl_run: { id: string } | null;
}): boolean {
  return (
    event.event_id ===
    (event.crawl_run === null
      ? `${event.source}:nocrawl:${event.emitted_at}`
      : `${event.source}:${event.crawl_run.id}`)
  );
}

const pipelineFinished = z
  .strictObject({
    event_type: z.literal('xtelo.pipeline.finished'),
    ...base,
    domain: z.literal('opportunities'),
    source: z.string().refine((source) => PIPELINE_SOURCES.includes(source)),
    status: z.enum(['succeeded', 'failed', 'partial', 'interrupted']),
    exit_code: exitCode,
    steps: z.strictObject({
      crawl: exitCode.nullable(),
      dedupe: exitCode.nullable(),
      taxonomy: exitCode.nullable(),
      bundle: exitCode.nullable(),
      retention: exitCode.nullable(),
    }),
    crawl_run: z
      .strictObject({
        id: z.uuid(),
        status: z.enum(['running', 'completed', 'failed', 'partial', 'quarantined']),
        started_at: time,
        finished_at: time.nullable(),
      })
      .nullable(),
    counts: z
      .strictObject({
        discovered: count,
        new: count,
        changed: count,
        unchanged: count,
        skipped: count,
        missing: count,
        expired: count,
        reopened: count,
        quarantined: count,
        failed: count,
      })
      .nullable(),
    full_coverage: z.boolean().nullable(),
    bundle: z.strictObject({ id: z.uuid(), opportunities: count.nullable() }).optional(),
  })
  // The id is made of the event's own fields, so it cannot carry anything else.
  .refine(madeOfItself);

/** A real-estate run: its one step, its run's mode, and `realestate.crawl_runs`' counters. */
const realEstateFinished = z
  .strictObject({
    event_type: z.literal('xtelo.pipeline.finished'),
    ...base,
    domain: z.literal('realestate'),
    source: z.string().refine((source) => REAL_ESTATE_PIPELINE_SOURCES.includes(source)),
    status: z.enum(['succeeded', 'failed', 'partial', 'interrupted']),
    exit_code: exitCode,
    steps: z.strictObject({ crawl: exitCode.nullable() }),
    crawl_run: z
      .strictObject({
        id: z.uuid(),
        mode: z.enum(['sweep', 'nightly']),
        status: z.enum(['running', 'completed', 'failed', 'partial']),
        started_at: time,
        finished_at: time.nullable(),
      })
      .nullable(),
    counts: z
      .strictObject({
        pages: count,
        rows: count,
        new: count,
        changed: count,
        bumped: count,
        unchanged: count,
        reopened: count,
        gone: count,
        verified: count,
      })
      .nullable(),
    reason: z.enum(REAL_ESTATE_STOP_REASONS).nullable(),
    http_status: z.number().int().min(100).max(599).nullable(),
  })
  .refine(madeOfItself);

/**
 * The sources whose requests leave through a proxy that `proxy-watch` checks.
 * ss.ge only, through the owner's laptop (`SS_GE_PROXY_URL`).
 */
export const PROXIED_SOURCES: readonly string[] = [ssGeSource.slug];

/** The proxy went down or came back: a state, two times, a flag and a count. */
const proxyChanged = z
  .strictObject({
    event_type: z.literal('xtelo.proxy.changed'),
    ...base,
    source: z.string().refine((source) => PROXIED_SOURCES.includes(source)),
    state: z.enum(['down', 'up']),
    since: time,
    tunnel: z.boolean(),
    down_minutes: count.nullable(),
  })
  .refine((event) => event.event_id === `${event.source}:proxy:${event.state}:${event.since}`);

const test = z
  .strictObject({ event_type: z.literal('xtelo.test'), ...base })
  .refine((event) => event.event_id === `test:${event.emitted_at}`);

const hermesEvent = z.union([pipelineFinished, realEstateFinished, proxyChanged, test]);

/**
 * The value as an event, or `null` when it is not exactly one. `host` is this
 * machine's own name: the pipeline that writes an event and the sender that
 * checks it run on the same host, so an event naming any other is not ours.
 */
export function parseHermesEvent(value: unknown, host: string): HermesEvent | null {
  const parsed = hermesEvent.safeParse(value);
  if (!parsed.success || parsed.data.host !== host) return null;
  return parsed.data as HermesEvent;
}
