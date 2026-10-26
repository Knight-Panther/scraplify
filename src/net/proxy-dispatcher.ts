import { ProxyAgent } from 'undici';

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
  return { dispatcher: new ProxyAgent(raw), label };
}
