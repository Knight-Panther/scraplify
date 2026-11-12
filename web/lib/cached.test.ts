import { describe, expect, it } from 'vitest';
import { cachedByKey, cachedFor } from './cached.js';

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

describe('cachedByKey', () => {
  function counter() {
    const asked = new Map<string, number>();
    const load = (key: string, value?: number) => async () => {
      asked.set(key, (asked.get(key) ?? 0) + 1);
      return value ?? asked.get(key) ?? 0;
    };
    return { asked, load };
  }

  it('asks each key once per window, and callers of one key share its answer', async () => {
    let now = 1_000;
    const get = cachedByKey<number>(60_000, 10, undefined, () => now);
    const { asked, load } = counter();

    expect(
      await Promise.all([get('a', load('a')), get('a', load('a')), get('b', load('b'))]),
    ).toEqual([1, 1, 1]);
    now += 59_999;
    expect(await get('a', load('a'))).toBe(1);
    expect(asked.get('a')).toBe(1);

    now += 1;
    expect(await get('a', load('a'))).toBe(2);
    expect(asked.get('a')).toBe(2);
    expect(asked.get('b')).toBe(1);
  });

  it('shares an answer it does not keep only while it is on its way', async () => {
    const get = cachedByKey<number>(
      60_000,
      10,
      (n) => n > 10_000,
      () => 1_000,
    );
    const { asked, load } = counter();

    // Small: asked again by the next caller.
    expect(
      await Promise.all([get('small', load('small', 7)), get('small', load('small', 7))]),
    ).toEqual([7, 7]);
    expect(asked.get('small')).toBe(1);
    expect(await get('small', load('small', 7))).toBe(7);
    expect(asked.get('small')).toBe(2);

    // Large: kept.
    await get('large', load('large', 214_389));
    await get('large', load('large', 214_389));
    expect(asked.get('large')).toBe(1);
  });

  it('keeps no failed answer', async () => {
    const get = cachedByKey<string>(60_000, 10, undefined, () => 1_000);
    let asked = 0;
    const load = async () => {
      asked++;
      if (asked === 1) throw new Error('statement timeout');
      return 'answer';
    };

    await expect(get('k', load)).rejects.toThrow('statement timeout');
    expect(await get('k', load)).toBe('answer');
    expect(asked).toBe(2);
  });

  it('holds at most maxKeys answers, dropping the oldest', async () => {
    const get = cachedByKey<number>(60_000, 2, undefined, () => 1_000);
    const { asked, load } = counter();

    await get('a', load('a'));
    await get('b', load('b'));
    await get('c', load('c'));
    // 'a' went to make room; 'b' and 'c' are still held.
    await get('b', load('b'));
    await get('c', load('c'));
    expect([asked.get('b'), asked.get('c')]).toEqual([1, 1]);
    await get('a', load('a'));
    expect(asked.get('a')).toBe(2);
  });
});
