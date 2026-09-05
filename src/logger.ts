import pino from 'pino';

/**
 * Shared structured logger. JSON to stdout by default (no pretty-printer
 * dependency) so a scheduled, unattended run (Windows Task Scheduler, a
 * future cron/always-on deployment) produces log lines a file redirect or
 * log shipper can parse directly, per concept §19.1's "every run begins
 * with ... preflight checks" — those checks and their failures need to be
 * visible in an unattended run's captured output, not just on a developer's
 * terminal.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
});
