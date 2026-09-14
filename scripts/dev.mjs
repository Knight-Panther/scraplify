#!/usr/bin/env node
/**
 * One command to bring up a working development environment.
 *
 * Starts Postgres if it is not already running, waits for it to be genuinely
 * accepting connections (not merely "container created"), applies any pending
 * migrations, then hands over to the Next dev server.
 *
 * No nodemon or similar: Next's dev server already does hot reload, and the
 * CLIs are one-shot commands that have nothing to watch.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nextEnv from '@next/env';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
nextEnv.loadEnvConfig(repoRoot);

/**
 * No `shell: true` anywhere here. Passing an argument array through a shell
 * concatenates rather than escapes it, which node warns about (DEP0190).
 * That rules out invoking `npm`, since on Windows it is `npm.cmd` and node
 * refuses to spawn .cmd without a shell — so the one npm script this needs is
 * called by its underlying binary instead.
 */
const run = (command, args, options = {}) =>
  spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot, ...options });

function step(message) {
  process.stdout.write(`\n\u001b[1m${message}\u001b[0m\n`);
}

step('1/3  Postgres');
const psCheck = spawnSync('docker', ['compose', 'ps', '--status', 'running', '--quiet'], {
  cwd: repoRoot,
  encoding: 'utf8',
});
if (psCheck.status !== 0) {
  console.error(
    'Could not talk to Docker. Docker Desktop is installed but not always running — start it and try again.',
  );
  process.exit(1);
}
if (psCheck.stdout.trim() === '') {
  console.log('starting the postgres container...');
  if (run('docker', ['compose', 'up', '-d', '--wait']).status !== 0) {
    console.error('docker compose up failed.');
    process.exit(1);
  }
} else {
  console.log('already running.');
}

step('2/3  Migrations');
// Idempotent: drizzle-kit skips anything already applied, so this is safe to
// run on every start and means a pulled branch never renders against a stale
// schema.
// Equivalent to `npm run db:migrate`, minus the npm indirection. The env is
// already loaded into this process, so no --env-file flag is needed either.
const drizzleKit = path.join(repoRoot, 'node_modules', 'drizzle-kit', 'bin.cjs');
if (run(process.execPath, [drizzleKit, 'migrate']).status !== 0) {
  console.error('Migrations failed. Not starting the app against a schema in an unknown state.');
  process.exit(1);
}

step('3/3  Web app  ->  http://127.0.0.1:3000');
const child = spawn(
  process.execPath,
  [path.join(repoRoot, 'scripts', 'next.mjs'), 'dev', 'web', '-H', '127.0.0.1'],
  {
    stdio: 'inherit',
    cwd: repoRoot,
    env: process.env,
  },
);
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
