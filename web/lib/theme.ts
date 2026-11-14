import { cookies } from 'next/headers.js';
import { parseTheme, THEME_COOKIE, type Theme } from './theme-cookie.js';

/**
 * The visitor's theme, from their cookie: light unless they chose dark. Read
 * by the root layout for `<html data-theme>` and the browser chrome's colour.
 *
 * Reading a cookie here varies no cache: every page is rendered per request
 * (`dynamic = 'force-dynamic'` in the root layout), nothing in front of the app
 * caches HTML (Caddy sets no cache headers and Cloudflare is DNS-only), and
 * `lib/cached.ts` holds query answers, never rendered markup.
 */
export async function currentTheme(): Promise<Theme> {
  const store = await cookies();
  return parseTheme(store.get(THEME_COOKIE)?.value);
}
