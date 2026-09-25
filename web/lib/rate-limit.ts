import type { Surface } from './surface.js';

/**
 * Per-client rate limits (Phase 8E, change.md §11: "DoS against DB
 * queries/artifacts"). A token bucket per client and class, held in this
 * process's memory. That is enough here: each surface is one Node process
 * behind the reverse proxy, which applies its own coarser limits too
 * (`deploy/Caddyfile`). It bounds abuse; it is not a quota. The numbers are
 * generous enough that a person browsing, including Next's link prefetches,
 * never meets them.
 *
 * Only `public` and `admin` are limited. `local` is the operator's own
 * loopback instance.
 */

export type RateClass = 'page' | 'manifest' | 'bundle' | 'auth';

interface Bucket {
  capacity: number;
  refillPerSecond: number;
}

export const RATE_LIMITS: Readonly<Record<RateClass, Bucket>> = {
  // Every page queries the database.
  page: { capacity: 240, refillPerSecond: 4 },
  manifest: { capacity: 60, refillPerSecond: 1 },
  // The 2.8 MB bundle: one CV session downloads it once, then the browser caches it.
  bundle: { capacity: 20, refillPerSecond: 1 / 30 },
  // The admin sign-in flow.
  auth: { capacity: 20, refillPerSecond: 1 / 6 },
};

/** Which bucket a request draws from, or null when it is not limited. */
export function rateClass(surface: Surface, pathname: string): RateClass | null {
  if (surface === 'local') return null;
  if (pathname.startsWith('/api/matching/bundles/')) return 'bundle';
  if (pathname === '/api/matching/manifest') return 'manifest';
  if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) return 'auth';
  return 'page';
}

/**
 * The client address, as the reverse proxy reports it. The web process
 * listens on loopback only (`start:web -H 127.0.0.1`), so every request
 * comes through that proxy. The proxy appends the real peer address as the
 * last `X-Forwarded-For` entry; anything before it was sent by the client
 * and cannot be trusted, so only the last entry is used.
 */
export function clientKey(forwardedFor: string | null): string {
  const last = forwardedFor?.split(',').at(-1)?.trim();
  return last ? last : 'direct';
}

interface State {
  tokens: number;
  updatedMs: number;
}

export class RateLimiter {
  private readonly states = new Map<string, State>();

  constructor(
    private readonly limits: Readonly<Record<RateClass, Bucket>> = RATE_LIMITS,
    private readonly maxKeys = 50_000,
  ) {}

  /** Takes one token. Returns 0 when allowed, else the seconds until one is available. */
  take(rateClassName: RateClass, client: string, nowMs: number): number {
    const { capacity, refillPerSecond } = this.limits[rateClassName];
    const key = `${rateClassName}\u0000${client}`;
    const previous = this.states.get(key);
    const tokens = previous
      ? Math.min(
          capacity,
          previous.tokens + ((nowMs - previous.updatedMs) / 1000) * refillPerSecond,
        )
      : capacity;
    if (tokens < 1) {
      this.states.set(key, { tokens, updatedMs: nowMs });
      return Math.ceil((1 - tokens) / refillPerSecond);
    }
    if (!previous && this.states.size >= this.maxKeys) this.evict(nowMs);
    this.states.set(key, { tokens: tokens - 1, updatedMs: nowMs });
    return 0;
  }

  get size(): number {
    return this.states.size;
  }

  /**
   * Drops every bucket that has refilled completely, since a full bucket is
   * the same as no entry. If that frees nothing (a flood of distinct
   * addresses), it drops the oldest half rather than grow without bound;
   * those clients just start again from a full bucket.
   */
  private evict(nowMs: number): void {
    for (const [key, state] of this.states) {
      const rateClassName = key.slice(0, key.indexOf('\u0000')) as RateClass;
      const { capacity, refillPerSecond } = this.limits[rateClassName];
      if (state.tokens + ((nowMs - state.updatedMs) / 1000) * refillPerSecond >= capacity) {
        this.states.delete(key);
      }
    }
    if (this.states.size < this.maxKeys) return;
    let drop = Math.ceil(this.states.size / 2);
    for (const key of this.states.keys()) {
      if (drop-- <= 0) break;
      this.states.delete(key);
    }
  }
}

const GLOBAL_KEY = Symbol.for('xtelo.rateLimiter');

/** One limiter per process, kept on `globalThis` so a dev-server reload does not reset it into a new one each edit. */
export function processRateLimiter(): RateLimiter {
  const store = globalThis as { [GLOBAL_KEY]?: RateLimiter };
  store[GLOBAL_KEY] ??= new RateLimiter();
  return store[GLOBAL_KEY];
}
