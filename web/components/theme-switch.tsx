'use client';

import { useSyncExternalStore } from 'react';
import type { Locale } from '../lib/locale.js';
import { parseTheme, THEME_COLOR, type Theme, themeCookieString } from '../lib/theme-cookie.js';

/**
 * The header's sun and moon switch (Phase 16A). On means dark.
 *
 * A click sets `<html data-theme>` at once, so every colour token flips in
 * the same frame, and writes the `xtelo-theme` cookie, which the root layout
 * reads on the next page load: no server round trip, no reload, and no
 * flash. A 320 ms fade runs across the page unless the visitor asked for
 * reduced motion (`globals.css`, `html.theming`).
 *
 * The attribute on `<html>` is the one source of truth: each switch on the
 * page (there is one in the bar at every width) reads it through
 * `useSyncExternalStore`, so they never disagree. The server snapshot is the
 * theme the server rendered, so hydration matches.
 */
export function ThemeSwitch({ initial, locale }: { initial: Theme; locale: Locale }) {
  const theme = useSyncExternalStore(subscribe, readTheme, () => initial);
  const dark = theme === 'dark';
  const label = locale === 'ka' ? 'მუქი თემა' : 'Dark theme';
  const title =
    locale === 'ka'
      ? dark
        ? 'ღია თემაზე გადართვა'
        : 'მუქ თემაზე გადართვა'
      : dark
        ? 'Switch to the light theme'
        : 'Switch to the dark theme';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={label}
      title={title}
      onClick={() => applyTheme(dark ? 'light' : 'dark')}
      className="relative inline-flex h-8 w-16 flex-none cursor-pointer items-center rounded-2xl border-[1.5px] border-ink bg-transparent p-0 text-ink hover:bg-ink/6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      <span
        aria-hidden="true"
        className={`absolute top-[2px] left-[2px] size-[25px] rounded-full bg-ink transition-transform duration-[260ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] ${
          dark ? 'translate-x-8' : 'translate-x-0'
        }`}
      />
      <SunIcon className={`relative mx-[7.5px] size-4 ${dark ? '' : 'text-header'}`} />
      <MoonIcon className={`relative mx-[7.5px] size-4 ${dark ? 'text-header' : ''}`} />
    </button>
  );
}

function readTheme(): Theme {
  return parseTheme(document.documentElement.dataset.theme);
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}

function applyTheme(next: Theme): void {
  const root = document.documentElement;
  const fade = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (fade) root.classList.add('theming');
  root.dataset.theme = next;
  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is still missing from some browsers this site serves, and the cookie has to exist before the next request so the server paints that page in the chosen theme
  document.cookie = themeCookieString(next, window.location.protocol === 'https:');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[next]);
  if (fade) window.setTimeout(() => root.classList.remove('theming'), 320);
}

function SunIcon({ className }: { className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon({ className }: { className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />
    </svg>
  );
}
