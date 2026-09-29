/**
 * A countdown that charges only the time this thread actually ran (Phase 8D).
 *
 * It ticks once a second, and a tick that arrives late adds at most two
 * ticks' worth. A late tick means nothing ran here: the tab was frozen in
 * the background, the phone switched apps, or this thread was busy parsing.
 * Without the cap, a visitor who comes back to the tab mid-download would
 * be told the connection failed when all that happened was a pause.
 *
 * Time comes from `performance.now`, so wall-clock changes do not count
 * either.
 */

const TICK_MS = 1_000;

export interface Watchdog {
  /** Progress was made: count from zero again. */
  reset(): void;
  stop(): void;
}

export function watchdog(
  limitMs: number,
  onExpire: () => void,
  clock: () => number = () => performance.now(),
): Watchdog {
  let elapsed = 0;
  let previous = clock();
  const timer = setInterval(() => {
    const now = clock();
    elapsed += Math.min(now - previous, 2 * TICK_MS);
    previous = now;
    if (elapsed < limitMs) return;
    clearInterval(timer);
    onExpire();
  }, TICK_MS);
  return {
    reset() {
      elapsed = 0;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
