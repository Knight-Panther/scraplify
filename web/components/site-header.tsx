import { currentLocale } from '../lib/locale.js';
import { databaseLabel, writesEnabled } from '../lib/writes.js';
import { SiteHeaderNav } from './site-header-nav.js';

/**
 * The one header, used by every screen via the root layout.
 *
 * A server component so `databaseLabel()`/`writesEnabled()`/`currentLocale()`
 * — all three read server-only state (env vars, a cookie) — stay
 * server-only. Only the active-link highlighting and the mobile menu need
 * the current pathname and open/closed state, so that piece alone
 * (`SiteHeaderNav`) is the client component; it receives the server-derived
 * values as plain props rather than reading them itself, which is what a
 * hydration mismatch here looked like the first time (see
 * `site-header-nav.tsx`'s own note).
 */
export async function SiteHeader() {
  const locale = await currentLocale();
  return <SiteHeaderNav dbLabel={databaseLabel()} writesOn={writesEnabled()} locale={locale} />;
}
