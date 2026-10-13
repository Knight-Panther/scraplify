import { z } from 'zod';
import { etendersGeSource } from '../policies/etenders-ge.js';
import { hrGeSource } from '../policies/hr-ge.js';
import { jobsGeSource } from '../policies/jobs-ge.js';
import { ssGeSource } from '../policies/ss-ge.js';
import { REAL_ESTATE_SOURCES } from '../source-traits.js';
import type { HermesEvent } from './event.js';

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

/** The sources `deploy/run-pipeline.sh` runs. ss.ge joins with Phase 11E. */
export const PIPELINE_SOURCES: readonly string[] = [
  jobsGeSource.slug,
  hrGeSource.slug,
  etendersGeSource.slug,
];

const EVENT_SOURCES: readonly string[] = [...PIPELINE_SOURCES, ssGeSource.slug];

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

const pipelineFinished = z
  .strictObject({
    event_type: z.literal('xtelo.pipeline.finished'),
    ...base,
    domain: z.enum(['opportunities', 'realestate']),
    source: z.string().refine((source) => EVENT_SOURCES.includes(source)),
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
  .refine(
    (event) =>
      event.domain ===
      (REAL_ESTATE_SOURCES.includes(event.source) ? 'realestate' : 'opportunities'),
  )
  // The id is made of the event's own fields, so it cannot carry anything else.
  .refine(
    (event) =>
      event.event_id ===
      (event.crawl_run === null
        ? `${event.source}:nocrawl:${event.emitted_at}`
        : `${event.source}:${event.crawl_run.id}`),
  );

const test = z
  .strictObject({ event_type: z.literal('xtelo.test'), ...base })
  .refine((event) => event.event_id === `test:${event.emitted_at}`);

const hermesEvent = z.union([pipelineFinished, test]);

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
