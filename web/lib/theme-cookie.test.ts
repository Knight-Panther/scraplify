import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseTheme,
  THEME_COLOR,
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  themeCookieString,
} from './theme-cookie.js';

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('parseTheme', () => {
  it('is light unless the cookie says exactly "dark"', () => {
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    // A first visit, a crawler and a tampered cookie all get light.
    for (const value of [undefined, null, '', 'DARK', 'dark ', 'auto', '<script>']) {
      expect(parseTheme(value)).toBe('light');
    }
  });
});

describe('themeCookieString', () => {
  it('keeps the choice for a year, site-wide, same-site lax', () => {
    expect(themeCookieString('dark', false)).toBe(
      `${THEME_COOKIE}=dark; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`,
    );
    expect(THEME_COOKIE_MAX_AGE).toBe(31_536_000);
  });

  it('is Secure over https only, so the local http servers still keep it', () => {
    expect(themeCookieString('light', true)).toMatch(/; Secure$/);
    expect(themeCookieString('light', false)).not.toMatch(/Secure/);
  });
});

/** Every `--color-*` declared in a CSS block, with its value. */
function colorTokens(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/(--color-[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [
      m[1] as string,
      (m[2] as string).trim(),
    ]),
  );
}

describe('the colour set (globals.css)', () => {
  const css = readFileSync(path.join(webRoot, 'app', 'globals.css'), 'utf8');
  const dark = colorTokens(css.slice(css.indexOf('@theme static {'), css.indexOf('@keyframes')));
  const lightAt = css.indexOf(':root[data-theme="light"] {');
  const light = colorTokens(css.slice(lightAt, css.indexOf('}', lightAt)));
  // The same in both themes by design: the lime fill, the ink on it, the
  // header's yellow.
  const SAME_IN_BOTH = ['--color-brand', '--color-ink', '--color-header'];

  it('gives every colour a light value, or names it as the same in both', () => {
    expect(dark.size).toBeGreaterThan(20);
    const missing = [...dark.keys()].filter((t) => !light.has(t) && !SAME_IN_BOTH.includes(t));
    expect(missing).toEqual([]);
    const strays = [...light.keys()].filter((t) => !dark.has(t));
    expect(strays).toEqual([]);
  });

  it("matches the browser chrome colour to each theme's page ground", () => {
    expect(dark.get('--color-background')).toBe(THEME_COLOR.dark);
    expect(light.get('--color-background')).toBe(THEME_COLOR.light);
  });

  it('has no component naming a colour of its own', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== 'node_modules' && name !== '.next') walk(full);
        } else if (name.endsWith('.tsx')) {
          const source = readFileSync(full, 'utf8');
          // The retired second family, a raw hex, or Tailwind's own palette.
          if (
            /color-browse-|#[0-9a-fA-F]{3,8}\b|\b(?:text|bg|border)-(?:white|black)\b/.test(source)
          ) {
            offenders.push(path.relative(webRoot, full));
          }
        }
      }
    };
    walk(path.join(webRoot, 'app'));
    walk(path.join(webRoot, 'components'));
    expect(offenders).toEqual([]);
  });
});
