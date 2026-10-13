import os from 'node:os';
import { db } from '../db/client.js';
import {
  buildPipelineEvent,
  buildTestEvent,
  type EventContext,
  type HermesEvent,
  type RunFacts,
  readRunFacts,
  releaseFromDirectory,
} from '../hermes/event.js';
import { DEFAULT_OUTBOX_DIR, writeOutboxEvent } from '../hermes/outbox.js';
import { parseHermesEvent } from '../hermes/schema.js';
import { logger } from '../logger.js';
import { PUBLIC_MATCHING_CHANNEL } from '../matching/bundle/contract.js';
import { parseHermesEventOptions } from './hermes-event-options.js';

/**
 * Writes one event into the Hermes outbox (`docs/hermes-hook.md`). Called by
 * `deploy/run-pipeline.sh` when a run ends, with the worker's environment: it
 * reads the run's counters from the database and holds no hook secret. A
 * separate unit sends the file (`src/cli/hermes-notify.ts`).
 *
 * It does nothing unless `HERMES_HOOK_ENABLED=1`, so a release can be
 * deployed before Hermes' side exists. `--test` writes a test event whatever
 * that says, since someone asked for it by hand.
 *
 * It never decides the pipeline's result: the script ignores its exit code.
 */
async function main(): Promise<void> {
  const options = parseHermesEventOptions(process.argv.slice(2));
  if (options.kind === 'pipeline' && process.env.HERMES_HOOK_ENABLED !== '1') return;

  const context: EventContext = {
    now: new Date(),
    release: releaseFromDirectory(process.cwd()),
    host: os.hostname(),
  };
  let event: HermesEvent;
  if (options.kind === 'test') {
    event = buildTestEvent(context);
  } else {
    // A run that ended because the database is down is still worth telling:
    // the event goes out without the run's row.
    let facts: RunFacts = { crawlRun: null, bundle: null };
    try {
      facts = await readRunFacts(db, options.run, PUBLIC_MATCHING_CHANNEL);
    } catch (err) {
      logger.error({ err }, 'hermes event: could not read the run from the database');
    }
    event = buildPipelineEvent(options.run, facts, context);
  }

  // The sender refuses anything that is not exactly an event; say so here,
  // where the cause is, and do not leave it a file to bury.
  if (parseHermesEvent(event) === null) {
    throw new Error('the event built does not match src/hermes/schema.ts');
  }
  const directory = process.env.HERMES_OUTBOX_DIR ?? DEFAULT_OUTBOX_DIR;
  await writeOutboxEvent(directory, event);
  logger.info(
    { eventId: event.event_id, eventType: event.event_type },
    'hermes event: written to the outbox',
  );
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'hermes event: not written');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
