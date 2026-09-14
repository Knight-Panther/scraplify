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

/**
 * The database a connection string points at, for comparing two of them.
 * Returns null when the URL does not state one, which callers must treat as
 * "cannot prove anything" rather than as a distinct value.
 *
 * Compared by host, port and database name rather than by raw string, because
 * the same database is reachable by several spellings — localhost against
 * 127.0.0.1, a different password, a trailing parameter — and a string compare
 * would call those different and let the guard below pass.
 *
 * A URL with no database path is REJECTED rather than treated as its own
 * identity, and that distinction is the whole finding: an omitted path does
 * not mean "no database". node-postgres falls back to the user name, so
 * `postgres://scraplify@host` silently opens the LIVE `scraplify` database
 * while comparing as `127.0.0.1:5432` against the live `127.0.0.1:5432/
 * scraplify` — different strings, same database, write gate open. Verified
 * against this machine's own Postgres, not reasoned about. The first version
 * of this guard (whole-branch review, 2026-09-08) closed the "omitted
 * DATABASE_URL" door and left this one open, which is why the check now fails
 * closed on anything it cannot read rather than on the one case that was found.
 */
function databaseIdentity(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
    const port = parsed.port === '' ? '5432' : parsed.port;
    const database = parsed.pathname.replace(/^\//, '');
    if (database === '') return null;
    return `${host}:${port}/${database}`;
  } catch {
    return null;
  }
}

if (profile === 'qa') {
  // The disposable-copy profile, overlaid on .env so it only states what
  // differs: DATABASE_URL and the write gate. Writes are never enabled against
  // the live corpus — see references/browser-qa.md §1.
  const file = path.join(repoRoot, '.env.qa');
  if (!fs.existsSync(file)) {
    console.error(`scripts/next.mjs: --profile qa requires ${file}, which does not exist.`);
    process.exit(1);
  }

  // The live target, captured BEFORE the overlay replaces it.
  const liveUrl = process.env.DATABASE_URL;
  const overlay = readEnvFile(file);
  const qaUrl = overlay.DATABASE_URL;

  // Fail closed. This profile's entire purpose is that writes happen against a
  // copy nobody minds losing, and until now nothing checked that the copy was
  // one: an .env.qa that omitted DATABASE_URL inherited the live corpus from
  // .env and then opened the write gate on it — the exact accident this
  // profile exists to prevent, arrived at by editing the file that prevents
  // it. The launcher claimed "writes are never enabled against the live
  // corpus" while enforcing nothing (whole-branch review, 2026-09-08).
  if (!qaUrl) {
    console.error(
      `scripts/next.mjs: ${file} must set DATABASE_URL. Without it the QA profile would enable ` +
        'writes against the database in .env, which is the live corpus.',
    );
    process.exit(1);
  }

  const qaIdentity = databaseIdentity(qaUrl);
  if (qaIdentity === null) {
    console.error(
      `scripts/next.mjs: DATABASE_URL in ${file} must be a connection string that names its ` +
        'database explicitly, as postgres://user:password@host:5432/scraplify_qa. A URL with no ' +
        'database path does not mean "no database": node-postgres falls back to the user name, ' +
        'so it can silently open the live corpus while looking different from .env.',
    );
    process.exit(1);
  }

  // Fail closed on the LIVE side too. If .env's URL does not name its database
  // either, this guard cannot prove the two differ — and "cannot prove" must
  // not read as "they differ", which is exactly how a null identity would
  // behave in the comparison below if it were left to it.
  if (liveUrl !== undefined) {
    const liveIdentity = databaseIdentity(liveUrl);
    if (liveIdentity === null) {
      console.error(
        "scripts/next.mjs: .env's DATABASE_URL does not name its database explicitly, so there " +
          `is no way to prove ${file} points at a different one. Name the database in .env's ` +
          'URL before using the QA profile, which enables writes.',
      );
      process.exit(1);
    }
    if (qaIdentity === liveIdentity) {
      console.error(
        `scripts/next.mjs: ${file} points at the same database as .env (${qaIdentity}). ` +
          'The QA profile enables writes, so it must target a disposable copy — see ' +
          '.env.qa.example for how to make one.',
      );
      process.exit(1);
    }
  }

  Object.assign(process.env, overlay);
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
