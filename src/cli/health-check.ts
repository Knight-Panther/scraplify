import { getSourceHealth } from '../browse/queries.js';
import { assessSourceHealth, hasCriticalAlert } from '../browse/source-health.js';
import { db } from '../db/client.js';
import { PUBLIC_MATCHING_CHANNEL } from '../matching/bundle/contract.js';
import { assessMatchingHealth, getMatchingBundleStatus } from '../matching/bundle/status.js';
import { answersThroughProxy, proxyDispatcherFromEnv } from '../net/proxy-dispatcher.js';
import { resolveUserAgent } from '../net/user-agent.js';
import { ssGePolicy, ssGeSource } from '../policies/ss-ge.js';
import { assessRealEstateRuns, getRealEstateRunHealth } from '../realestate/run-health.js';

/**
 * `npm run health:check` — prints every source's alerts and exits 1 if any is
 * critical, 0 otherwise (Phase 7A, stage 7-2).
 *
 * The exit code is the point: it is the one alert channel that needs nothing
 * else built (concept §27 leaves the notification channel open). A person can
 * run it, and a scheduled task or any wrapper can fail on it, instead of health
 * only being visible to someone who remembers to open `/health`.
 *
 * Phase 8C adds the public matching bundle as one more line: a stale active
 * bundle is critical (CV matching is refused past its age limit), anything
 * else is a warning.
 *
 * ss.ge is one more line (src/realestate/run-health.ts): a warning after 36
 * hours without a completed run, critical after four days.
 *
 * With SS_GE_PROXY_URL set, the Georgian exit ss.ge's requests leave through
 * is one more line (RUNBOOK §3 step 9). Unreachable is a warning: the
 * nightly run waits hours for it, and the laptop being off for a while is
 * expected.
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

  const matchingAlerts = assessMatchingHealth(
    await getMatchingBundleStatus(db, PUBLIC_MATCHING_CHANNEL),
    now,
  );
  console.log(matchingAlerts.length === 0 ? 'matching bundle: ok' : 'matching bundle');
  for (const alert of matchingAlerts) {
    console.log(`  ${alert.level.padEnd(8)} ${alert.code}  ${alert.message}`);
  }

  const realEstateAlerts = assessRealEstateRuns(
    await getRealEstateRunHealth(db, ssGeSource.id),
    now,
  );
  console.log(realEstateAlerts.length === 0 ? `${ssGeSource.slug}: ok` : ssGeSource.slug);
  for (const alert of realEstateAlerts) {
    console.log(`  ${alert.level.padEnd(8)} ${alert.code}  ${alert.message}`);
  }

  await reportSsGeProxy();

  if (
    hasCriticalAlert(alerts) ||
    matchingAlerts.some((alert) => alert.level === 'critical') ||
    realEstateAlerts.some((alert) => alert.level === 'critical')
  ) {
    process.exitCode = 1;
  }
}

async function reportSsGeProxy(): Promise<void> {
  const proxy = proxyDispatcherFromEnv('SS_GE_PROXY_URL');
  if (proxy === null) return;
  try {
    const answers = await answersThroughProxy(
      proxy.dispatcher,
      ssGePolicy.robotsUrl,
      resolveUserAgent(),
    );
    if (answers) {
      console.log('ss.ge proxy: ok');
    } else {
      console.log('ss.ge proxy');
      console.log(
        `  ${'warning'.padEnd(8)} proxy_unreachable  ss.ge got no answer through ${proxy.label}: the laptop, its internet or the tunnel is down. The nightly run waits for it.`,
      );
    }
  } finally {
    await proxy.dispatcher.close();
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
