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
import { CvError } from './document-checks.js';
import type { BundleSummary } from './protocol.js';

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

async function get(url: string): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      cache: url === MANIFEST_URL ? 'no-store' : 'default',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new CvError('network');
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
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

export async function loadBundle(): Promise<LoadedBundle> {
  const pointer = await get(MANIFEST_URL);
  if (!pointer.ok) throw new BundleRefusal('bundle_unavailable');
  const parsed = endpointSchema.safeParse(await pointer.json().catch(() => null));
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
  const response = await get(listed.url);
  if (!response.ok) throw new BundleRefusal('bundle_unavailable', summary);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== listed.bytes || (await sha256Hex(bytes)) !== listed.sha256) {
    throw new BundleRefusal('bundle_integrity', summary);
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new BundleRefusal('bundle_integrity', summary);
  }
  const file = opportunitiesFileSchema.safeParse(json);
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
 * Any failure resolves to null: CV Ranked then ranks by words alone and
 * says so, rather than refusing a CV the lexical ranker can still read.
 */
export async function loadModel(): Promise<StaticModel | null> {
  try {
    const [json, table] = await Promise.all(
      (['model.json', 'table.int8'] as const).map(async (file) => {
        const expected = STATIC_E1_PIN.files[file];
        const response = await get(`/api/matching/models/${STATIC_E1_PIN.id}/${file}`);
        if (!response.ok) throw new Error(file);
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== expected.bytes || (await sha256Hex(bytes)) !== expected.sha256) {
          throw new Error(file);
        }
        return bytes;
      }),
    );
    if (json === undefined || table === undefined) return null;
    return parseStaticModel(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)),
      new Uint8Array(table),
    );
  } catch {
    return null;
  }
}
