import { type NextFetchEvent, type NextRequest, NextResponse } from 'next/server';
import NextAuth, { type NextAuthRequest, type NextAuthResult } from 'next-auth';
import authConfig from './auth.config.js';
import { contentSecurityPolicy, createNonce } from './lib/security-headers.js';
import { currentSurface } from './lib/surface.js';
import {
  isAdminAuthRoute,
  isAdminDashboardRoute,
  isProbeRoute,
  isPublicRoute,
  isStaticAssetRoute,
  resolveAdminAccess,
} from './lib/surface-routing.js';

/**
 * A SEPARATE `NextAuth(...)` instance from `auth.ts`'s, built directly from
 * the edge-compatible `authConfig` rather than importing `auth.ts` itself.
 * Auth.js's own migration guide splits `auth.config.ts` out specifically so
 * `proxy.ts` never has to bundle whatever Node-only dependency (an adapter,
 * today none, but `auth.ts`'s own contract explicitly permits adding one)
 * ends up in the full config — importing `{ auth } from './auth.js'` instead
 * would have quietly defeated that split (surface-boundary-reviewer,
 * 2026-09-24): correct today only because `auth.ts` happens to add nothing
 * Node-only yet, and one Node-only addition there away from breaking this
 * file's own Edge-runtime load with no signal until it did.
 */
const authResult: NextAuthResult = NextAuth({ trustHost: true, ...authConfig });
const auth: NextAuthResult['auth'] = authResult.auth;

/**
 * Optimistic surface allow-listing (concept §30.2, Phase 8B Stage 6).
 *
 * Branches on the request path BEFORE touching Auth.js at all. `public`
 * requests never reach `auth(...)` at all, and `local` only reaches it via
 * `/api/auth/*` being explicitly refused below (not by touching Auth.js) —
 * by design, those two processes hold no `AUTH_SECRET` or provider
 * credential, so the simple `export const proxy = auth(...)` wrapper Auth.js's
 * own docs show as the default pattern would run Auth.js's own config
 * validation (which checks for exactly those env vars) on every request,
 * including ones from surfaces that deliberately never have them. Only a
 * request that is BOTH on the `admin` surface AND under `/admin*` reaches
 * the real `auth(...)`-wrapped check below; `/api/auth/*` itself is left
 * unauthenticated on `admin` on purpose (it is the sign-in flow — requiring
 * a session to reach the route that creates one is a lockout, not a
 * boundary) but is refused outright on `local`, which has no legitimate use
 * for it (no admin login flow exists there) and would otherwise compile a
 * live, broken `/api/auth/*` endpoint into every local instance that fails
 * at Auth.js's own config validation instead of never being reached
 * (surface-boundary-reviewer, 2026-09-24).
 *
 * This is still only a UX optimization reading a cookie, never a database
 * (per Next's own authentication guide, confirmed via Context7) — the real
 * boundary is Stage 8's `requireAdmin()` at the data layer.
 */

function refuse(): NextResponse {
  return new NextResponse(null, { status: 404 });
}

export default async function proxy(req: NextRequest, event: NextFetchEvent) {
  const surface = currentSurface();
  const { pathname } = req.nextUrl;

  // Checked before any surface branch — assets are never sensitive on any
  // surface, and an exact allowlist here means the matcher below never has
  // to guess by file extension (see its own comment for why that guess is
  // unsafe in this app specifically).
  if (isStaticAssetRoute(pathname) || isProbeRoute(pathname)) return NextResponse.next();

  // Phase 8E: every other response carries a per-request CSP. The request
  // copy is how Next finds the nonce to stamp on its own scripts while
  // rendering; the response copy is what the browser enforces.
  const csp = contentSecurityPolicy({
    nonce: createNonce(),
    surface,
    dev: process.env.NODE_ENV === 'development',
  });
  const response = await route(req, event, surface, pathname, csp);
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

async function route(
  req: NextRequest,
  event: NextFetchEvent,
  surface: ReturnType<typeof currentSurface>,
  pathname: string,
  csp: string,
): Promise<Response> {
  const pass = (): NextResponse => {
    const headers = new Headers(req.headers);
    headers.set('Content-Security-Policy', csp);
    return NextResponse.next({ request: { headers } });
  };

  if (surface === 'local') {
    return isAdminAuthRoute(pathname) ? refuse() : pass();
  }

  if (surface === 'public') {
    return isPublicRoute(pathname) ? pass() : refuse();
  }

  // admin
  if (isAdminAuthRoute(pathname)) return pass();
  if (!isAdminDashboardRoute(pathname)) return refuse();

  // Explicitly 2-parameter and typed to match `NextAuthMiddleware` (an
  // internal next-auth type, not re-exported): a 1-parameter callback is
  // structurally assignable to `AppRouteHandlerFn`'s 2-parameter shape too,
  // which made TS pick that overload instead and return the wrong result
  // type entirely.
  return auth((authedReq: NextAuthRequest, _event: NextFetchEvent) => {
    const decision = resolveAdminAccess(authedReq.auth);
    if (decision === 'allow') return pass();
    if (decision === 'deny') return refuse();
    // Includes the query string, not just pathname — a deep link like
    // `/admin/taxonomy?text=manager&show=100` would otherwise silently drop
    // its filters/pagination on the round trip through sign-in (Codex,
    // 2026-09-24). Same-origin by construction (built from this request's
    // own URL), so this isn't an open-redirect vector.
    const signInUrl = new URL('/api/auth/signin', req.url);
    signInUrl.searchParams.set('callbackUrl', pathname + req.nextUrl.search);
    return NextResponse.redirect(signInUrl);
  })(req, event);
}

export const config = {
  // Excludes only `_next/static` and `_next/image` — Next's own internal,
  // always-safe paths. Next's own bundled Proxy guide's simplest example
  // also excludes any path with a file extension, but that's a heuristic
  // ("does the last segment contain a dot"), and this app's own crawl
  // sources are named `jobs.ge`/`hr.ge`: a real admin route like
  // `/admin/sources/jobs.ge` would look like a static asset to that
  // heuristic and skip proxy() — surface/auth check included — entirely
  // (surface-boundary-reviewer, 2026-09-24). This repo's actual public
  // assets are instead an explicit allowlist inside proxy() itself
  // (`isStaticAssetRoute`), checked before any surface branch.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
