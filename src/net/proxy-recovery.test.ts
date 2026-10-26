import { describe, expect, it, vi } from 'vitest';
import { type HttpFetcher, type HttpFetchResult, UrlNotAllowedError } from './http-fetcher.js';
import { ProxyUnreachableError, withProxyRecovery } from './proxy-recovery.js';

const MIN = 60_000;

function answer(url: string): HttpFetchResult {
  return { status: 200, headers: {}, body: `page ${url}`, finalUrl: url, redirectCount: 0 };
}

/**
 * The proxy as the crawl sees it: down (every request throws, the probe gets
 * nothing) or up. Time passes only while the run sleeps.
 */
function setup(options: { maxWaitMs?: number; downAt?: Record<string, number> } = {}) {
  let clock = 0;
  let up = true;
  /** An outage of this many ms starts when its URL is first asked for. */
  const outages = new Map(Object.entries(options.downAt ?? {}));
  let upAt = Number.POSITIVE_INFINITY;
  const requested: string[] = [];
  const probes: number[] = [];

  const inner: HttpFetcher = {
    async fetch(url) {
      const outage = outages.get(url);
      if (up && outage !== undefined) {
        outages.delete(url);
        up = false;
        upAt = clock + outage;
      }
      requested.push(url);
      if (!up) throw new TypeError('fetch failed');
      return answer(url);
    },
    close: vi.fn(async () => {}),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const fetcher = withProxyRecovery(inner, {
    label: 'http://127.0.0.1:18888',
    probe: async () => {
      probes.push(clock);
      if (!up && clock >= upAt) up = true;
      return up;
    },
    maxWaitMs: options.maxWaitMs ?? 600 * MIN,
    pollMs: MIN,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log,
  });
  return { fetcher, inner, log, requested, probes, elapsed: () => clock };
}

describe('withProxyRecovery', () => {
  it('passes answers straight through while the proxy works', async () => {
    const { fetcher, requested, probes } = setup();
    await expect(fetcher.fetch('https://home.ss.ge/a')).resolves.toMatchObject({ status: 200 });
    expect(requested).toEqual(['https://home.ss.ge/a']);
    expect(probes).toEqual([]);
  });

  it('waits for a proxy that is down, then asks for the same page again', async () => {
    // The laptop is off when the run starts and comes back 47 minutes later.
    const { fetcher, requested, log, elapsed } = setup({
      downAt: { 'https://home.ss.ge/a': 47 * MIN },
    });

    await expect(fetcher.fetch('https://home.ss.ge/a')).resolves.toMatchObject({
      body: 'page https://home.ss.ge/a',
    });

    expect(requested).toEqual(['https://home.ss.ge/a', 'https://home.ss.ge/a']);
    expect(elapsed()).toBe(47 * MIN);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ proxy: 'http://127.0.0.1:18888' }),
      'proxy unreachable; waiting for it to come back',
    );
    // Once more at 30 minutes, so a long wait is visible in the journal.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ downForMin: 30 }),
      'proxy still unreachable; still waiting',
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ downForMin: 47 }),
      'proxy is back; carrying on',
    );
  });

  it('hands a one-off failure back when the proxy itself still answers', async () => {
    const { fetcher, inner, probes, elapsed } = setup();
    const fetch = vi.spyOn(inner, 'fetch').mockRejectedValueOnce(new Error('socket hang up'));

    await expect(fetcher.fetch('https://home.ss.ge/a')).rejects.toThrow('socket hang up');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(probes).toEqual([0]);
    expect(elapsed()).toBe(0);
  });

  it('never probes for a refusal of our own', async () => {
    const { fetcher, inner, probes } = setup();
    vi.spyOn(inner, 'fetch').mockRejectedValueOnce(new UrlNotAllowedError('https://evil.example/'));

    await expect(fetcher.fetch('https://evil.example/')).rejects.toBeInstanceOf(UrlNotAllowedError);
    expect(probes).toEqual([]);
  });

  it('counts every outage against one budget for the run', async () => {
    const { fetcher, elapsed } = setup({
      maxWaitMs: 90 * MIN,
      downAt: { 'https://home.ss.ge/a': 60 * MIN, 'https://home.ss.ge/b': 60 * MIN },
    });

    await expect(fetcher.fetch('https://home.ss.ge/a')).resolves.toMatchObject({ status: 200 });
    expect(elapsed()).toBe(60 * MIN);
    // The second outage gets what is left of the budget, not a fresh one.
    await expect(fetcher.fetch('https://home.ss.ge/b')).rejects.toBeInstanceOf(
      ProxyUnreachableError,
    );
    expect(elapsed()).toBe(90 * MIN);
  });

  it('gives up with a reason naming the proxy and the wait', async () => {
    const { fetcher, log, requested } = setup({
      maxWaitMs: 120 * MIN,
      downAt: { 'https://home.ss.ge/a': 24 * 60 * MIN },
    });

    const error = await fetcher.fetch('https://home.ss.ge/a').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProxyUnreachableError);
    expect((error as Error).message).toBe(
      'the proxy http://127.0.0.1:18888 stayed unreachable (waited 120 min in this run)',
    );
    expect(requested).toEqual(['https://home.ss.ge/a']);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ waitedMin: 120 }),
      'gave up waiting for the proxy',
    );

    // With the budget spent, a later failure gives up at once.
    await expect(fetcher.fetch('https://home.ss.ge/b')).rejects.toBeInstanceOf(
      ProxyUnreachableError,
    );
  });

  it('closes the fetcher it wraps', async () => {
    const { fetcher, inner } = setup();
    await fetcher.close();
    expect(inner.close).toHaveBeenCalledOnce();
  });
});
