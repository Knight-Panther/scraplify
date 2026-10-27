import net from 'node:net';
import os from 'node:os';
import { buildProxyEvent, type EventContext, releaseFromDirectory } from '../hermes/event.js';
import { DEFAULT_OUTBOX_DIR, writeOutboxEvent } from '../hermes/outbox.js';
import {
  nextProxyWatch,
  readProxyWatchState,
  writeProxyWatchState,
} from '../hermes/proxy-watch.js';
import { parseHermesEvent } from '../hermes/schema.js';
import { logger } from '../logger.js';
import { answersThroughProxy, proxyDispatcherFromEnv } from '../net/proxy-dispatcher.js';
import { resolveUserAgent } from '../net/user-agent.js';
import { ssGePolicy, ssGeSource } from '../policies/ss-ge.js';

/**
 * Checks ss.ge's way out, the owner's laptop in Tbilisi, and tells Hermes when
 * it goes down or comes back (`src/hermes/proxy-watch.ts`). Run every 5
 * minutes by `xtelo-proxy-watch.timer` with the worker's environment; the
 * event goes into the Hermes outbox, which `xtelo-hermes-notify` delivers.
 *
 * The check is the health check's: ss.ge's robots.txt through the proxy, any
 * answer counting. Its port is tried as well, so Hermes can tell a laptop
 * that is gone from one that is connected but cannot reach ss.ge.
 *
 * Nothing to check without `SS_GE_PROXY_URL`. The state is kept whatever
 * `HERMES_HOOK_ENABLED` says; only the event depends on it.
 */

const STATE_DIR = process.env.STATE_DIRECTORY ?? '/var/lib/xtelo-proxy-watch';
const PORT_TIMEOUT_MS = 5_000;

/** Whether `host:port` takes a TCP connection within the timeout. */
function portAnswers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(PORT_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function main(): Promise<void> {
  const proxy = proxyDispatcherFromEnv('SS_GE_PROXY_URL');
  if (proxy === null) return;
  const url = new URL(proxy.label);
  let answers: boolean;
  try {
    answers = await answersThroughProxy(proxy.dispatcher, ssGePolicy.robotsUrl, resolveUserAgent());
  } finally {
    await proxy.dispatcher.close();
  }
  const tunnel = await portAnswers(url.hostname, Number(url.port));

  const now = new Date();
  const previous = await readProxyWatchState(STATE_DIR);
  const { state, change } = nextProxyWatch(previous, { answers, tunnel }, now);

  if (change !== null) {
    logger.info(
      { proxy: proxy.label, ...change },
      `proxy watch: the ss.ge proxy is ${change.state}`,
    );
    if (process.env.HERMES_HOOK_ENABLED === '1') {
      const context: EventContext = {
        now,
        release: releaseFromDirectory(process.cwd()),
        host: os.hostname(),
      };
      const event = buildProxyEvent({ sourceSlug: ssGeSource.slug, ...change }, context);
      if (parseHermesEvent(event, context.host) === null) {
        throw new Error('the event built does not match src/hermes/schema.ts');
      }
      // Written before the state is saved: if this fails, the next check
      // finds the same change and tries again.
      await writeOutboxEvent(process.env.HERMES_OUTBOX_DIR ?? DEFAULT_OUTBOX_DIR, event);
      logger.info({ eventId: event.event_id }, 'proxy watch: event written to the outbox');
    }
  }
  await writeProxyWatchState(STATE_DIR, state);
}

main().catch((err: unknown) => {
  logger.error({ err }, 'proxy watch: failed');
  process.exitCode = 1;
});
