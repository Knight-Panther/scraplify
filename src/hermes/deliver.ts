import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listOutbox } from './outbox.js';
import { parseHermesEvent } from './schema.js';
import { signHermesRequest } from './signature.js';

/**
 * Delivers what is waiting in the outbox to Hermes, oldest first
 * (`docs/hermes-hook.md`). Hermes runs on the owner's PC behind a Cloudflare
 * Tunnel, so it being unreachable for hours is normal: such an event is kept
 * and tried again on the next run. Only an answer that will not change by
 * waiting (a refused signature, an unknown route) takes an event out of the
 * queue, and it is moved aside, never deleted.
 *
 * Nothing here reads the database, and no header value or secret is logged:
 * a log line names the event, the answer and the event's age. A file that is
 * not exactly an event is never signed or sent.
 */

export const REQUEST_TIMEOUT_MS = 20_000;
/**
 * Past this, an event is moved aside unsent. Fourteen days, not the 72 hours
 * first built: Hermes' PC was unreachable for 68 hours in October 2026, and
 * Hermes had no catch-up from the database then. An event is a few hundred
 * bytes, and it is signed when sent, not when written, so age alone does not
 * make it unsendable.
 */
export const MAX_EVENT_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface HookConfig {
  url: string;
  secret: string;
  /** The Cloudflare Access service token, when the hook sits behind Access. */
  access: { clientId: string; clientSecret: string } | null;
}

export class HookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookConfigError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * `null` when the hook is not set up at all (the release is deployed before
 * Hermes' side exists). A half-filled or unsafe setup throws, naming the
 * variable and never its value.
 */
export function hookConfigFromEnv(env: NodeJS.ProcessEnv): HookConfig | null {
  const value = (name: string): string => (env[name] ?? '').trim();
  const url = value('HERMES_HOOK_URL');
  const secret = value('HERMES_HOOK_SECRET');
  const clientId = value('CF_ACCESS_CLIENT_ID');
  const clientSecret = value('CF_ACCESS_CLIENT_SECRET');
  if (url === '' && secret === '' && clientId === '' && clientSecret === '') return null;
  if (url === '') throw new HookConfigError('HERMES_HOOK_URL is not set');
  if (secret === '') throw new HookConfigError('HERMES_HOOK_SECRET is not set');
  if ((clientId === '') !== (clientSecret === ''))
    throw new HookConfigError('CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET go together');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HookConfigError('HERMES_HOOK_URL is not a URL');
  }
  // The request carries the Access token and a signature: never in the clear,
  // except to a mock on this machine.
  const plainLoopback = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !plainLoopback)
    throw new HookConfigError('HERMES_HOOK_URL must be https');
  return {
    url: parsed.toString(),
    secret,
    access: clientId === '' ? null : { clientId, clientSecret },
  };
}

export type Verdict = 'delivered' | 'retry' | 'dead';

/**
 * What an HTTP answer means for the event.
 *
 * A redirect is `dead`, and the request never follows one: Cloudflare Access
 * answers a wrong or expired service token with a 302 to its sign-in page,
 * and following it ends in a 200 that would read as delivered.
 */
export function verdictForStatus(status: number): Verdict {
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'dead';
}

