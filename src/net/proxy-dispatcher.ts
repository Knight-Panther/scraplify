import { type Dispatcher, Pool, ProxyAgent, request } from 'undici';

/**
 * How long the proxy has to answer a CONNECT. A request's own timeout does
 * not reach that step (undici sends the CONNECT without the request's abort
 * signal), so without this a proxy that takes the connection and then says
 * nothing, such as a reverse tunnel whose far end has gone, holds every
 * request for undici's 300 s default (measured 307 s on 8.12.3).
 */
const TUNNEL_TIMEOUT_MS = 30_000;

export interface ProxyDispatcher {
  readonly dispatcher: ProxyAgent;
  /** scheme://host:port, never the credentials: safe to log. */
  readonly label: string;
}

/**
 * An HTTP(S) forward proxy for one source's requests, from an environment
 * variable such as `SS_GE_PROXY_URL` (`http://[user:pass@]host:port`), or null
 * when it is unset or empty, so the source fetches directly as before.
 *
 * ss.ge answers only Georgian addresses since 2026-10-22 (docs/STATUS.md), so
 * its requests leave through a Georgian exit while every other source stays
 * direct. The fetcher's own policy check still runs on every URL; DNS for the
 * target is resolved by the proxy, so the SSRF-safe lookup does not apply to
 * proxied requests, and a literal private address is still refused before
 * anything is sent.
 */
export function proxyDispatcherFromEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  tunnelTimeoutMs = TUNNEL_TIMEOUT_MS,
): ProxyDispatcher | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be an http:// or https:// proxy, got ${url.protocol}`);
  }
  if (url.port === '') {
    throw new Error(`${name} must name the proxy's port`);
  }
  const label = `${url.protocol}//${url.hostname}:${url.port}`;
  const dispatcher = new ProxyAgent({
    uri: raw,
    clientFactory: (origin, options) =>
      new Pool(origin, { ...options, headersTimeout: tunnelTimeoutMs }),
  });
  return { dispatcher, label };
}

/**
 * Whether `url` (an https:// address, such as the source's robots.txt) gets
 * any HTTP answer through the proxy, whatever its status: a refused
 * connection, a failed CONNECT or a timeout means the way out is down, while
 * a 403 is the source's own answer.
 */
export async function answersThroughProxy(
  dispatcher: Dispatcher,
  url: string,
  userAgent: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  try {
    const response = await request(url, {
      dispatcher,
      headers: { 'user-agent': userAgent },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body.dump();
    return true;
  } catch {
    return false;
  }
}
