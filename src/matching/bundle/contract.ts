import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  parseTitleVectors,
  type TitleVectorsMeta,
  titleVectorsMetaSchema,
} from '../semantic/title-vectors.js';
import {
  isSupportedSchema,
  MANIFEST_FILE,
  type MatchingManifest,
  manifestSchema,
  OPPORTUNITIES_FILE,
  type OpportunitiesFile,
  opportunitiesFileSchema,
  SCHEMA_LAYOUT,
  TITLE_VECTORS_META_FILE,
  TITLE_VECTORS_TABLE_FILE,
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
 * size, and that the counts are what the rows actually contain. For schema
 * 2, the title vectors too: the model the manifest names, every length and
 * index, and finite scales. Anything short of all of that is a bundle
 * nobody should activate or serve.
 */
export function validateArtifactSet(
  bundleId: string,
  files: ReadonlyMap<string, Uint8Array>,
): {
  manifest: MatchingManifest;
  opportunities: OpportunitiesFile;
  titleVectors: TitleVectorsMeta | null;
} {
  const manifestBytes = files.get(MANIFEST_FILE);
  if (manifestBytes === undefined) throw new BundleValidationError('manifest.json missing');
  const manifest = parseJson(manifestSchema, manifestBytes, MANIFEST_FILE);
  if (manifest.bundleId !== bundleId) throw new BundleValidationError('manifest bundleId mismatch');
  const layout = SCHEMA_LAYOUT[manifest.schemaVersion];
  if (!isSupportedSchema(manifest.schemaVersion) || layout === undefined) {
    throw new BundleValidationError(`unsupported schema ${manifest.schemaVersion}`);
  }
  if (manifest.featureContract !== layout.featureContract) {
    throw new BundleValidationError(`unexpected feature contract ${manifest.featureContract}`);
  }
  if ((manifest.model === null) !== (manifest.schemaVersion === 1)) {
    throw new BundleValidationError('model does not fit the schema');
  }

  const listed = Object.keys(manifest.files).sort();
  if (listed.join(',') !== layout.files.join(',')) {
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

  let titleVectors: TitleVectorsMeta | null = null;
  if (manifest.model !== null) {
    const meta = parseJson(
      titleVectorsMetaSchema,
      files.get(TITLE_VECTORS_META_FILE) as Uint8Array,
      TITLE_VECTORS_META_FILE,
    );
    if (meta.bundleId !== bundleId || meta.schemaVersion !== manifest.schemaVersion) {
      throw new BundleValidationError('title-vectors.json does not belong to this manifest');
    }
    if (meta.model !== manifest.model.id || meta.dims !== manifest.model.dims) {
      throw new BundleValidationError('title vectors come from another model');
    }
    const table = files.get(TITLE_VECTORS_TABLE_FILE) as Uint8Array;
    try {
      parseTitleVectors(
        meta,
        new Int8Array(table.buffer, table.byteOffset, table.byteLength),
        opportunities.opportunities.length,
      );
    } catch (err) {
      throw new BundleValidationError(
        `title vectors invalid: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
    titleVectors = meta;
  }
  return { manifest, opportunities, titleVectors };
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
