import { db, pool } from '../db/client.js';
import { artifactDirFromEnv, FilesystemArtifactStore } from '../matching/bundle/artifact-store.js';
import { buildMatchingBundle } from '../matching/bundle/build.js';
import { PUBLIC_MATCHING_CHANNEL } from '../matching/bundle/contract.js';

/**
 * `npm run matching:build` — builds, verifies and activates the public
 * matching bundle. Exit code 1 when the build fails; the previous bundle
 * stays active either way.
 *
 * Flags (both recorded, neither silent):
 *   --override-health-gate  build even though a source has a critical health alert
 *   --allow-count-drop      activate even if the corpus shrank below half the active bundle
 */
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const known = new Set(['--override-health-gate', '--allow-count-drop']);
  const unknown = [...args].filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(' ')}`);

  const result = await buildMatchingBundle(
    db,
    pool,
    new FilesystemArtifactStore(artifactDirFromEnv()),
    {
      channel: PUBLIC_MATCHING_CHANNEL,
      activatedBy: 'cli:matching:build',
      overrideHealthGate: args.has('--override-health-gate'),
      allowCountDrop: args.has('--allow-count-drop'),
    },
  );
  if (result.outcome === 'activated') {
    console.log(`activated bundle ${result.buildId} (${result.opportunityCount} opportunities)`);
  } else {
    console.error(`build ${result.buildId} failed: ${result.errorCode}; previous bundle unchanged`);
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
