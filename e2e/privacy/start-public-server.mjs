#!/usr/bin/env node
/**
 * Starts `next start` for the privacy suite and tees everything the server
 * prints (stdout and stderr) into a log file, so the spec can afterwards
 * assert that no CV canary reached the server's output.
 *
 * Usage: node e2e/privacy/start-public-server.mjs <log-file> <port>
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [logFile, port] = process.argv.slice(2);
if (!logFile || !port) {
  console.error('usage: start-public-server.mjs <log-file> <port>');
  process.exit(2);
}
fs.mkdirSync(path.dirname(logFile), { recursive: true });
const log = fs.createWriteStream(logFile, { flags: 'w' });

const child = spawn(
  process.execPath,
  ['scripts/next.mjs', 'start', 'web', '-H', '127.0.0.1', '-p', port],
  { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
);
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    log.write(chunk);
    process.stdout.write(chunk);
  });
}
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => {
  log.end(() => process.exit(code ?? 0));
});
