import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './rate-limiter.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function isResolved(promise: Promise<unknown>): Promise<boolean> {
  const sentinel = Symbol('pending');
  const result = await Promise.race([promise, Promise.resolve(sentinel)]);
  return result !== sentinel;
}

// pump() resolves at most one queued waiter per zero-delay timer tick, then
// reschedules itself for the next one (see rate-limiter.ts). A zero-delay
// timer scheduled *during* an advanceTimersByTimeAsync(0) call is not picked
// up by that call or by further zero-ms calls (a quirk of the fake-timer
// implementation, confirmed empirically) — runAllTimersAsync drains the
// whole cascade instead. Only safe to use here because no longer-delay
// timer is pending at the points this is called.
async function flushImmediateAcquisitions(): Promise<void> {
  await vi.runAllTimersAsync();
}

describe('createRateLimiter', () => {
  it('allows up to maxConcurrency acquisitions without waiting', async () => {
    const limiter = createRateLimiter({ crawlDelaySeconds: null, maxConcurrency: 2 });

    const first = limiter.acquire();
    const second = limiter.acquire();
    await flushImmediateAcquisitions();

    expect(await isResolved(first)).toBe(true);
    expect(await isResolved(second)).toBe(true);
  });

  it('queues acquisitions beyond maxConcurrency until a slot is released', async () => {
    const limiter = createRateLimiter({ crawlDelaySeconds: null, maxConcurrency: 1 });

    const first = limiter.acquire();
    await vi.advanceTimersByTimeAsync(0);
    const release = await first;

    const second = limiter.acquire();
    await vi.advanceTimersByTimeAsync(0);
    expect(await isResolved(second)).toBe(false);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await isResolved(second)).toBe(true);
  });

  it('serves queued waiters in FIFO order', async () => {
    const limiter = createRateLimiter({ crawlDelaySeconds: null, maxConcurrency: 1 });

    const first = limiter.acquire();
    await vi.advanceTimersByTimeAsync(0);
    const release = await first;

    const order: string[] = [];
    const second = limiter.acquire().then((r) => {
      order.push('second');
      return r;
    });
    const third = limiter.acquire().then((r) => {
      order.push('third');
      return r;
    });

    release();
    await vi.advanceTimersByTimeAsync(0);
    const releaseSecond = await second;
    releaseSecond();
    await vi.advanceTimersByTimeAsync(0);
    await third;

    expect(order).toEqual(['second', 'third']);
  });

  it('measures crawl delay from release() time, not from when the request started', async () => {
    const limiter = createRateLimiter({ crawlDelaySeconds: 5, maxConcurrency: 1 });

    const first = limiter.acquire();
    await vi.advanceTimersByTimeAsync(0);
    const release = await first;

    // Simulate a slow request: a long gap between acquiring and releasing.
    await vi.advanceTimersByTimeAsync(60_000);
    release();

    const second = limiter.acquire();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await isResolved(second)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await isResolved(second)).toBe(true);
  });

  it('does not enforce spacing when crawlDelaySeconds is null, only concurrency', async () => {
    const limiter = createRateLimiter({ crawlDelaySeconds: null, maxConcurrency: 1 });

    const first = limiter.acquire();
    await vi.advanceTimersByTimeAsync(0);
    const release = await first;
    release();

    const second = limiter.acquire();
    await vi.advanceTimersByTimeAsync(0);
    expect(await isResolved(second)).toBe(true);
  });

  it('re-checks the delay if a later release pushes it further out while a wait is already scheduled', async () => {
    // maxConcurrency 2 so two in-flight requests can release independently
    // and race against a single pending timer, exercising the pump()
    // re-check for when earliestNextStart moved out from under it.
    const limiter = createRateLimiter({ crawlDelaySeconds: 5, maxConcurrency: 2 });

    const first = limiter.acquire();
    const second = limiter.acquire();
    await flushImmediateAcquisitions();
    const releaseFirst = await first;
    const releaseSecond = await second;

    const third = limiter.acquire();

    releaseFirst(); // t=0: schedules a wake for t=5000 (earliestNextStart)
    await vi.advanceTimersByTimeAsync(1_000);
    releaseSecond(); // t=1000: pushes earliestNextStart out to t=6000

    // The stale timer fires at t=5000, re-checks, and reschedules for t=6000.
    await vi.advanceTimersByTimeAsync(3_999); // t=4999
    expect(await isResolved(third)).toBe(false);

    await vi.advanceTimersByTimeAsync(999); // t=5998
    expect(await isResolved(third)).toBe(false);

    await vi.advanceTimersByTimeAsync(2); // t=6000
    expect(await isResolved(third)).toBe(true);
  });
});
