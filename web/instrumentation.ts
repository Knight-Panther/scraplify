import { parseAdminGithubIds } from './auth.config.js';
import { currentSurface } from './lib/surface.js';

/**
 * Runs once when the Next.js server starts, before it handles any request
 * (both Node and Edge runtime — Next's own `instrumentation.js` contract).
 *
 * `web/lib/surface.ts`'s `currentSurface()` is otherwise unused until later
 * Phase 8B stages wire real surface-specific behavior to it (Stage 6's
 * `proxy.ts`, Stage 8's admin layout). Without a call here, a mistyped
 * `XTELO_SURFACE` would fail nothing at all — every route still served,
 * every guard this phase adds still absent — which is silent-open, the exact
 * opposite of the "fail closed on anything else" this env var promises.
 * Calling it here means an invalid value crashes the server before it ever
 * accepts a request, the same "refuse to start" posture
 * `scripts/next.mjs`'s own QA-profile validation already uses.
 */

// Everything `auth.config.ts`'s GitHub provider and admin allowlist need.
// Auth.js itself would only discover a missing one lazily, the first time a
// request actually reaches it — refusing to start the whole admin process
// instead is the same "fail closed on anything else" posture as the surface
// check above, applied to the one surface that can grant real access.
const REQUIRED_ADMIN_ENV_VARS = [
  'AUTH_GITHUB_ID',
  'AUTH_GITHUB_SECRET',
  'AUTH_SECRET',
  'ADMIN_GITHUB_IDS',
] as const;

// `openssl rand -base64 32` (Auth.js's own recommended generator) produces
// 44 characters. This floor doesn't verify real entropy — a 32-character
// string of the same repeated letter would still pass — but it does reject
// the actual failure mode found live: a short placeholder like `AUTH_SECRET=x`
// started the admin process successfully, at which point Auth.js accepts it
// too (it only checks non-empty), and an attacker who guessed it could mint
// a session token carrying an allowlisted GitHub id and get `isAdmin: true`
// (surface-boundary-reviewer, 2026-09-24).
const MIN_AUTH_SECRET_LENGTH = 32;

export function register(): void {
  const surface = currentSurface();
  if (surface !== 'admin') return;

  const missing = REQUIRED_ADMIN_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `XTELO_SURFACE=admin requires ${REQUIRED_ADMIN_ENV_VARS.join(', ')} to all be set, but ` +
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing. Refusing to start ` +
        'rather than run an admin surface nobody can actually authenticate against.',
    );
  }

  const secretLength = process.env.AUTH_SECRET?.length ?? 0;
  if (secretLength < MIN_AUTH_SECRET_LENGTH) {
    throw new Error(
      `AUTH_SECRET is ${secretLength} character(s), below the ${MIN_AUTH_SECRET_LENGTH}-character ` +
        'floor this refuses to start under. Generate one with `openssl rand -base64 32` or ' +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"` — a " +
        'short or guessable value defeats the signature every admin session depends on.',
    );
  }

  // `ADMIN_GITHUB_IDS=,` (or any value that parses to zero entries) passes a
  // bare non-empty check but produces an admin surface nobody can ever sign
  // into — and a non-numeric entry (a username instead of GitHub's numeric
  // id, which is what the allowlist actually checks against) would silently
  // never match anyone either. Both are real misconfigurations worth
  // refusing at startup rather than discovering the first time someone
  // tries to sign in and can't (surface-boundary-reviewer, 2026-09-24).
  const adminIds = parseAdminGithubIds(process.env.ADMIN_GITHUB_IDS ?? '');
  if (adminIds.length === 0) {
    throw new Error(
      'ADMIN_GITHUB_IDS is set but parses to zero entries — it must contain at least one ' +
        'GitHub numeric user id. This would otherwise start an admin surface nobody can ' +
        'authenticate into.',
    );
  }
  const nonNumeric = adminIds.filter((id) => !/^\d+$/.test(id));
  if (nonNumeric.length > 0) {
    throw new Error(
      `ADMIN_GITHUB_IDS contains non-numeric entries: ${nonNumeric.join(', ')}. This allowlist ` +
        "checks GitHub's immutable numeric user id, not a username — look it up at " +
        'https://api.github.com/users/<username> (the `id` field).',
    );
  }
}
