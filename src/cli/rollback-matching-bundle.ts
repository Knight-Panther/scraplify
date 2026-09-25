import { db, pool } from '../db/client.js';
import { artifactDirFromEnv, FilesystemArtifactStore } from '../matching/bundle/artifact-store.js';
import { PUBLIC_MATCHING_CHANNEL } from '../matching/bundle/contract.js';
import { rollbackMatchingBundle } from '../matching/bundle/rollback.js';

/** `npm run matching:rollback` — repoints the public bundle to the previous verified build. */
async function main(): Promise<void> {
  const result = await rollbackMatchingBundle(
    db,
    pool,
    new FilesystemArtifactStore(artifactDirFromEnv()),
    { channel: PUBLIC_MATCHING_CHANNEL, activatedBy: 'cli:matching:rollback' },
  );
  if (result.outcome === 'rolled_back') {
    console.log(`rolled back from ${result.fromBuildId} to ${result.toBuildId}`);
  } else {
    console.error(`rollback refused: ${result.reason}`);
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
