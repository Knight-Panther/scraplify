import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '../../../../../../../src/matching/bundle/contract.js';
import { STATIC_E1_PIN } from '../../../../../../../src/matching/models/static-e1.js';
import { refusalResponse } from '../../../../../../lib/matching-delivery.js';
import { currentSurface } from '../../../../../../lib/surface.js';

export const dynamic = 'force-dynamic';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  'model.json': 'application/json; charset=utf-8',
  'table.int8': 'application/octet-stream',
};

/** Verified bytes, kept once read: the files never change under one pin. */
const verified = new Map<string, Promise<Uint8Array | null>>();

async function readVerified(file: keyof typeof STATIC_E1_PIN.files): Promise<Uint8Array | null> {
  const expected = STATIC_E1_PIN.files[file];
  // The repo root, as for `.matching-artifacts/`: every launcher runs there.
  const bytes = await readFile(path.resolve('matching-models', STATIC_E1_PIN.id, file)).catch(
    () => null,
  );
  if (bytes === null) return null;
  return bytes.byteLength === expected.bytes && sha256Hex(bytes) === expected.sha256
    ? new Uint8Array(bytes)
    : null;
}

/**
 * `GET /api/matching/models/<modelId>/<file>` — the pinned browser matching
 * model (`src/matching/models/static-e1.ts`). Fixed and corpus-independent,
 * so it is served apart from the per-crawl bundle and cached for a year:
 * a new model gets a new id, so a URL never changes content.
 *
 * Same surfaces as the bundle (public and local; admin has no CV route),
 * and the same rule: bytes that do not match the pin are never served.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ modelId: string; file: string }> },
): Promise<Response> {
  if (currentSurface() === 'admin') return refusalResponse({ status: 404, error: 'not_found' });
  const { modelId, file } = await params;
  if (modelId !== STATIC_E1_PIN.id || !Object.hasOwn(STATIC_E1_PIN.files, file)) {
    return refusalResponse({ status: 404, error: 'not_found' });
  }
  const name = file as keyof typeof STATIC_E1_PIN.files;
  let pending = verified.get(name);
  if (pending === undefined) {
    pending = readVerified(name);
    verified.set(name, pending);
  }
  const bytes = await pending;
  if (bytes === null) {
    // Not cached: a fixed file can be put right without a restart.
    verified.delete(name);
    return refusalResponse({ status: 503, error: 'artifact_mismatch' });
  }
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': CONTENT_TYPES[name] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${STATIC_E1_PIN.files[name].sha256}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
