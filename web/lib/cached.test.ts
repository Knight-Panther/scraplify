import { describe, expect, it } from 'vitest';
import { cachedFor } from './cached.js';

describe('cachedFor', () => {
  function clockAt(start: number) {
    const clock = { now: start, read: () => clock.now };
    return clock;
  }

  it('asks once per window, and every caller in it shares the answer', async () => {
    const clock = clockAt(1_000);
    let asked = 0;
    const get = cachedFor(
      60_000,
      async () => {
        asked++;
        return `answer ${asked}`;
      },
      clock.read,
    );

    const [first, second] = await Promise.all([get(), get()]);
    expect([first, second]).toEqual(['answer 1', 'answer 1']);
    clock.now += 59_999;
    expect(await get()).toBe('answer 1');
    expect(asked).toBe(1);

    clock.now += 1;
    expect(await get()).toBe('answer 2');
    expect(asked).toBe(2);
  });

  it('keeps no failed answer: the next caller asks again', async () => {
    const clock = clockAt(1_000);
    let asked = 0;
    const get = cachedFor(
      60_000,
      async () => {
        asked++;
        if (asked === 1) throw new Error('database away');
        return 'answer';
      },
      clock.read,
    );

    await expect(get()).rejects.toThrow('database away');
    expect(await get()).toBe('answer');
    expect(asked).toBe(2);
  });

  it('lets a late failure of an old answer leave a newer one alone', async () => {
    const clock = clockAt(1_000);
    let fail: (reason: Error) => void = () => {};
    let asked = 0;
    const get = cachedFor(
      60_000,
      () => {
        asked++;
        if (asked === 1) {
          return new Promise<string>((_, reject) => {
            fail = reject;
          });
        }
        return Promise.resolve('newer');
      },
      clock.read,
    );

    const old = get();
    clock.now += 60_000;
    expect(await get()).toBe('newer');
    fail(new Error('too late'));
    await expect(old).rejects.toThrow('too late');
    expect(await get()).toBe('newer');
    expect(asked).toBe(2);
  });
});
