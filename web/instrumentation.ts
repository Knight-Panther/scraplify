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
export function register(): void {
  currentSurface();
}
