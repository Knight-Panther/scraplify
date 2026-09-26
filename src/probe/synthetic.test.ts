import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runProbes, worstLevel } from './synthetic.js';

const ID = '11111111-2222-3333-4444-555555555555';
const BUNDLE = new TextEncoder().encode('{"opportunities":[]}');
const MANIFEST = new TextEncoder().encode('{"bundleId":"b"}');
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const CSP = "default-src 'self'; script-src 'self' 'nonce-QUJD' 'strict-dynamic'";

type Routes = Record<string, () => Response>;

function site(overrides: Routes = {}): (url: string) => Promise<Response> {
  const routes: Routes = {
    '/api/readyz': () => Response.json({ status: 'ready', matching: 'ok' }),
    '/': () => new Response('<html></html>', { headers: { 'content-security-policy': CSP } }),
    '/opportunities': () =>
      new Response(`<a href="/opportunities/${ID}?back=%2Fopportunities">x</a>`),
    [`/opportunities/${ID}`]: () => new Response('<html></html>'),
    '/api/matching/manifest': () =>
      Response.json({
        matchingAvailable: true,
        manifest: { url: '/b/manifest.json', sha256: hex(MANIFEST) },
        files: { 'opportunities.json': { url: '/b/opportunities.json', sha256: hex(BUNDLE) } },
      }),
    '/b/manifest.json': () => new Response(MANIFEST),
    '/b/opportunities.json': () => new Response(BUNDLE),
    ...overrides,
  };
  return async (url) => {
    const route = routes[new URL(url).pathname];
    return route ? route() : new Response(null, { status: 404 });
  };
}

const levels = async (fetchImpl: (url: string) => Promise<Response>) =>
  Object.fromEntries(
    (await runProbes('https://x.test', fetchImpl)).map((result) => [result.step, result.level]),
  );

describe('runProbes', () => {
  it('passes every step against a healthy site', async () => {
    const results = await runProbes('https://x.test', site());
    expect(results.map((result) => result.level)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(worstLevel(results)).toBe('ok');
  });

  it('fails the landing step without a nonce CSP', async () => {
    const result = await levels(site({ '/': () => new Response('<html></html>') }));
    expect(result.landing).toBe('fail');
  });

  it('fails readiness on a 503', async () => {
    const result = await levels(
      site({ '/api/readyz': () => Response.json({ status: 'not_ready' }, { status: 503 }) }),
    );
    expect(result.readiness).toBe('fail');
  });

  it('fails detail when Browse lists nothing to follow', async () => {
    const result = await levels(site({ '/opportunities': () => new Response('<p>none</p>') }));
    expect(result.browse).toBe('fail');
    expect(result.detail).toBe('fail');
  });

  it('warns, not fails, on a stale bundle', async () => {
    const results = await runProbes(
      'https://x.test',
      site({
        '/api/matching/manifest': () =>
          Response.json({ matchingAvailable: false, unavailableReason: 'stale' }),
      }),
    );
    expect(results.find((result) => result.step === 'manifest')?.level).toBe('warn');
    expect(results.find((result) => result.step === 'bundle download')?.level).toBe('fail');
  });

  it('fails the download on a checksum mismatch', async () => {
    const result = await levels(site({ '/b/opportunities.json': () => new Response('tampered') }));
    expect(result['bundle download']).toBe('fail');
  });

  it('reports a thrown fetch as a failed step, not a crash', async () => {
    const result = await levels(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(Object.values(result).every((level) => level === 'fail')).toBe(true);
  });
});
