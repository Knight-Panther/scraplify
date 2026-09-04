import { Agent, request } from 'undici';
import type { Dispatcher } from 'undici';
import { classifyIpAddress } from '../domain/index.js';
import type { RateLimiter } from './rate-limiter.js';
import { createSsrfSafeLookup, SsrfBlockedError } from './ssrf-lookup.js';

export { SsrfBlockedError } from './ssrf-lookup.js';

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10_000_000;

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export class UrlNotAllowedError extends Error {
  readonly code = 'ERR_URL_NOT_ALLOWED';
  readonly url: string;

  constructor(url: string) {
    super(`URL not allowed by source policy: ${url}`);
    this.name = 'UrlNotAllowedError';
    this.url = url;
  }
}

export class TooManyRedirectsError extends Error {
  readonly code = 'ERR_TOO_MANY_REDIRECTS';
  readonly url: string;

  constructor(url: string, limit: number) {
    super(`Exceeded the ${limit}-redirect limit fetching ${url}`);
    this.name = 'TooManyRedirectsError';
    this.url = url;
  }
}

export class ResponseTooLargeError extends Error {
  readonly code = 'ERR_RESPONSE_TOO_LARGE';
  readonly url: string;

  constructor(url: string, limitBytes: number) {
    super(`Response for ${url} exceeded the ${limitBytes}-byte limit`);
    this.name = 'ResponseTooLargeError';
    this.url = url;
  }
}

export interface HttpFetchResult {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
  readonly finalUrl: string;
  /** Number of redirects followed to reach this result; 0 if the first response was terminal. */
  readonly redirectCount: number;
}

export interface HttpFetcherOptions {
  /**
   * Source-policy authorization boundary, e.g. isJobsGeUrlAllowed — checked
   * before the initial request AND before following every redirect hop, per
   * concept §16/§23.1's "reapply SSRF and policy checks after every
   * redirect" requirement (not just document/attachment fetches; the
   * threat-model gap this module closes was explicitly about ordinary
   * index/detail fetches too).
   */
  isUrlAllowed: (url: string) => boolean;
  /**
   * Shared per-source limiter (see rate-limiter.ts) — created once by the
   * caller and passed in, not built here, so a future browser-based
   * acquisition path for the same source can share its concurrency/delay
   * budget with this one.
   */
  rateLimiter: RateLimiter;
  /** Sent on every request. No default: callers must choose an identifying value deliberately. */
  userAgent: string;
  /** Maximum redirect hops to follow before giving up. Default 5. */
  maxRedirects?: number;
  /** Per-request timeout (covers each redirect hop individually, not the whole chain). Default 15000. */
  requestTimeoutMs?: number;
  /** Response bodies are untrusted input (§2); abort past this many bytes. Default 10_000_000. */
  maxResponseBytes?: number;
  /**
   * Injectable for tests only — substitutes a fake undici Dispatcher (e.g.
   * MockAgent) so tests exercise the real request()/redirect/rate-limit
   * orchestration with zero real network or DNS I/O. Production callers
   * should omit this; it defaults to a real Agent wired to the SSRF-safe
   * DNS lookup (ssrf-lookup.ts). When supplied, this module does not own
   * or close it.
   */
  dispatcher?: Dispatcher;
}

export interface HttpFetcher {
  fetch(url: string): Promise<HttpFetchResult>;
  /** Closes the underlying dispatcher — a no-op if `dispatcher` was injected, since callers own dispatchers they supply themselves. */
  close(): Promise<void>;
}

/**
 * Classifies a URL's hostname as a blocked literal IP, or null if it isn't
 * one (a domain name, or a literal that's actually public). Node's socket
 * layer skips the dns.lookup hook entirely when the connection target is
 * already an IP literal (confirmed empirically against this project's
 * Node 24.20.0 — see ssrf-lookup.ts) — a URL whose hostname is `127.0.0.1`
 * or `[::1]` never reaches createSsrfSafeLookup at all, so this is an
 * independent, mandatory enforcement point, not a redundant belt-and-braces
 * check. URL.hostname wraps IPv6 literals in brackets; classifyIpAddress
 * expects the bare address.
 */
function literalIpBlocked(hostname: string): string | null {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const classification = classifyIpAddress(bare);
  if (classification === null || classification === 'public') return null;
  return bare;
}

async function readBodyWithLimit(
  body: AsyncIterable<Uint8Array>,
  limitBytes: number,
  url: string,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > limitBytes) {
      throw new ResponseTooLargeError(url, limitBytes);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * A source-compliant, SSRF-hardened GET fetcher: enforces the caller's URL
 * allow-list and this module's literal-IP check before every request AND
 * every redirect hop, paces requests through the supplied per-source
 * RateLimiter, and bounds redirects, timeout, and response size. DNS-level
 * SSRF protection (the rebinding-safe case, where the hostname is a domain
 * name) lives in ssrf-lookup.ts's Agent-level hook; this module adds the
 * literal-IP case that hook cannot see.
 *
 * Deliberately GET-only and redirect-following-by-hand rather than using
 * undici's own redirect interceptor: an automatic redirect follower has no
 * hook to re-run isUrlAllowed on each hop, which is the entire point.
 */
export function createHttpFetcher(options: HttpFetcherOptions): HttpFetcher {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const ownsDispatcher = options.dispatcher === undefined;
  const dispatcher: Dispatcher =
    options.dispatcher ?? new Agent({ connect: { lookup: createSsrfSafeLookup() } });

  async function fetchUrl(initialUrl: string): Promise<HttpFetchResult> {
    let currentUrl = initialUrl;

    for (let redirectCount = 0; ; redirectCount++) {
      if (redirectCount > maxRedirects) {
        throw new TooManyRedirectsError(initialUrl, maxRedirects);
      }

      if (!options.isUrlAllowed(currentUrl)) {
        throw new UrlNotAllowedError(currentUrl);
      }

      let hostname: string;
      try {
        hostname = new URL(currentUrl).hostname;
      } catch {
        // isUrlAllowed already accepted this string, but a caller-supplied
        // predicate isn't guaranteed to require URL-parseability — fail
        // closed rather than let an unparseable URL reach undici.
        throw new UrlNotAllowedError(currentUrl);
      }

      const blockedAddress = literalIpBlocked(hostname);
      if (blockedAddress !== null) {
        throw new SsrfBlockedError(hostname, [blockedAddress]);
      }

      const release = await options.rateLimiter.acquire();
      try {
        const response = await request(currentUrl, {
          method: 'GET',
          dispatcher,
          headers: { 'user-agent': options.userAgent },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });

        // release() must not run until the body is fully drained below —
        // undici's request() resolves on headers, before the body finishes
        // transferring, so releasing any earlier would let a subsequent
        // fetch start mid-transfer, violating maxConcurrency and a
        // crawl-delay meant to be measured from completion (see
        // rate-limiter.ts's own acquire() contract).
        const location = response.headers.location;
        const locationValue = Array.isArray(location) ? location[0] : location;
        if (REDIRECT_STATUS_CODES.has(response.statusCode) && locationValue !== undefined) {
          await response.body.dump({ limit: maxResponseBytes });
          currentUrl = new URL(locationValue, currentUrl).toString();
          continue;
        }

        const body = await readBodyWithLimit(response.body, maxResponseBytes, currentUrl);
        return {
          status: response.statusCode,
          headers: response.headers,
          body,
          finalUrl: currentUrl,
          redirectCount,
        };
      } finally {
        release();
      }
    }
  }

  async function close(): Promise<void> {
    if (ownsDispatcher) {
      await dispatcher.close();
    }
  }

  return { fetch: fetchUrl, close };
}
