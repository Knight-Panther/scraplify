#!/usr/bin/env node
/**
 * A small load test for a running surface (Phase 8E load evidence).
 *
 *   node scripts/load-test.mjs <origin> [--seconds 30] [--concurrency 20] [--clients 200]
 *
 * It replays the public surface's real read mix (landing, Browse with filters
 * and sorts, Listings, a detail page, the manifest) from `--concurrency`
 * parallel loops for `--seconds`, then prints throughput, latency percentiles
 * and status counts per route.
 *
 * The rate limiter keys on the last X-Forwarded-For entry, which the reverse
 * proxy sets. Hitting the loopback process directly, this script sets it
 * itself, spread over `--clients` addresses, so it measures the server's
 * capacity rather than one client's limit. Point it at a host through the
 * real proxy and the proxy overwrites the header, so there it measures what
 * one client gets. Only run it against a server you operate.
 */

const args = process.argv.slice(2);
const origin = args[0];
if (!origin || !/^https?:\/\//.test(origin)) {
  console.error(
    'usage: node scripts/load-test.mjs <origin> [--seconds 30] [--concurrency 20] [--clients 200]',
  );
  process.exit(2);
}
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(args[index + 1]);
};
const seconds = option('seconds', 30);
const concurrency = option('concurrency', 20);
const clients = option('clients', 200);

async function detailPath() {
  const html = await (await fetch(new URL('/opportunities', origin))).text();
  return /href="(\/opportunities\/[0-9a-f-]{36})[?"]/.exec(html)?.[1];
}

const detail = await detailPath();
const ROUTES = [
  '/',
  '/opportunities',
  '/opportunities?sort=deadline',
  '/opportunities?sort=title',
  '/listings',
  '/api/matching/manifest',
  ...(detail ? [detail] : []),
];

const stats = new Map(ROUTES.map((route) => [route, { latencies: [], statuses: {} }]));
let sent = 0;
const deadline = Date.now() + seconds * 1000;

async function loop(worker) {
  while (Date.now() < deadline) {
    const route = ROUTES[sent % ROUTES.length];
    const client = `10.${(sent % clients) >> 8}.${sent % 256}.${worker}`;
    sent++;
    const started = performance.now();
    let status;
    try {
      const response = await fetch(new URL(route, origin), {
        headers: { 'x-forwarded-for': client },
      });
      await response.arrayBuffer();
      status = String(response.status);
    } catch {
      status = 'error';
    }
    const entry = stats.get(route);
    entry.latencies.push(performance.now() - started);
    entry.statuses[status] = (entry.statuses[status] ?? 0) + 1;
  }
}

const percentile = (sorted, p) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

await Promise.all(Array.from({ length: concurrency }, (_, worker) => loop(worker)));

console.log(
  `${origin}: ${seconds}s, concurrency ${concurrency}, ${sent} requests, ${(sent / seconds).toFixed(1)} req/s`,
);
console.log(
  'route'.padEnd(34),
  'n'.padStart(6),
  'p50'.padStart(7),
  'p95'.padStart(7),
  'p99'.padStart(7),
  '  statuses',
);
let failures = 0;
for (const [route, { latencies, statuses }] of stats) {
  const sorted = latencies.sort((a, b) => a - b);
  const ms = (value) => `${Math.round(value)}ms`.padStart(7);
  console.log(
    route.slice(0, 34).padEnd(34),
    String(sorted.length).padStart(6),
    ms(percentile(sorted, 0.5)),
    ms(percentile(sorted, 0.95)),
    ms(percentile(sorted, 0.99)),
    ' ',
    JSON.stringify(statuses),
  );
  for (const [status, count] of Object.entries(statuses)) if (status !== '200') failures += count;
}
console.log(
  failures === 0 ? 'load test: every response was 200' : `load test: ${failures} non-200 responses`,
);
process.exitCode = failures === 0 ? 0 : 1;
