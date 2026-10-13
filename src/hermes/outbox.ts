import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HermesEvent } from './event.js';

/**
 * The outbox: one JSON file per event, written by the pipeline and delivered
 * by a separate unit under a separate user (`src/hermes/deliver.ts`). The
 * pipeline holds the database credential and never the hook's secrets; the
 * sender holds the secrets and never a database credential. The sender does
 * not trust a file because it is here: it checks each one against the event's
 * exact shape before signing it (`src/hermes/schema.ts`).
 */

export const DEFAULT_OUTBOX_DIR = '/var/lib/xtelo/hermes/outbox';
/**
 * Beside the outbox, not inside it: the sender's unit starts only when the
 * outbox has something in it, and a directory inside would count. Under the
 * same parent, which the unit makes writable as one mount: two separately
 * writable directories are two mounts there, and a rename between them fails.
 */
export const DEFAULT_DEAD_DIR = '/var/lib/xtelo/hermes/dead';

/** An event id as a file name: ids hold `:`, which Windows refuses in a name. */
export function outboxFileName(eventId: string): string {
  return `${eventId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

/**
 * Writes the event under a hidden temporary name and renames it into place,
 * so the sender never reads half a file. Group-readable: the sender is a
 * different user (`xtelo-hermes`), which reads the outbox through its group.
 * An event holds nothing secret.
 */
export async function writeOutboxEvent(directory: string, event: HermesEvent): Promise<string> {
  const name = outboxFileName(event.event_id);
  const target = path.join(directory, name);
  const temporary = path.join(directory, `.${name}.${process.pid}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(event), { mode: 0o640 });
    await fs.rename(temporary, target);
  } catch (err) {
    await fs.rm(temporary, { force: true });
    throw err;
  }
  return target;
}

/** The finished event files waiting in the outbox, by name. */
export async function listOutbox(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.'),
    )
    .map((entry) => entry.name)
    .sort();
}
