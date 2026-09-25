/**
 * The runtime-surface selector (concept §30.2).
 *
 * `XTELO_SURFACE` picks which of three processes this instance is: `local`
 * (today's default — every route reachable, no auth, the operator's own
 * workflow), `public` (the hosted catalogue, no admin or write-capable
 * credential), or `admin` (the operator's hosted dashboard, behind real
 * auth). Unset means `local`, matching the single undifferentiated surface
 * this app has always been until Phase 8B splits it apart.
 *
 * Fails closed on anything else: a typo'd or otherwise unrecognized value
 * must not silently resolve to the most permissive surface (`local`) or to
 * any other guess. Better to refuse to start than to run an instance under a
 * surface nobody chose.
 */

export type Surface = 'local' | 'public' | 'admin';

const SURFACES: ReadonlySet<string> = new Set(['local', 'public', 'admin']);

export class InvalidSurfaceError extends Error {
  readonly code = 'INVALID_SURFACE';

  constructor(value: string) {
    super(
      `XTELO_SURFACE=${JSON.stringify(value)} is not one of 'local', 'public', 'admin'. ` +
        'Unset it to default to local, or set it to one of those exact values.',
    );
    this.name = 'InvalidSurfaceError';
  }
}

/** Throws unless `XTELO_SURFACE` is unset or one of the three valid values. */
export function currentSurface(): Surface {
  const raw = process.env.XTELO_SURFACE;
  if (raw === undefined) return 'local';
  if (!SURFACES.has(raw)) throw new InvalidSurfaceError(raw);
  return raw as Surface;
}

export class NotLocalSurfaceError extends Error {
  readonly code = 'NOT_LOCAL_SURFACE';

  constructor() {
    super(
      'This action is only reachable on the local surface (XTELO_SURFACE=local or unset). ' +
        'It authorizes by surface, not by user identity, so it refuses unconditionally on ' +
        'public or admin.',
    );
    this.name = 'NotLocalSurfaceError';
  }
}

/**
 * Throws unless this process is running as the local surface. Call FIRST in
 * every Server Action that belongs to the operator's local-only workflow —
 * a Server Action is independently reachable by a direct request regardless
 * of which page nominally renders it, so a proxy/layout check alone is not
 * authorization for it (the same principle `assertWritesEnabled()` in
 * `web/lib/writes.ts` already applies to writes specifically).
 */
export function assertLocalSurface(): void {
  if (currentSurface() !== 'local') throw new NotLocalSurfaceError();
}
