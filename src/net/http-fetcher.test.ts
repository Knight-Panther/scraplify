import { brotliCompressSync, gzipSync, zstdCompressSync } from 'node:zlib';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backOffSpacingMs,
  createHttpFetcher,
  ResponseTooLargeError,
  TooManyRedirectsError,
  UrlNotAllowedError,
} from './http-fetcher.js';
import { createRateLimiter, type RateLimiter } from './rate-limiter.js';
import { SsrfBlockedError } from './ssrf-lookup.js';

const ORIGIN = 'https://example.test';
const USER_AGENT = 'scraplify-test/1.0';

let mockAgent: MockAgent;
let rateLimiter: RateLimiter;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  rateLimiter = createRateLimiter({ crawlDelaySeconds: null, maxConcurrency: 1 });
});

afterEach(async () => {
  await mockAgent.close();
});

function allowAll(): boolean {
  return true;
}

describe('createHttpFetcher', () => {
  it.each([
    ['gzip', gzipSync],
    ['br', brotliCompressSync],
    ['zstd', zstdCompressSync],
  ] as const)('decodes %s content before handing it to a parser', async (encoding, compress) => {
    const xml = '<urlset><url><loc>https://www.hr.ge/announcement/1/ვაკანსია</loc></url></urlset>';
    mockAgent
      .get(ORIGIN)
      .intercept({ path: '/sitemap' })
      .reply(200, compress(Buffer.from(xml)), { headers: { 'content-encoding': encoding } });
    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
    });
    expect((await fetcher.fetch(`${ORIGIN}/sitemap`)).body).toBe(xml);
  });

  it('bounds expanded content as well as compressed bytes', async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: '/bomb' })
      .reply(200, gzipSync(Buffer.from('x'.repeat(100_000))), {
        headers: { 'content-encoding': 'gzip' },
      });
    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
      maxResponseBytes: 1000,
    });
    await expect(fetcher.fetch(`${ORIGIN}/bomb`)).rejects.toThrow(ResponseTooLargeError);
  });

  it('rejects corrupt compressed data instead of parsing garbled text', async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: '/corrupt' })
      .reply(200, 'not compressed', { headers: { 'content-encoding': 'zstd' } });
    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
    });
    await expect(fetcher.fetch(`${ORIGIN}/corrupt`)).rejects.toBeTruthy();
  });
  it('fetches an allowed URL and returns its status, body, and final URL', async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: '/ge/ads/', method: 'GET' })
      .reply(200, '<html>ok</html>');

    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
    });

    const result = await fetcher.fetch(`${ORIGIN}/ge/ads/`);

    expect(result).toMatchObject({
      status: 200,
      body: '<html>ok</html>',
      finalUrl: `${ORIGIN}/ge/ads/`,
      redirectCount: 0,
    });
  });

  it('sends the configured User-Agent header', async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: '/ge/ads/', method: 'GET', headers: { 'user-agent': USER_AGENT } })
      .reply(200, 'ok');

    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
    });

    // MockAgent throws "no matching interceptor" if the header doesn't
    // match, so a successful fetch here is itself proof the UA was sent.
    await expect(fetcher.fetch(`${ORIGIN}/ge/ads/`)).resolves.toMatchObject({ status: 200 });
  });

  it('rejects a URL the policy predicate does not allow, without dispatching', async () => {
    const fetcher = createHttpFetcher({
      isUrlAllowed: () => false,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
    });

    await expect(fetcher.fetch(`${ORIGIN}/data/clients/secret`)).rejects.toThrow(
      UrlNotAllowedError,
    );
  });

  it('rejects a literal loopback IP hostname even when the policy predicate allows it', async () => {
    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
    });

    await expect(fetcher.fetch('http://127.0.0.1/admin')).rejects.toThrow(SsrfBlockedError);
  });

  it('rejects a literal link-local (cloud metadata) IPv4 hostname', async () => {
    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
    });

    await expect(fetcher.fetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it('rejects a literal IPv6 loopback hostname (bracketed form)', async () => {
    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
    });

    await expect(fetcher.fetch('http://[::1]/admin')).rejects.toThrow(SsrfBlockedError);
  });

  it('rejects a literal deprecated site-local IPv6 hostname (fec0::/10)', async () => {
    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
    });

    await expect(fetcher.fetch('http://[fec0::1]/admin')).rejects.toThrow(SsrfBlockedError);
  });

  it('follows an allowed redirect and re-validates the target against policy', async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: '/ge/', method: 'GET' })
      .reply(302, '', { headers: { location: '/ge/ads/' } });
    mockAgent.get(ORIGIN).intercept({ path: '/ge/ads/', method: 'GET' }).reply(200, 'landed');

    const seenUrls: string[] = [];
    const fetcher = createHttpFetcher({
      isUrlAllowed: (url) => {
        seenUrls.push(url);
        return true;
      },
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
    });

    const result = await fetcher.fetch(`${ORIGIN}/ge/`);

    expect(result).toMatchObject({ status: 200, body: 'landed', redirectCount: 1 });
    expect(seenUrls).toEqual([`${ORIGIN}/ge/`, `${ORIGIN}/ge/ads/`]);
  });

  it('rejects when a redirect target is not allowed by policy', async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: '/ge/', method: 'GET' })
      .reply(302, '', { headers: { location: '/data/clients/secret' } });

    const fetcher = createHttpFetcher({
      isUrlAllowed: (url) => !url.includes('/data/clients/'),
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
    });

    await expect(fetcher.fetch(`${ORIGIN}/ge/`)).rejects.toThrow(UrlNotAllowedError);
  });

  it('rejects when a redirect targets a private IP literal', async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: '/ge/', method: 'GET' })
      .reply(302, '', { headers: { location: 'http://127.0.0.1/evil' } });

    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
    });

    await expect(fetcher.fetch(`${ORIGIN}/ge/`)).rejects.toThrow(SsrfBlockedError);
  });

  it("returns a redirect unfollowed, location included, in 'manual' redirect mode", async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: '/tenders/?pg=394', method: 'GET' })
      .reply(302, '<html>Object moved</html>', { headers: { location: '/tenders/?pg=1' } });

    const seenUrls: string[] = [];
    const fetcher = createHttpFetcher({
      isUrlAllowed: (url) => {
        seenUrls.push(url);
        return true;
      },
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
      redirect: 'manual',
    });

    const result = await fetcher.fetch(`${ORIGIN}/tenders/?pg=394`);

    expect(result).toMatchObject({ status: 302, redirectCount: 0 });
    expect(result.headers.location).toBe('/tenders/?pg=1');
    expect(result.finalUrl).toBe(`${ORIGIN}/tenders/?pg=394`);
    expect(seenUrls).toEqual([`${ORIGIN}/tenders/?pg=394`]);
  });

  it('gives up after exceeding the configured redirect limit', async () => {
    mockAgent
      .get(ORIGIN)
      .intercept({ path: '/loop', method: 'GET' })
      .reply(302, '', { headers: { location: '/loop' } })
      .persist();

    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
      maxRedirects: 2,
    });

    await expect(fetcher.fetch(`${ORIGIN}/loop`)).rejects.toThrow(TooManyRedirectsError);
  });

  it('enforces the response size limit', async () => {
    mockAgent.get(ORIGIN).intercept({ path: '/big', method: 'GET' }).reply(200, 'x'.repeat(1000));

    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
      maxResponseBytes: 100,
    });

    await expect(fetcher.fetch(`${ORIGIN}/big`)).rejects.toThrow(ResponseTooLargeError);
  });

  it('still follows a redirect whose body is within the configured byte limit', async () => {
    // undici's body.dump() truncates-and-resolves rather than rejecting on
    // overflow (confirmed by reading its source: it destroys the stream but
    // only rejects if an externally-aborted signal was supplied), so
    // passing maxResponseBytes through to the redirect dump call bounds
    // wasted reads on an oversized throwaway body without itself being
    // observable as a rejection — this only confirms the in-budget case
    // still behaves normally.
    mockAgent
      .get(ORIGIN)
      .intercept({ path: '/ge/', method: 'GET' })
      .reply(302, 'small redirect body', { headers: { location: '/ge/ads/' } });
    mockAgent.get(ORIGIN).intercept({ path: '/ge/ads/', method: 'GET' }).reply(200, 'landed');

    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
      maxResponseBytes: 100,
    });

    await expect(fetcher.fetch(`${ORIGIN}/ge/`)).resolves.toMatchObject({
      status: 200,
      body: 'landed',
    });
  });

  it('releases the rate limiter slot even when a request fails, so later fetches are not stuck', async () => {
    // No interceptor registered for /missing, so MockAgent throws.
    mockAgent.get(ORIGIN).intercept({ path: '/ok', method: 'GET' }).reply(200, 'ok');

    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
    });

    await expect(fetcher.fetch(`${ORIGIN}/missing`)).rejects.toBeTruthy();
    await expect(fetcher.fetch(`${ORIGIN}/ok`)).resolves.toMatchObject({ status: 200 });
  });

  it('does not close an injected dispatcher on close()', async () => {
    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
    });

    await fetcher.close();

    // The injected mockAgent must still be usable — close() must have been a no-op on it.
    mockAgent.get(ORIGIN).intercept({ path: '/still-open', method: 'GET' }).reply(200, 'ok');
    await expect(fetcher.fetch(`${ORIGIN}/still-open`)).resolves.toMatchObject({ status: 200 });
  });

  it('backs the limiter off when the source answers 429 or 503, and still returns the response', async () => {
    mockAgent.get(ORIGIN).intercept({ path: '/limited', method: 'GET' }).reply(429, 'slow down');
    mockAgent
      .get(ORIGIN)
      .intercept({ path: '/busy', method: 'GET' })
      .reply(503, 'busy', { headers: { 'retry-after': '30' } });
    mockAgent.get(ORIGIN).intercept({ path: '/ok', method: 'GET' }).reply(200, 'ok');
    const backOffs: number[] = [];
    const tracked: RateLimiter = {
      acquire: () => rateLimiter.acquire(),
      backOff: (ms) => {
        backOffs.push(ms);
        rateLimiter.backOff(0);
      },
      get backOffCount() {
        return rateLimiter.backOffCount;
      },
    };
    const fetcher = createHttpFetcher({
      isUrlAllowed: allowAll,
      rateLimiter: tracked,
      userAgent: USER_AGENT,
      dispatcher: mockAgent,
    });

    await expect(fetcher.fetch(`${ORIGIN}/limited`)).resolves.toMatchObject({ status: 429 });
    await expect(fetcher.fetch(`${ORIGIN}/busy`)).resolves.toMatchObject({ status: 503 });
    await expect(fetcher.fetch(`${ORIGIN}/ok`)).resolves.toMatchObject({ status: 200 });
    expect(backOffs).toEqual([5_000, 30_000]);
  });
});

describe('backOffSpacingMs', () => {
  it('doubles from 5 s with each push-back this run, capped at 60 s', () => {
    expect(backOffSpacingMs(undefined, 0)).toBe(5_000);
    expect(backOffSpacingMs(undefined, 1)).toBe(10_000);
    expect(backOffSpacingMs(undefined, 3)).toBe(40_000);
    expect(backOffSpacingMs(undefined, 9)).toBe(60_000);
  });

  it('honours a longer Retry-After, in seconds or as a date, within the cap', () => {
    expect(backOffSpacingMs('30', 0)).toBe(30_000);
    expect(backOffSpacingMs('1', 0)).toBe(5_000);
    expect(backOffSpacingMs('3600', 0)).toBe(60_000);
    const now = Date.parse('2026-09-26T20:00:00Z');
    expect(backOffSpacingMs('Sat, 26 Sep 2026 20:00:20 GMT', 0, now)).toBe(20_000);
    expect(backOffSpacingMs('not a date', 0, now)).toBe(5_000);
  });
});
