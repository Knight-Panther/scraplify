import { z } from 'zod';
import {
  isSupportedSchema,
  MATCHING_FEATURE_CONTRACT,
  OPPORTUNITIES_FILE,
  type OpportunitiesFile,
  opportunitiesFileSchema,
} from '../../../src/matching/bundle/schema.js';
import { STATIC_E1_PIN } from '../../../src/matching/models/static-e1.js';
import { parseStaticModel, type StaticModel } from '../../../src/matching/semantic/static-embed.js';
import { CvError, LIMITS } from './document-checks.js';
import type { BundleSummary } from './protocol.js';
import { watchdog } from './watchdog.js';

/**
 * The worker's view of Phase 8C delivery: read the active pointer, then the
 * one immutable file it lists, verify it, and refuse anything this client
 * cannot use (change.md §8: "The client never combines different
 * bundle/model versions"; "An incompatible client refuses matching while
 * keeping Browse usable").
 *
 * Every request here — the pointer, the bundle file and the two model
 * files — is a same-origin `GET` with no body, no credentials and no
 * CV-derived value anywhere in it; the Stage 5 network test asserts it.
 */

const MANIFEST_URL = '/api/matching/manifest';

const endpointSchema = z.object({
  bundleId: z.uuid(),
  schemaVersion: z.number().int(),
  featureContract: z.string(),
  matchingAvailable: z.boolean(),
  files: z.record(
    z.string(),
    z.object({
      url: z.string().startsWith('/api/matching/bundles/'),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  generatedAt: z.string(),
  sourceFreshness: z.array(z.object({ sourceSlug: z.string(), lastSeenAt: z.string() })),
  counts: z.object({ opportunities: z.number().int().nonnegative() }),
});

/** Told a download's size, then of each chunk as it arrives, for the page's progress line. */
export interface Meter {
  expect(bytes: number): void;
  add(bytes: number): void;
  /** The download ended early: what arrived is all there will be. */
  settle(): void;
}

const NO_METER: Meter = { expect() {}, add() {}, settle() {} };

/** How often, at most, `meters` reports; completion is always reported. */
const REPORT_MS = 250;

/**
 * One meter for the bundle file and one for the model's two files, summed
 * into a single figure. Sizes are decoded bytes on both sides: the manifest
 * and the model pin list decoded sizes, and a stream reader counts decoded
 * bytes, so they agree even though the wire is compressed. Nothing is
 * reported until both sizes are known, so the figure never runs backwards
 * when the bundle's size arrives with its manifest.
 */
export function meters(report: (received: number, total: number) => void): {
  bundle: Meter;
  model: Meter;
} {
  interface Part {
    expected: number | null;
    received: number;
    settled: boolean;
  }
  const bundle: Part = { expected: null, received: 0, settled: false };
  const model: Part = { expected: null, received: 0, settled: false };
  let last = Number.NEGATIVE_INFINITY;
  const update = (force: boolean) => {
    if (bundle.expected === null || model.expected === null) return;
    const total = bundle.expected + model.expected;
    const received =
      Math.min(bundle.received, bundle.expected) + Math.min(model.received, model.expected);
    const now = performance.now();
    if (!force && received < total && now - last < REPORT_MS) return;
    last = now;
    report(received, total);
  };
  const meter = (part: Part): Meter => ({
    expect(bytes) {
      part.expected = bytes;
      update(true);
    },
    add(bytes) {
      if (part.settled) return;
      part.received += bytes;
      update(false);
    },
    settle() {
      part.settled = true;
      part.expected = part.received;
      update(true);
    },
  });
  return { bundle: meter(bundle), model: meter(model) };
}

async function get(url: string, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      cache: url === MANIFEST_URL ? 'no-store' : 'default',
      referrerPolicy: 'no-referrer',
      signal,
    });
  } catch {
    throw new CvError('network');
  }
}

/**
 * GETs `url` and reads the body as it streams, telling `meter` of each
 * chunk. Only silence ends it early: nothing received for
 * `LIMITS.downloadStallMs`, waiting for the headers included, aborts it as
 * a network failure however long the whole download takes. Returns null
 * for a non-OK status. Reading stops as soon as the body passes
 * `expected`, since a longer body can only fail the caller's size check.
 */
