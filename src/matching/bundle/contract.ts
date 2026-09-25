import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  isSupportedSchema,
  MANIFEST_FILE,
  type MatchingManifest,
  manifestSchema,
  OPPORTUNITIES_FILE,
  type OpportunitiesFile,
  opportunitiesFileSchema,
} from './schema.js';

/**
 * The matching-bundle artifact contract (Phase 8C, change.md §8). The
 * constants and zod schemas live in `schema.ts`, which is browser-safe and
 * shared with the Phase 8D worker; this file adds the Node-only checksum and
 * whole-set validation the builder and the delivery routes use.
 */
export * from './schema.js';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export class BundleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleValidationError';
  }
}

/**
 * Checks a complete artifact set against its own manifest: shape, schema
 * support, the id tying every file together, every file's checksum and
 * size, and that the counts are what the rows actually contain. Anything
 * short of all of that is a bundle nobody should activate or serve.
 */
export function validateArtifactSet(
  bundleId: string,
  files: ReadonlyMap<string, Uint8Array>,
): { manifest: MatchingManifest; opportunities: OpportunitiesFile } {
  const manifestBytes = files.get(MANIFEST_FILE);
  if (manifestBytes === undefined) throw new BundleValidationError('manifest.json missing');
  const manifest = parseJson(manifestSchema, manifestBytes, MANIFEST_FILE);
  if (manifest.bundleId !== bundleId) throw new BundleValidationError('manifest bundleId mismatch');
  if (!isSupportedSchema(manifest.schemaVersion)) {
    throw new BundleValidationError(`unsupported schema ${manifest.schemaVersion}`);
  }

  const listed = Object.keys(manifest.files).sort();
  if (listed.join(',') !== [OPPORTUNITIES_FILE].join(',')) {
    throw new BundleValidationError(`unexpected file list: ${listed.join(',')}`);
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = files.get(name);
    if (bytes === undefined) throw new BundleValidationError(`${name} missing`);
    if (bytes.byteLength !== expected.bytes)
      throw new BundleValidationError(`${name} size mismatch`);
    if (sha256Hex(bytes) !== expected.sha256) {
      throw new BundleValidationError(`${name} checksum mismatch`);
    }
  }

  const opportunities = parseJson(
    opportunitiesFileSchema,
    files.get(OPPORTUNITIES_FILE) as Uint8Array,
    OPPORTUNITIES_FILE,
  );
  if (
    opportunities.bundleId !== bundleId ||
    opportunities.schemaVersion !== manifest.schemaVersion
  ) {
    throw new BundleValidationError('opportunities.json does not belong to this manifest');
  }
  if (opportunities.opportunities.length !== manifest.counts.opportunities) {
    throw new BundleValidationError('opportunity count mismatch');
  }
  const ids = new Set(opportunities.opportunities.map((row) => row.opportunityId));
  if (ids.size !== opportunities.opportunities.length) {
    throw new BundleValidationError('duplicate opportunity id');
  }
  const sourceCount = opportunities.opportunities.reduce((sum, row) => sum + row.sources.length, 0);
  if (sourceCount !== manifest.counts.sources) {
    throw new BundleValidationError('source count mismatch');
  }
  return { manifest, opportunities };
}

function parseJson<T>(schema: z.ZodType<T>, bytes: Uint8Array, name: string): T {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new BundleValidationError(`${name} is not valid UTF-8 JSON`);
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new BundleValidationError(`${name} failed schema validation`);
  return result.data;
}
