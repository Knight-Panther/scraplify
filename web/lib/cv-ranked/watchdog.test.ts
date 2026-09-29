import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchdog } from './watchdog.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// Date.now is faked, so it stands in for performance.now: it moves with
// advanceTimersByTime, and setSystemTime moves it with no timer firing,
// which is what a frozen tab looks like from inside.
const clock = () => Date.now();

describe('watchdog', () => {
  it('expires once its limit of running time has passed', () => {
    const expired = vi.fn();
    watchdog(5_000, expired, clock);
    vi.advanceTimersByTime(4_000);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(expired).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10_000);
    expect(expired).toHaveBeenCalledOnce();
  });

  it('counts from zero again after reset', () => {
    const expired = vi.fn();
    const guard = watchdog(5_000, expired, clock);
    vi.advanceTimersByTime(4_000);
    guard.reset();
    vi.advanceTimersByTime(4_000);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(expired).toHaveBeenCalledOnce();
  });

  it('does not charge a frozen tab for the time nothing ran', () => {
    const expired = vi.fn();
    watchdog(30_000, expired, clock);
    vi.advanceTimersByTime(10_000);
    // Ten minutes pass with no tick: the phone switched apps.
    vi.setSystemTime(Date.now() + 600_000);
    vi.advanceTimersByTime(1_000);
    expect(expired).not.toHaveBeenCalled();
    // The late tick counted as two seconds, so 12 s of 30 s are used.
    vi.advanceTimersByTime(17_000);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(expired).toHaveBeenCalledOnce();
  });

  it('never fires after stop', () => {
    const expired = vi.fn();
    watchdog(5_000, expired, clock).stop();
    vi.advanceTimersByTime(60_000);
    expect(expired).not.toHaveBeenCalled();
  });
});
