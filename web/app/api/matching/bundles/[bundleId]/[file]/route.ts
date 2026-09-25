import {
  ARTIFACT_FILE_NAMES,
  MANIFEST_FILE,
  sha256Hex,
} from '../../../../../../../src/matching/bundle/contract.js';
import { loadActiveBundle, refusalResponse } from '../../../../../../lib/matching-delivery.js';

export const dynamic = 'force-dynamic';

const FILE_NAMES: ReadonlySet<string> = new Set(ARTIFACT_FILE_NAMES);

/**
 * `GET /api/matching/bundles/<bundleId>/<file>` — one immutable artifact
 * file of the ACTIVE bundle, long-cached (change.md §8: versioned files use
 * immutable caching, the manifest pointer does not).
 *
 * Only the active bundle is served. A client holding an older manifest gets
 * a 404 and re-reads the pointer, rather than being handed a retired or
 * never-activated version. The bytes are re-checked against the checksum the
 * manifest records before they leave the server.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bundleId: string; file: string }> },
): Promise<Response> {
  const { bundleId, file } = await params;
  if (!FILE_NAMES.has(file)) return refusalResponse({ status: 404, error: 'not_found' });

  const loaded = await loadActiveBundle();
  if ('status' in loaded) return refusalResponse(loaded);
  const { store, active } = loaded;
  if (bundleId !== active.buildId) return refusalResponse({ status: 404, error: 'not_found' });

  let bytes: Uint8Array;
  let sha256: string;
  if (file === MANIFEST_FILE) {
    bytes = active.manifestBytes;
    sha256 = active.manifestSha256;
  } else {
    const expected = active.manifest.files[file];
    const stored = await store.readFile(bundleId, file);
    if (expected === undefined || stored === null) {
      return refusalResponse({ status: 404, error: 'not_found' });
    }
    if (stored.byteLength !== expected.bytes || sha256Hex(stored) !== expected.sha256) {
      return refusalResponse({ status: 503, error: 'artifact_mismatch' });
    }
    bytes = stored;
    sha256 = expected.sha256;
  }

  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${sha256}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
