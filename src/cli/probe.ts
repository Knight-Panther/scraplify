import { runProbes, worstLevel } from '../probe/synthetic.js';

/**
 * `npm run probe -- <origin>` — the Phase 8E synthetic probe against a
 * running surface, for example `npm run probe -- https://xtelo.example`.
 * Prints one line per step and exits 1 on any failure, so a scheduler, an
 * uptime service or a deploy script can gate on it. A stale matching bundle
 * is a warning, not a failure: Browse still serves (change.md §15).
 */
async function main(): Promise<void> {
  const origin = process.argv[2];
  if (!origin || !/^https?:\/\//.test(origin)) {
    console.error('Usage: npm run probe -- <origin>   (for example http://127.0.0.1:3000)');
    process.exitCode = 2;
    return;
  }
  const results = await runProbes(origin);
  for (const result of results) {
    console.log(
      `${result.level.padEnd(4)}  ${result.step.padEnd(16)} ${String(result.ms).padStart(6)} ms  ${result.detail}`,
    );
  }
  const worst = worstLevel(results);
  console.log(`probe: ${worst}`);
  if (worst === 'fail') process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
