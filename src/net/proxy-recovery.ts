import { logger as defaultLogger } from '../logger.js';
import {
  type HttpFetcher,
  type HttpFetchResult,
  ResponseTooLargeError,
  SsrfBlockedError,
  TooManyRedirectsError,
  UrlNotAllowedError,
} from './http-fetcher.js';

/** How often a run still waiting for its proxy says so in the log. */
const REPORT_EVERY_MS = 30 * 60 * 1000;

/** The proxy stayed unreachable for longer than the run may wait for it. */
export class ProxyUnreachableError extends Error {
  constructor(label: string, waitedMs: number) {
    super(
      `the proxy ${label} stayed unreachable (waited ${Math.round(waitedMs / 60_000)} min in this run)`,
    );
    this.name = 'ProxyUnreachableError';
  }
}

export interface ProxyRecoveryOptions {
  /** scheme://host:port, for the log and the error (ProxyDispatcher.label). */
  label: string;
  /**
   * One request to the source through the proxy. True when any HTTP answer
   * came back, whatever its status: the way out works, and a refusal is the
   * source's to make, not the proxy's.
   */
  probe: () => Promise<boolean>;
  /** Waiting allowed over the whole run, all outages together. */
  maxWaitMs: number;
  /** Time between probes while waiting. */
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: Pick<typeof defaultLogger, 'info' | 'warn' | 'error'>;
}

/**
 * Our own refusals, made before anything is sent: the proxy has nothing to do
 * with them.
 */
function isLocalRefusal(err: unknown): boolean {
  return (
    err instanceof UrlNotAllowedError ||
    err instanceof SsrfBlockedError ||
    err instanceof TooManyRedirectsError ||
    err instanceof ResponseTooLargeError
  );
}

/**
 * A fetcher whose requests leave through a proxy that can go away for a
 * while: the owner's laptop in Tbilisi for ss.ge (RUNBOOK §3 step 9), which
 * may be switched off, rebooting or offline.
 *
 * Every proxy fault reaches the caller as a thrown error (undici reports a
 * refused connection, a failed CONNECT and a timeout that way), while
 * anything the source itself answers is a status. So on a thrown error this
 * probes the proxy. If it answers, the error was this request's own and goes
 * to the caller, whose retries handle it as before. If it does not, this
 * waits, probing every `pollMs`, and once the proxy is back asks for the same
 * URL again, so a run carries on where it was instead of ending. Waiting is
 * capped over the whole run; past the cap it throws `ProxyUnreachableError`,
 * which the caller should treat as the end of its run.
 */
export function withProxyRecovery(inner: HttpFetcher, options: ProxyRecoveryOptions): HttpFetcher {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const log = options.log ?? defaultLogger;
  let waitedMs = 0;

  async function waitForProxy(): Promise<void> {
    const startedAt = now();
    const spent = () => waitedMs + (now() - startedAt);
    if (spent() < options.maxWaitMs) {
      log.warn(
        { proxy: options.label, waitLeftMin: Math.round((options.maxWaitMs - spent()) / 60_000) },
        'proxy unreachable; waiting for it to come back',
      );
    }
    let reportedAt = startedAt;
    while (spent() < options.maxWaitMs) {
      await sleep(options.pollMs);
      if (await options.probe()) {
        waitedMs = spent();
        log.info(
          { proxy: options.label, downForMin: Math.round((now() - startedAt) / 60_000) },
          'proxy is back; carrying on',
        );
        return;
      }
      if (now() - reportedAt >= REPORT_EVERY_MS) {
        reportedAt = now();
        log.warn(
          { proxy: options.label, downForMin: Math.round((now() - startedAt) / 60_000) },
          'proxy still unreachable; still waiting',
        );
      }
    }
    waitedMs = spent();
    log.error(
      { proxy: options.label, waitedMin: Math.round(waitedMs / 60_000) },
      'gave up waiting for the proxy',
    );
    throw new ProxyUnreachableError(options.label, waitedMs);
  }

  return {
    async fetch(url: string): Promise<HttpFetchResult> {
      try {
        return await inner.fetch(url);
      } catch (err) {
        if (isLocalRefusal(err) || (await options.probe())) throw err;
        await waitForProxy();
        return await inner.fetch(url);
      }
    },
    close: () => inner.close(),
  };
}
