import { cvRankedEnabled } from '../lib/cv-ranked/availability.js';
import { currentLocale } from '../lib/locale.js';
import { currentSurface } from '../lib/surface.js';
import { databaseLabel, writesEnabled } from '../lib/writes.js';
import { SiteHeaderNav } from './site-header-nav.js';

/**
 * The one header, used by every screen via the root layout.
 *
 * A server component so `databaseLabel()`/`writesEnabled()`/`currentLocale()`
 * /`currentSurface()` — all four read server-only state (env vars, a
 * cookie) — stay server-only. Only the active-link highlighting and the
 * mobile menu need the current pathname and open/closed state, so that piece
 * alone (`SiteHeaderNav`) is the client component; it receives the
 * server-derived values as plain props rather than reading them itself,
 * which is what a hydration mismatch here looked like the first time (see
 * `site-header-nav.tsx`'s own note).
 */
export async function SiteHeader() {
  const locale = await currentLocale();
  const surface = currentSurface();
  // Computed only for the surface allowed to see them, not just rendered
  // conditionally: a value passed to a Client Component is serialized into
  // the RSC payload regardless of whether that component's JSX ends up
  // displaying it, so gating only in SiteHeaderNav's render would still ship
  // the real database name and write-mode flag to a public visitor's
  // browser (Codex, 2026-09-24).
  const dbLabel = surface === 'local' ? databaseLabel() : '';
  const writesOn = surface === 'local' ? writesEnabled() : false;
  return (
    <SiteHeaderNav
      dbLabel={dbLabel}
      writesOn={writesOn}
      locale={locale}
      surface={surface}
      cvRanked={cvRankedEnabled()}
    />
  );
}
