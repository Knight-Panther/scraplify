import { getSourceHealth } from '../browse/queries.js';
import { assessSourceHealth, hasCriticalAlert } from '../browse/source-health.js';
import { db } from '../db/client.js';

/**
 * `npm run health:check` — prints every source's alerts and exits 1 if any is
 * critical, 0 otherwise (Phase 7A, stage 7-2).
 *
 * The exit code is the point: it is the one alert channel that needs nothing
 * else built (concept §27 leaves the notification channel open). A person can
 * run it, and a scheduled task or any wrapper can fail on it, instead of health
 * only being visible to someone who remembers to open `/health`.
 */
async function main(): Promise<void> {
  const now = new Date().toISOString();
  // getSourceHealth's row order is whatever Postgres returns; sort for stable output.
  const sources = (await getSourceHealth(db)).sort((a, b) =>
    a.sourceSlug.localeCompare(b.sourceSlug),
  );
  const alerts = sources.flatMap((source) => assessSourceHealth(source, now));

  for (const source of sources) {
    const own = alerts.filter((alert) => alert.sourceSlug === source.sourceSlug);
    console.log(own.length === 0 ? `${source.sourceSlug}: ok` : source.sourceSlug);
    for (const alert of own) {
      console.log(`  ${alert.level.padEnd(8)} ${alert.code}  ${alert.message}`);
    }
  }

  if (hasCriticalAlert(alerts)) {
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
