import { notFound, redirect } from 'next/navigation.js';
import { cache } from 'react';
import type { Session } from 'next-auth';
import { auth } from '../auth.js';
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
export const requireAdmin = cache(async (): Promise<Session> => {
  const session = await auth();
  const decision = resolveAdminAccess(session);
  if (decision === 'allow') return session as Session;
  if (decision === 'signin') redirect('/api/auth/signin');
  notFound();
});
