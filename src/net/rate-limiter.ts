import type { SourcePolicy } from '../domain/index.js';

export type RateLimitConfig = Pick<
  SourcePolicy['rateLimit'],
  'crawlDelaySeconds' | 'maxConcurrency'
>;

export interface RateLimiter {
  /**
   * Waits until a slot is available under both the concurrency and
   * crawl-delay constraints, then resolves with a release function the
   * caller must call exactly once, when its request has finished (success
   * or failure alike) — the crawl-delay clock starts from that call, not
   * from when acquire() resolved.
   */
  acquire(): Promise<() => void>;
}

/**
 * Per-source rate limiter enforcing SourcePolicy.rateLimit: at most
 * maxConcurrency requests in flight, and (when crawlDelaySeconds is set) a
 * minimum spacing before the next request may *start*.
 *
 * That spacing is measured from the previous request's completion
 * (release() being called), not its start. At maxConcurrency: 1 — every
 * source policy in this project today — measuring from start instead would
 * silently crawl faster than declared by exactly the prior request's own
 * duration, which is the wrong direction to be wrong in for a number that
 * exists to satisfy a site's declared crawl-delay.
 *
 * Deliberately hand-rolled rather than a `p-limit`-style dependency: those
 * handle concurrency alone, not the concurrency-plus-spacing pair this
 * needs, so a dependency wouldn't save the code that actually matters
 * here. Lives separately from src/net/http-fetcher.ts because rate
 * limiting is a per-source discipline that also applies to a future
 * browser-based (Playwright) acquisition path, which never touches this
 * module's undici Agent at all.
 */
export function createRateLimiter(rateLimit: RateLimitConfig): RateLimiter {
  const { maxConcurrency } = rateLimit;
  const minSpacingMs =
    rateLimit.crawlDelaySeconds === null ? 0 : rateLimit.crawlDelaySeconds * 1000;

  let active = 0;
  let earliestNextStart = 0;
  const waiters: Array<() => void> = [];
  let pumpTimer: ReturnType<typeof setTimeout> | null = null;

  function pump(): void {
    if (pumpTimer !== null) return;
    if (waiters.length === 0 || active >= maxConcurrency) return;

    const wait = Math.max(0, earliestNextStart - Date.now());
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      if (waiters.length === 0 || active >= maxConcurrency) return;
      // earliestNextStart may have moved further out (a different slot's
      // release() ran) while this timer was pending — re-check rather than
      // trusting the delay computed when it was scheduled.
      if (Date.now() < earliestNextStart) {
        pump();
        return;
      }
      const next = waiters.shift();
      active++;
      next?.();
      pump();
    }, wait);
  }

  function release(): void {
    active--;
    earliestNextStart = Date.now() + minSpacingMs;
    pump();
  }

  function acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      waiters.push(() => resolve(release));
      pump();
    });
  }

  return { acquire };
}
