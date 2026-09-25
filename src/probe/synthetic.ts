import { createHash } from 'node:crypto';

/**
 * Synthetic probes for a hosted surface (Phase 8E, change.md §10: "public
 * synthetic probes for landing, Browse, detail, manifest and artifact
 * download"). Each step is one ordinary anonymous GET a visitor's browser
 * would make, so a passing run means a real visitor gets the same.
 *
 * `fetch` is injected so the step logic is unit-testable without a server.
 * No step sends a body, a cookie or a query string built from anything
 * but the site's own responses.
 */

export type ProbeLevel = 'ok' | 'warn' | 'fail';

export interface ProbeResult {
  step: string;
  level: ProbeLevel;
  ms: number;
  detail: string;
}

type Fetch = (url: string) => Promise<Response>;

// Browse links carry a `?back=` query; only the path is followed.
const DETAIL_LINK = /href="(\/opportunities\/[0-9a-f-]{36})[?"]/;
const NONCE_CSP = /script-src 'self' 'nonce-[A-Za-z0-9+/]+=*' 'strict-dynamic'/;

interface ManifestReply {
  matchingAvailable?: boolean;
  unavailableReason?: string;
  manifest?: { url: string; sha256: string };
  files?: Record<string, { url: string; sha256: string }>;
}

async function timed(
  step: string,
  run: () => Promise<{ level: ProbeLevel; detail: string }>,
): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const { level, detail } = await run();
    return { step, level, detail, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      step,
      level: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      ms: Math.round(performance.now() - started),
    };
  }
}

function sha256(bytes: ArrayBuffer): string {
  return createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
}

export async function runProbes(origin: string, fetchImpl: Fetch = fetch): Promise<ProbeResult[]> {
  const url = (path: string) => new URL(path, origin).toString();
  const results: ProbeResult[] = [];

  results.push(
    await timed('readiness', async () => {
      const response = await fetchImpl(url('/api/readyz'));
      const body = (await response.json()) as { status?: string; matching?: string };
      if (response.status !== 200 || body.status !== 'ready') {
        return { level: 'fail', detail: `HTTP ${response.status}, ${JSON.stringify(body)}` };
      }
      return { level: 'ok', detail: `ready, matching ${body.matching}` };
    }),
  );

  results.push(
    await timed('landing', async () => {
      const response = await fetchImpl(url('/'));
      if (response.status !== 200) return { level: 'fail', detail: `HTTP ${response.status}` };
      const csp = response.headers.get('content-security-policy') ?? '';
      if (!NONCE_CSP.test(csp)) return { level: 'fail', detail: 'no nonce CSP on the page' };
      return { level: 'ok', detail: 'HTML with nonce CSP' };
    }),
  );

  let detailPath: string | undefined;
  results.push(
    await timed('browse', async () => {
      const response = await fetchImpl(url('/opportunities'));
      if (response.status !== 200) return { level: 'fail', detail: `HTTP ${response.status}` };
      detailPath = DETAIL_LINK.exec(await response.text())?.[1];
      return detailPath
        ? { level: 'ok', detail: 'listing links present' }
        : { level: 'fail', detail: 'no opportunity link on the Browse page' };
    }),
  );

  results.push(
    await timed('detail', async () => {
      if (!detailPath) return { level: 'fail', detail: 'skipped: Browse gave no detail link' };
      const response = await fetchImpl(url(detailPath));
      return response.status === 200
        ? { level: 'ok', detail: detailPath }
        : { level: 'fail', detail: `HTTP ${response.status} for ${detailPath}` };
    }),
  );

  let manifest: ManifestReply | undefined;
  results.push(
    await timed('manifest', async () => {
      const response = await fetchImpl(url('/api/matching/manifest'));
      if (response.status !== 200) return { level: 'fail', detail: `HTTP ${response.status}` };
      manifest = (await response.json()) as ManifestReply;
      if (manifest.matchingAvailable === false) {
        return { level: 'warn', detail: `matching unavailable: ${manifest.unavailableReason}` };
      }
      return { level: 'ok', detail: 'matching available' };
    }),
  );

  results.push(
    await timed('bundle download', async () => {
      if (!manifest?.manifest || !manifest.files) {
        return { level: 'fail', detail: 'skipped: no manifest to follow' };
      }
      const files = [manifest.manifest, ...Object.values(manifest.files)];
      let bytes = 0;
      for (const file of files) {
        const response = await fetchImpl(url(file.url));
        if (response.status !== 200) {
          return { level: 'fail', detail: `HTTP ${response.status} for ${file.url}` };
        }
        const body = await response.arrayBuffer();
        if (sha256(body) !== file.sha256) {
          return { level: 'fail', detail: `checksum mismatch for ${file.url}` };
        }
        bytes += body.byteLength;
      }
      return { level: 'ok', detail: `${files.length} files, ${bytes} bytes, checksums match` };
    }),
  );

  return results;
}

export function worstLevel(results: readonly ProbeResult[]): ProbeLevel {
  if (results.some((result) => result.level === 'fail')) return 'fail';
  if (results.some((result) => result.level === 'warn')) return 'warn';
  return 'ok';
}
