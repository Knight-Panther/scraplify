import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INITIAL_PROXY_WATCH_STATE,
  nextProxyWatch,
  type ProxyChange,
  type ProxyCheck,
  type ProxyWatchState,
  readProxyWatchState,
  writeProxyWatchState,
} from './proxy-watch.js';

const UP: ProxyCheck = { answers: true, tunnel: true };
const GONE: ProxyCheck = { answers: false, tunnel: false };
const OFFLINE: ProxyCheck = { answers: false, tunnel: true };

/** Checks every 5 minutes from 08:00 UTC, as the timer runs them; the changes told on the way. */
function watch(checks: ProxyCheck[], start: ProxyWatchState = INITIAL_PROXY_WATCH_STATE) {
  let state = start;
  const changes: (ProxyChange & { at: string })[] = [];
  checks.forEach((check, index) => {
    const now = new Date(Date.UTC(2026, 9, 27, 8, index * 5));
    const next = nextProxyWatch(state, check, now);
    state = next.state;
    if (next.change !== null) changes.push({ ...next.change, at: now.toISOString() });
  });
  return { state, changes };
}

describe('nextProxyWatch', () => {
  it('says nothing while the proxy answers', () => {
    expect(watch([UP, UP, UP])).toEqual({ state: INITIAL_PROXY_WATCH_STATE, changes: [] });
  });

  it('says nothing about a gap shorter than ten minutes', () => {
    // 08:05 and 08:10 fail, 08:15 answers: the laptop moved to Wi-Fi.
    expect(watch([UP, GONE, GONE, UP]).changes).toEqual([]);
  });

  it('tells "down" once, from the first failed check, after ten minutes', () => {
    const { state, changes } = watch([UP, GONE, GONE, GONE, GONE, GONE]);
    expect(changes).toEqual([
      {
        state: 'down',
        since: '2026-10-27T08:05:00.000Z',
        tunnel: false,
        downMinutes: null,
        at: '2026-10-27T08:15:00.000Z',
      },
    ]);
    expect(state).toEqual({ reported: 'down', failingSince: '2026-10-27T08:05:00.000Z' });
  });

  it('says whether the tunnel was still up when it went down', () => {
    expect(watch([OFFLINE, OFFLINE, OFFLINE]).changes[0]?.tunnel).toBe(true);
  });

  it('tells "up" at the first answer after a "down", with how long it was down', () => {
    const { state, changes } = watch([GONE, GONE, GONE, GONE, UP, UP]);
    expect(
      changes.map(({ state: told, since, downMinutes }) => [told, since, downMinutes]),
    ).toEqual([
      ['down', '2026-10-27T08:00:00.000Z', null],
      ['up', '2026-10-27T08:20:00.000Z', 20],
    ]);
    expect(state).toEqual(INITIAL_PROXY_WATCH_STATE);
  });

  it('counts a new failing stretch from its own start', () => {
    const { changes } = watch([GONE, GONE, GONE, UP, GONE, UP, GONE, GONE, GONE]);
    expect(changes.map((change) => [change.state, change.since])).toEqual([
      ['down', '2026-10-27T08:00:00.000Z'],
      ['up', '2026-10-27T08:15:00.000Z'],
      ['down', '2026-10-27T08:30:00.000Z'],
    ]);
  });

  it('tells "up" after a "down" told before a restart, without a failing time', () => {
    const { changes } = watch([UP], { reported: 'down', failingSince: null });
    expect(changes).toEqual([expect.objectContaining({ state: 'up', downMinutes: null })]);
  });
});

describe('the saved state', () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  async function directory(): Promise<string> {
    const made = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-watch-'));
    directories.push(made);
    return made;
  }

  it('reads back what was written', async () => {
    const dir = await directory();
    const state: ProxyWatchState = { reported: 'down', failingSince: '2026-10-27T08:05:00.000Z' };
    await writeProxyWatchState(dir, state);
    expect(await readProxyWatchState(dir)).toEqual(state);
    expect(await fs.readdir(dir)).toEqual(['state.json']);
  });

  it('starts over when there is none, or it is not a state', async () => {
    const dir = await directory();
    expect(await readProxyWatchState(dir)).toEqual(INITIAL_PROXY_WATCH_STATE);
    for (const text of [
      '{',
      '{"reported":"sideways","failingSince":null}',
      '{"reported":"down","failingSince":"later"}',
    ]) {
      await fs.writeFile(path.join(dir, 'state.json'), text);
      expect(await readProxyWatchState(dir)).toEqual(INITIAL_PROXY_WATCH_STATE);
    }
  });
});