export async function download(
  url: string,
  options: { expected?: number; meter?: Meter; signal?: AbortSignal } = {},
): Promise<Uint8Array<ArrayBuffer> | null> {
  const { expected = Number.POSITIVE_INFINITY, meter = NO_METER, signal } = options;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  const stall = watchdog(LIMITS.downloadStallMs, abort);
  try {
    if (signal?.aborted) throw new CvError('network');
    const response = await get(url, controller.signal);
    if (!response.ok) {
      response.body?.cancel().catch(() => undefined);
      return null;
    }
    stall.reset();
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body?.getReader();
    // A browser errors the body of an aborted fetch; cancelling it here too
    // ends a pending read whatever the body's source does.
    controller.signal.addEventListener('abort', () => reader?.cancel().catch(() => undefined));
    while (reader !== undefined) {
      const { done, value } = await reader.read();
      if (controller.signal.aborted) throw new CvError('network');
      if (done) break;
      stall.reset();
      chunks.push(value);
      received += value.byteLength;
      meter.add(value.byteLength);
      if (received > expected) {
        reader.cancel().catch(() => undefined);
        break;
      }
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    // A stall abort, or a connection that dropped mid-body.
    if (error instanceof CvError) throw error;
    throw new CvError('network');
  } finally {
    stall.stop();
    signal?.removeEventListener('abort', abort);
  }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

export interface LoadedBundle {
  summary: BundleSummary;
  file: OpportunitiesFile;
}

export class BundleRefusal extends CvError {
  constructor(
    code: 'bundle_unavailable' | 'bundle_stale' | 'bundle_incompatible' | 'bundle_integrity',
    readonly summary?: BundleSummary,
  ) {
    super(code);
  }
}

export async function loadBundle(meter: Meter = NO_METER): Promise<LoadedBundle> {
  const pointer = await download(MANIFEST_URL);
  if (pointer === null) throw new BundleRefusal('bundle_unavailable');
  const parsed = endpointSchema.safeParse(parseJson(pointer));
  if (!parsed.success) throw new BundleRefusal('bundle_incompatible');
  const manifest = parsed.data;
  const summary: BundleSummary = {
    bundleId: manifest.bundleId,
    generatedAt: manifest.generatedAt,
    opportunities: manifest.counts.opportunities,
    sourceFreshness: manifest.sourceFreshness,
  };

  if (!isSupportedSchema(manifest.schemaVersion)) {
    throw new BundleRefusal('bundle_incompatible', summary);
  }
  if (manifest.featureContract !== MATCHING_FEATURE_CONTRACT) {
    throw new BundleRefusal('bundle_incompatible', summary);
  }
  // Past the maximum age the server still returns the pointer so the page
  // can say when the data was built; matching itself stops.
  if (!manifest.matchingAvailable) throw new BundleRefusal('bundle_stale', summary);

  const listed = manifest.files[OPPORTUNITIES_FILE];
  if (listed === undefined) throw new BundleRefusal('bundle_incompatible', summary);
  meter.expect(listed.bytes);
  const bytes = await download(listed.url, { expected: listed.bytes, meter });
  if (bytes === null) throw new BundleRefusal('bundle_unavailable', summary);
  if (bytes.byteLength !== listed.bytes || (await sha256Hex(bytes)) !== listed.sha256) {
    throw new BundleRefusal('bundle_integrity', summary);
  }

  // Invalid UTF-8 or JSON parses to null, which the schema refuses.
  const file = opportunitiesFileSchema.safeParse(parseJson(bytes));
  if (
    !file.success ||
    file.data.bundleId !== manifest.bundleId ||
    file.data.schemaVersion !== manifest.schemaVersion ||
    file.data.opportunities.length !== manifest.counts.opportunities
  ) {
    throw new BundleRefusal('bundle_integrity', summary);
  }
  return { summary, file: file.data };
}

/**
 * The pinned title-similarity model (`src/matching/models/static-e1.ts`),
 * fetched alongside the bundle and checked against the pin compiled into
 * this code, so a client never embeds with a model it was not built for.
 * Any failure, a stalled download included, resolves to null: CV Ranked
 * then ranks by words alone and says so, rather than refusing a CV the
 * lexical ranker can still read. The other file's download is abandoned
 * with it, so it stops using the visitor's connection.
 */
export async function loadModel(meter: Meter = NO_METER): Promise<StaticModel | null> {
  const files = ['model.json', 'table.int8'] as const;
  meter.expect(files.reduce((sum, file) => sum + STATIC_E1_PIN.files[file].bytes, 0));
  const group = new AbortController();
  try {
    const [json, table] = await Promise.all(
      files.map(async (file) => {
        const expected = STATIC_E1_PIN.files[file];
        const bytes = await download(`/api/matching/models/${STATIC_E1_PIN.id}/${file}`, {
          expected: expected.bytes,
          meter,
          signal: group.signal,
        });
        if (
          bytes === null ||
          bytes.byteLength !== expected.bytes ||
          (await sha256Hex(bytes)) !== expected.sha256
        ) {
          throw new Error(file);
        }
        return bytes;
      }),
    );
    if (json === undefined || table === undefined) return null;
    return parseStaticModel(parseJson(json), table);
  } catch {
    group.abort();
    meter.settle();
    return null;
  }
}
