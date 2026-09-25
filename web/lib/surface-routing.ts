/**
 * Pure path-matching rules for `proxy.ts`'s surface allow-listing (Phase 8B
 * Stage 6, concept §30.2). Kept separate from `proxy.ts` itself — which
 * needs `next/server` and `./auth.js` — so this decision logic is directly
 * unit-testable with no Next.js runtime involved at all.
 */

function pathIs(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * `public` surface: exactly the routes concept §30.1 defines its nav around,
 * plus the matching-bundle endpoints (Phase 8C) the browser matcher fetches:
 * `/api/matching/manifest` and `/api/matching/bundles/<id>/<file>`, and the
 * browser-only CV Ranked page that uses them (Phase 8D).
 */
export function isPublicRoute(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathIs(pathname, '/opportunities') ||
    pathIs(pathname, '/listings') ||
    pathIs(pathname, '/cv-ranked') ||
    pathIs(pathname, '/api/matching')
  );
}

/**
 * The sign-in flow itself — deliberately unauthenticated. Requiring a
 * session to reach the route that creates one would lock every admin out.
 */
export function isAdminAuthRoute(pathname: string): boolean {
  return pathIs(pathname, '/api/auth');
}

/** Everything else on the `admin` surface, gated behind the real `auth()` check. */
export function isAdminDashboardRoute(pathname: string): boolean {
  return pathIs(pathname, '/admin');
}

/**
 * This repo's small, fixed set of root-level public static files — checked
 * by exact path, not by a "does this look like a filename" heuristic. A
 * heuristic (any path segment containing a dot) was tried first and
 * rejected: this app's own crawl sources are named `jobs.ge`/`hr.ge`, so a
 * real future admin route like `/admin/sources/jobs.ge` would itself look
 * like a static asset to that heuristic and skip the proxy's surface/auth
 * check entirely (surface-boundary-reviewer, 2026-09-24). Add a new public
 * file here when one is added under `web/public/` or as an `app/`-level
 * metadata file (icon, favicon, etc).
 */
const STATIC_ASSET_PATHS: ReadonlySet<string> = new Set(['/logo.png', '/hero-bg.mp4', '/icon.svg']);

export function isStaticAssetRoute(pathname: string): boolean {
  return STATIC_ASSET_PATHS.has(pathname);
}

export type AdminAccessDecision = 'allow' | 'deny' | 'signin';

/**
 * What `proxy.ts`'s admin `auth(...)` callback does with a session — pulled
 * out as a pure function so the distinction that actually matters is
 * unit-testable without a real Auth.js session or a live server: a
 * genuinely ABSENT session redirects to sign-in (the entry point, not a
 * denial), but a session that exists and simply isn't allowlisted must
 * `deny` (a 404 — `docs/scraplify-concept.md:1227`: "Every disallowed route
 * returns 404"), never `signin` again — redirecting an already-authenticated
 * non-admin back to sign-in just replays their valid GitHub session and
 * lands them right back here, an infinite loop (Codex, 2026-09-24).
 */
export function resolveAdminAccess(
  session: { user?: { isAdmin?: boolean } } | null | undefined,
): AdminAccessDecision {
  if (session?.user?.isAdmin) return 'allow';
  if (session) return 'deny';
  return 'signin';
}
