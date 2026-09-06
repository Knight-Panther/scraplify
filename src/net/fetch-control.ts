import type { HttpFetchResult } from './http-fetcher.js';

export interface FetchControl {
  stopped: boolean;
}

function header(result: HttpFetchResult, name: string): string | undefined {
  const value = result.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** A successful final allowance response is usable, but must pause further requests. */
export function responseBackoffUntil(result: HttpFetchResult, observedAt: string): string | null {
  const retryAfter = header(result, 'retry-after');
  const exhausted = header(result, 'ratelimit-remaining')?.trim() === '0';
  if (result.status !== 429 && !exhausted && !(result.status >= 400 && retryAfter)) return null;
  const nowMs = Date.parse(observedAt);
  // The source's recorded window is 60s. Use that when no usable reset is supplied.
  let until = nowMs + 60_000;
  if (retryAfter) {
    const retryAt = /^\d+(?:\.\d+)?$/.test(retryAfter.trim())
      ? nowMs + Number(retryAfter) * 1000
      : Date.parse(retryAfter);
    if (Number.isFinite(retryAt) && retryAt <= 8.64e15) until = Math.max(until, retryAt);
  }
  const reset = header(result, 'ratelimit-reset');
  if (reset && /^\d+(?:\.\d+)?$/.test(reset.trim())) {
    // The RateLimit-Reset field is a delay in seconds, not a Unix timestamp.
    const resetAt = nowMs + Number(reset) * 1000;
    if (Number.isFinite(resetAt) && resetAt <= 8.64e15) until = Math.max(until, resetAt);
  }
  return new Date(until).toISOString();
}
