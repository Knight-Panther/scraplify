#!/usr/bin/env node
/**
 * Launcher for the web app, so it can read the repo-root `.env`.
 *
 * Two constraints collide here. The other package.json scripts use
 * `node --env-file-if-exists=.env …`, which Next cannot use: `next dev`
 * re-spawns a child with the parent's execArgv copied into NODE_OPTIONS, and
 * node refuses --env-file-if-exists there. And Next's own env loading only
 * looks in the project directory it is given — `web/` — while this repo keeps
 * one `.env` at the root for every tool.
 *
 * Loading the env here and spawning Next as a child solves both: the child
 * inherits real environment variables, which involves no execArgv and no
 * NODE_OPTIONS, and the file stays in exactly one place.
 *
 * Usage: node scripts/next.mjs <dev|build|start> [--profile qa] [...next args]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @next/env is CommonJS: under ESM it exposes only a default export, so a
// named import silently yields undefined rather than failing loudly.
import nextEnv from '@next/env';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const profileAt = argv.indexOf('--profile');
const profile = profileAt === -1 ? null : argv[profileAt + 1];
// Guard the -1 case explicitly. Filtering on `i !== profileAt + 1` when
// profileAt is -1 drops index 0 — the Next SUBCOMMAND — so `build web` became
// `web` and Next silently fell back to starting a dev server.
const nextArgs =
  profileAt === -1 ? argv : argv.filter((_, i) => i !== profileAt && i !== profileAt + 1);

/** Minimal KEY=VALUE reader. Enough for an overlay file; not a dotenv clone. */
function readEnvFile(file) {
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => {
        const eq = line.indexOf('=');
        const key = line.slice(0, eq).trim();
        const value = line
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, '');
        return [key, value];
      }),
  );
}

// The repo-root .env, the same file every other script reads.
nextEnv.loadEnvConfig(repoRoot);

if (profile === 'qa') {
  // The disposable-copy profile, overlaid on .env so it only states what
  // differs: DATABASE_URL and the write gate. Writes are never enabled against
  // the live corpus — see references/browser-qa.md §1.
  const file = path.join(repoRoot, '.env.qa');
  if (!fs.existsSync(file)) {
    console.error(`scripts/next.mjs: --profile qa requires ${file}, which does not exist.`);
    process.exit(1);
  }
  Object.assign(process.env, readEnvFile(file));
}

const bin = path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const child = spawn(process.execPath, [bin, ...nextArgs], {
  stdio: 'inherit',
  env: process.env,
  cwd: repoRoot,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
