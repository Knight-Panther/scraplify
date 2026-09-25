import {
  MAX_BUNDLE_AGE_HOURS,
  SUPPORTED_MATCHING_BUNDLE_SCHEMAS,
} from '../../../../../src/matching/bundle/contract.js';
import { loadActiveBundle, refusalResponse } from '../../../../lib/matching-delivery.js';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/matching/manifest` — the active public matching bundle
 * (change.md §8). Never cached: it is the pointer a client re-reads to find
 * out which immutable version to download. The client uses only the file
 * URLs listed here, so it can never combine two bundle versions.
 *
 * Past `MAX_BUNDLE_AGE_HOURS` the pointer is still returned (so the site can
 * say when the data was built) but `matchingAvailable` is false: stale
 * matches are refused rather than served as current.
 */
export async function GET(): Promise<Response> {
  const loaded = await loadActiveBundle();
  if ('status' in loaded) return refusalResponse(loaded);
  const { active } = loaded;

  const ageHours = (Date.now() - Date.parse(active.manifest.generatedAt)) / 3_600_000;
  const stale = ageHours > MAX_BUNDLE_AGE_HOURS;
  const fileUrl = (name: string) => `/api/matching/bundles/${active.buildId}/${name}`;

  return Response.json(
    {
      bundleId: active.buildId,
      schemaVersion: active.schemaVersion,
      featureContract: active.featureContract,
      activatedAt: active.activatedAt,
      supportedSchemas: SUPPORTED_MATCHING_BUNDLE_SCHEMAS,
      matchingAvailable: !stale,
      ...(stale ? { unavailableReason: 'stale', maxAgeHours: MAX_BUNDLE_AGE_HOURS } : {}),
      manifest: { url: fileUrl('manifest.json'), sha256: active.manifestSha256 },
      files: Object.fromEntries(
        Object.entries(active.manifest.files).map(([name, meta]) => [
          name,
          { ...meta, url: fileUrl(name) },
        ]),
      ),
      generatedAt: active.manifest.generatedAt,
      corpusWatermark: active.manifest.corpusWatermark,
      sourceFreshness: active.manifest.sourceFreshness,
      counts: active.manifest.counts,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