export interface DeliveryLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface DeliverOptions {
  outboxDir: string;
  deadDir: string;
  config: HookConfig | null;
  log: DeliveryLog;
  /** This machine's name, the only one an event may carry. */
  host?: string;
  now?: () => Date;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface DeliverResult {
  delivered: string[];
  /** Still in the outbox, for the next run. */
  kept: string[];
  /** Moved to the dead directory. */
  dead: string[];
  /** Should have been moved to the dead directory, and could not be. */
  stuck: string[];
}

interface PendingEvent {
  name: string;
  body: Buffer;
  eventId: string;
  emittedAtMs: number;
}

/** An event is under a kilobyte; nothing this large is one. */
const MAX_EVENT_BYTES = 16 * 1024;

/**
 * The file as an event, or `null` when it is not exactly one
 * (`src/hermes/schema.ts`). The outbox is written by the crawl pipeline, a
 * different user from this sender, and what is signed here Hermes takes as
 * this host's word, so nothing is signed that is not a real event: the body
 * sent is the checked event written out again, never the file's own bytes.
 */
async function readPending(
  directory: string,
  name: string,
  host: string,
): Promise<PendingEvent | null> {
  let text: string;
  try {
    // Never through a link, and never waiting on a pipe: the name was a plain
    // file when it was listed, and another user owns the directory.
    const handle = await fs.open(
      path.join(directory, name),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      if (!(await handle.stat()).isFile()) return null;
      // The limit is the buffer itself, one byte over: a size read first could
      // be outgrown before the read, and this cannot.
      const buffer = Buffer.alloc(MAX_EVENT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_EVENT_BYTES) return null;
      text = buffer.toString('utf8', 0, length);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const event = parseHermesEvent(value, host);
  if (event === null) return null;
  return {
    name,
    body: Buffer.from(JSON.stringify(event), 'utf8'),
    eventId: event.event_id,
    emittedAtMs: Date.parse(event.emitted_at),
  };
}

/** The failure's kind, e.g. `TimeoutError`, `ECONNREFUSED` or `EACCES`: never a message, which can quote a URL. */
function failureKind(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown';
  const { code, cause } = err as { code?: unknown; cause?: { code?: unknown } };
  if (typeof code === 'string') return code;
  return typeof cause?.code === 'string' ? cause.code : err.name;
}

/** A rename, or a copy and delete where the two directories are on different mounts. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'EXDEV') throw err;
    await fs.copyFile(from, to);
    await fs.rm(from);
  }
}

export async function deliverOutbox(options: DeliverOptions): Promise<DeliverResult> {
  const { outboxDir, deadDir, config, log } = options;
  const host = options.host ?? os.hostname();
  const now = options.now ?? (() => new Date());
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const result: DeliverResult = { delivered: [], kept: [], dead: [], stuck: [] };

  const bury = async (name: string, eventId: string, reason: string, status?: number) => {
    try {
      await fs.mkdir(deadDir, { recursive: true });
      await moveFile(path.join(outboxDir, name), path.join(deadDir, name));
      result.dead.push(eventId);
      log.error(
        { eventId, reason, ...(status === undefined ? {} : { status }) },
        'hermes hook: event moved to the dead directory, it will not be sent again',
      );
    } catch (err) {
      result.stuck.push(eventId);
      log.error(
        { eventId, reason, failure: failureKind(err) },
        'hermes hook: could not move the event to the dead directory',
      );
    }
  };

  const seen = new Set<string>();
  // Stops at the first event Hermes cannot take now: the rest would wait out
  // the same timeout, and order is kept. Files written while this runs are
  // picked up by listing again.
  let unreachable = false;
  let warnedUnconfigured = false;
  while (!unreachable) {
    const names = (await listOutbox(outboxDir)).filter((name) => !seen.has(name));
    if (names.length === 0) break;
    const pending: PendingEvent[] = [];
    for (const name of names) {
      seen.add(name);
      const event = await readPending(outboxDir, name, host);
      if (event === null) await bury(name, name, 'not an event');
      else pending.push(event);
    }
    pending.sort((a, b) => a.emittedAtMs - b.emittedAtMs || a.name.localeCompare(b.name));

    for (const [index, event] of pending.entries()) {
      const ageMinutes = Math.round((now().getTime() - event.emittedAtMs) / 60_000);
      if (now().getTime() - event.emittedAtMs > MAX_EVENT_AGE_MS) {
        await bury(event.name, event.eventId, 'older than 14 days');
        continue;
      }
      if (config === null) {
        if (!warnedUnconfigured) {
          warnedUnconfigured = true;
          log.warn({}, 'hermes hook: events are waiting but the hook is not set up; keeping them');
        }
        result.kept.push(event.eventId);
        continue;
      }

      // Signed again on every attempt: Hermes refuses a timestamp older than
      // five minutes, and an event can wait for hours.
      const timestamp = Math.floor(now().getTime() / 1000);
      let verdict: Verdict;
      let status: number | undefined;
      let failure: string | undefined;
      try {
        const response = await send(config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Request-ID': event.eventId,
            'X-Webhook-Timestamp': String(timestamp),
            'X-Webhook-Signature-V2': signHermesRequest(config.secret, timestamp, event.body),
            ...(config.access === null
              ? {}
              : {
                  'CF-Access-Client-Id': config.access.clientId,
                  'CF-Access-Client-Secret': config.access.clientSecret,
                }),
          },
          // The same bytes that were signed, as a plain view: the web app's
          // typings do not take a Node Buffer as a request body.
          body: new Uint8Array(event.body),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = response.status;
        verdict = verdictForStatus(status);
        await response.body?.cancel().catch(() => undefined);
      } catch (err) {
        verdict = 'retry';
        failure = failureKind(err);
      }

      if (verdict === 'delivered') {
        await fs.rm(path.join(outboxDir, event.name), { force: true });
        result.delivered.push(event.eventId);
        log.info({ eventId: event.eventId, status, ageMinutes }, 'hermes hook: delivered');
      } else if (verdict === 'dead') {
        await bury(event.name, event.eventId, 'refused', status);
      } else {
        unreachable = true;
        const waiting = pending.slice(index);
        result.kept.push(...waiting.map((item) => item.eventId));
        log.warn(
          {
            eventId: event.eventId,
            ...(status === undefined ? { failure } : { status }),
            ageMinutes,
            waiting: waiting.length,
          },
          'hermes hook: Hermes did not take the event; it stays in the outbox for the next try',
        );
        break;
      }
    }
  }
  return result;
}
