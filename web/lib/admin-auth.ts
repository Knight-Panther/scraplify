import { notFound, redirect } from 'next/navigation.js';
import { cache } from 'react';
import type { Session } from 'next-auth';
import { auth } from '../auth.js';
import { currentSurface } from './surface.js';
import { resolveAdminAccess } from './surface-routing.js';

/**
 * No `server-only` import: this repo has no existing dependency on that
 * package (confirmed — nothing else in `web/` imports it), and this module
 * is already only ever reachable from a Server Component or Server Action
 * that itself cannot be bundled for the client (it imports `../auth.js`,
 * which pulls in next-auth's own Node-only internals) — the same implicit
 * guarantee `src/db/client.ts` already relies on elsewhere in this codebase.
 *
 * The Stage 8 DAL boundary (concept §30.2, change.md §13) — the ACTUAL
 * authorization check, independent of `proxy.ts`'s own. Next's own
 * authentication guide: "the majority of security checks should be
 * performed as close as possible to your data source" — `proxy.ts` reads
 * only a cookie and is documented there as a UX optimization, never a
 * security boundary on its own.
 *
 * Reuses `resolveAdminAccess` — the exact same allow/deny/signin decision
 * `proxy.ts`'s own admin branch uses, unit-tested there
 * (`surface-routing.test.ts`) — rather than re-deriving the "authenticated
 * but not admin must 404, never redirect to sign-in" rule a second time:
 * redirecting would replay an already-valid non-admin GitHub session
 * straight back to this same check, the exact infinite-loop shape a Codex
 * review found in `proxy.ts` (2026-09-24).
 *
 * `redirect()`/`notFound()` both work from a Server Component render AND a
 * Server Action (confirmed against this repo's own bundled Next docs), so
 * one function serves both call sites the plan asks for — "called first in
 * every admin page, Server Action and Route Handler."
 *
 * `cache()`-wrapped (React's per-request memoization, the same wrapper
 * Next's own DAL example uses for `verifySession()`) so multiple calls
 * within one request/render share a single `auth()` decode rather than
 * re-verifying the session JWT on every call.
 */
/**
 * A `notFound()`/`redirect()` thrown by `requireAdmin()`, carrying who (if
 * anyone) was denied — Stage 11's admin audit trail needs this to record a
 * `refused` row's actor, and `notFound()`/`redirect()` themselves carry no
 * such context. `null` for a genuinely unauthenticated attempt (nothing to
 * name) or a `signin` redirect (not a denial at all).
 */
export interface DeniedError extends Error {
  deniedActorGithubId: string | null;
}

export function isDeniedError(error: unknown): error is DeniedError {
  return error instanceof Error && 'deniedActorGithubId' in error;
}

export const requireAdmin = cache(async (): Promise<Session> => {
  // Off the `admin` surface, this process never has an `AUTH_SECRET` (Auth.js
  // config deliberately omits one for `local`/`public` — see `auth.config.ts`)
  // so `auth()` itself throws `MissingSecret` rather than resolving `null`.
  // `proxy.ts` already lets `/admin*` through unchecked on `local` (it is
  // "UX only" there — this function is the real boundary), so a direct
  // request can reach here with no session and no secret; failing closed by
  // surface first, before ever calling `auth()`, turns that into the same
  // clean 404 a denied session gets rather than an unhandled crash (Codex,
  // 2026-09-24). No actor to attach — off-surface means no session was even
  // attempted.
  if (currentSurface() !== 'admin') notFound();
  const session = await auth();
  const decision = resolveAdminAccess(session);
  if (decision === 'allow') return session as Session;
  if (decision === 'signin') redirect('/api/auth/signin');
  // decision === 'deny': notFound() throws synchronously — caught here only
  // to attach the denied actor's id before re-throwing the SAME error
  // object, so its `digest` (what Next's own rendering actually keys on)
  // stays exactly what notFound() produced.
  try {
    notFound();
  } catch (error) {
    throw Object.assign(error as Error, {
      deniedActorGithubId: session?.user.githubId ?? null,
    } satisfies Pick<DeniedError, 'deniedActorGithubId'>);
  }
});
