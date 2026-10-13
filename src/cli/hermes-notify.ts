import { deliverOutbox, type HookConfig, hookConfigFromEnv } from '../hermes/deliver.js';
import { DEFAULT_DEAD_DIR, DEFAULT_OUTBOX_DIR } from '../hermes/outbox.js';
import { logger } from '../logger.js';

/**
 * Sends what is waiting in the Hermes outbox (`docs/hermes-hook.md`). Run by
 * `xtelo-hermes-notify.service` when a pipeline run ends and every 15 minutes
 * while anything is still waiting. Its environment is
 * `/etc/xtelo/hermes-hook.env`: the hook's secrets and no database credential.
 *
 * Exits 1 when an event was refused for good, could not be moved aside, or
 * the setup is wrong, so the unit shows as failed. Hermes being unreachable
 * is not a failure.
 */
async function main(): Promise<void> {
  let config: HookConfig | null;
  try {
    config = hookConfigFromEnv(process.env);
  } catch (err) {
    logger.error(
      { reason: err instanceof Error ? err.message : 'unknown' },
      'hermes hook: /etc/xtelo/hermes-hook.env is wrong; nothing sent',
    );
    process.exitCode = 1;
    return;
  }
  const result = await deliverOutbox({
    outboxDir: process.env.HERMES_OUTBOX_DIR ?? DEFAULT_OUTBOX_DIR,
    deadDir: process.env.HERMES_DEAD_DIR ?? DEFAULT_DEAD_DIR,
    config,
    log: logger,
  });
  if (result.dead.length > 0 || result.stuck.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  // The error's name and code only: a message could quote the hook's address.
  const code = (err as { code?: unknown }).code;
  logger.error(
    { failure: typeof code === 'string' ? code : err instanceof Error ? err.name : 'unknown' },
    'hermes hook: sender failed',
  );
  process.exitCode = 1;
});
