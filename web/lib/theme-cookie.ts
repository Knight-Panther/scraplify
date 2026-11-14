/**
 * The site's colour theme (Phase 16A), shared by the server, which reads the
 * cookie to paint the first frame right, and the header switch, which writes
 * it. No server imports here, so the client switch can use it too.
 *
 * Light unless the visitor chose dark (owner decision, 2026-11-14): a first
 * visit, a crawler and a link preview all get light. The choice is kept for a
 * year in a cookie, not in `localStorage`, so the server renders
 * `<html data-theme>` itself and the page never flashes the other theme.
 */
export type Theme = 'light' | 'dark';

export const THEME_COOKIE = 'xtelo-theme';

/** One year, in seconds. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Anything but the exact word "dark" is light, a missing or tampered cookie included. */
export function parseTheme(value: string | undefined | null): Theme {
  return value === 'dark' ? 'dark' : 'light';
}

/** The `Set-Cookie`-style string the switch writes through `document.cookie`. */
export function themeCookieString(theme: Theme, secure: boolean): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax${
    secure ? '; Secure' : ''
  }`;
}

/** The browser chrome's colour (`theme-color`), each theme's page ground. */
export const THEME_COLOR: Record<Theme, string> = {
  dark: '#07090b',
  light: '#f4f5f1',
};
