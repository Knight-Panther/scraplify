import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Whether the way out a proxied source takes is up, told to Hermes only when
 * that changes (`src/cli/proxy-watch.ts`, every 5 minutes). For ss.ge that is
 * the owner's laptop in Tbilisi: when it is off or offline, the nightly run
 * waits for it and the owner should know.
 *
 * A short gap is not news: the laptop moves from cable to Wi-Fi, or the
 * tunnel reconnects, within a minute or two. So "down" is told only once the
 * checks have failed for `DOWN_AFTER_MS`, and "up" at the first check that
 * passes after a "down" was told.
 */

export const DOWN_AFTER_MS = 10 * 60 * 1000;

export interface ProxyWatchState {
  /** What Hermes was last told. A first run assumes `up`, so it reports nothing until something fails. */
  reported: 'up' | 'down';
  /** The first failed check of the current failing stretch; null while checks pass. */
  failingSince: string | null;
}

export interface ProxyCheck {
  /** The source answered through the proxy, whatever its status. */
  answers: boolean;
  /** The proxy's port took a connection: the laptop's tunnel is up. */
  tunnel: boolean;
}

export interface ProxyChange {
  state: 'down' | 'up';
  since: string;
  tunnel: boolean;
  downMinutes: number | null;
}

export const INITIAL_PROXY_WATCH_STATE: ProxyWatchState = { reported: 'up', failingSince: null };

/** The state after one check, and the change to tell Hermes, if any. */
export function nextProxyWatch(
  state: ProxyWatchState,
  check: ProxyCheck,
  now: Date,
): { state: ProxyWatchState; change: ProxyChange | null } {
  const at = now.toISOString();
  if (check.answers) {
    if (state.reported === 'up') return { state: INITIAL_PROXY_WATCH_STATE, change: null };
    const downMs =
      state.failingSince === null ? null : now.getTime() - Date.parse(state.failingSince);
    return {
      state: INITIAL_PROXY_WATCH_STATE,
      change: {
        state: 'up',
        since: at,
        tunnel: check.tunnel,
        downMinutes: downMs === null ? null : Math.max(0, Math.round(downMs / 60_000)),
      },
    };
  }

  const failingSince = state.failingSince ?? at;
  if (state.reported === 'down' || now.getTime() - Date.parse(failingSince) < DOWN_AFTER_MS) {
    return { state: { reported: state.reported, failingSince }, change: null };
  }
  return {
    state: { reported: 'down', failingSince },
    change: { state: 'down', since: failingSince, tunnel: check.tunnel, downMinutes: null },
  };
}

const STATE_FILE = 'state.json';

/** The saved state, or the initial one when there is none or it cannot be read. */
export async function readProxyWatchState(directory: string): Promise<ProxyWatchState> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(directory, STATE_FILE), 'utf8'));
    const candidate = value as Partial<ProxyWatchState>;
    if (
      (candidate.reported === 'up' || candidate.reported === 'down') &&
      (candidate.failingSince === null ||
        (typeof candidate.failingSince === 'string' &&
          !Number.isNaN(Date.parse(candidate.failingSince))))
    ) {
      return { reported: candidate.reported, failingSince: candidate.failingSince };
    }
  } catch {
    // Missing or unreadable: start over.
  }
  return INITIAL_PROXY_WATCH_STATE;
}

/** Saved through a temporary file and a rename, so a check never reads half a state. */
export async function writeProxyWatchState(
  directory: string,
  state: ProxyWatchState,
): Promise<void> {
  const target = path.join(directory, STATE_FILE);
  const temporary = path.join(directory, `.${STATE_FILE}.${process.pid}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(state));
  await fs.rename(temporary, target);
}
