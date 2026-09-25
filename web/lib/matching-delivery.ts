import { db } from '../../src/db/client.js';
import { publicActiveMatchingBundle } from '../../src/db/schema/index.js';
import {
  artifactDirFromEnv,
  FilesystemArtifactStore,
  type MatchingArtifactStore,
} from '../../src/matching/bundle/artifact-store.js';
import {
  isSupportedSchema,
  MANIFEST_FILE,
  type MatchingManifest,
  manifestSchema,
  sha256Hex,
} from '../../src/matching/bundle/contract.js';
import { currentSurface } from './surface.js';

/**
 * Server side of matching-bundle delivery (Phase 8C, change.md §8): the
 * manifest endpoint and the immutable file endpoint share this.
 *
 * - Surfaces: `public` and `local` only. `admin` has no CV route
 *   (change.md §14), and `proxy.ts` already 404s it there; this refuses too,
 *   since a route handler authorizes on its own.
 * - The active pointer is read through `public_active_matching_bundle`, the
 *   one matching object the public database role can see.
 * - Fails closed: a `public` process with no `XTELO_MATCHING_ARTIFACT_DIR`
 *   refuses rather than guessing a directory, and a file whose bytes don't
 *   match the checksum the database recorded is never served.
 */

export type DeliveryRefusal =
  | { status: 404; error: 'not_found' | 'no_active_bundle' }
  | { status: 503; error: 'not_configured' | 'artifact_mismatch' | 'incompatible_bundle' };

export interface ActiveBundle {
  buildId: string;
  schemaVersion: number;
  featureContract: string;
  manifestSha256: string;
  activatedAt: string;
  manifest: MatchingManifest;
  manifestBytes: Uint8Array;
}

function storeForSurface(): MatchingArtifactStore | DeliveryRefusal {
  const surface = currentSurface();
  if (surface === 'admin') return { status: 404, error: 'not_found' };
  if (surface === 'public' && !process.env.XTELO_MATCHING_ARTIFACT_DIR) {
    return { status: 503, error: 'not_configured' };
  }
  return new FilesystemArtifactStore(artifactDirFromEnv());
}

export async function loadActiveBundle(): Promise<
  { store: MatchingArtifactStore; active: ActiveBundle } | DeliveryRefusal
> {
  const store = storeForSurface();
  if ('status' in store) return store;

  const [pointer] = await db.select().from(publicActiveMatchingBundle).limit(1);
  if (pointer === undefined) return { status: 404, error: 'no_active_bundle' };
  if (!isSupportedSchema(pointer.schemaVersion)) {
    return { status: 503, error: 'incompatible_bundle' };
  }

  const manifestBytes = await store.readFile(pointer.buildId, MANIFEST_FILE);
  if (manifestBytes === null || sha256Hex(manifestBytes) !== pointer.manifestSha256) {
    return { status: 503, error: 'artifact_mismatch' };
  }
  const parsed = manifestSchema.safeParse(JSON.parse(new TextDecoder().decode(manifestBytes)));
  if (!parsed.success || parsed.data.bundleId !== pointer.buildId) {
    return { status: 503, error: 'artifact_mismatch' };
  }
  return {
    store,
    active: {
      ...pointer,
      // A view column comes back in Postgres's own text format
      // ("2026-09-25 17:04:08.067+00"), not the ISO-8601 every other API
      // timestamp here uses.
      activatedAt: new Date(pointer.activatedAt).toISOString(),
      manifest: parsed.data,
      manifestBytes,
    },
  };
}

export function refusalResponse(refusal: DeliveryRefusal): Response {
  return Response.json(
    { error: refusal.error },
    { status: refusal.status, headers: { 'Cache-Control': 'no-store' } },
  );
}
