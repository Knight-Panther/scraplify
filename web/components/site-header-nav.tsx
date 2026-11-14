'use client';

import { usePathname } from 'next/navigation.js';
import { signOutAction, toggleLocale } from '../app/actions.js';
import type { Locale } from '../lib/locale.js';
import type { Surface } from '../lib/surface.js';
import type { Theme } from '../lib/theme-cookie.js';
import { ThemeSwitch } from './theme-switch.js';

/**
 * The site's nav links, one list shared by the desktop bar and the mobile
 * menu — a second, hand-kept copy is exactly how the two drifted before
 * (`SiteNav` had six links, the browse screen's one-off header had four).
 *
 * No entry for `/` itself (Phase 3E, 2026-09-15) — it is the landing page
 * now, not a "Design system" reference screen, and the wordmark link
 * (the logo image, below) already goes there; a second link to the same
 * destination in the nav proper would be redundant, not a real page in
 * its own right the way every other entry here is.
 *
 * Labels only — this cookie (`lib/locale.ts`) is still read by `/` alone,
 * so a Georgian nav label currently points at a screen whose own body is
 * still English (a known, scoped-down gap: translating those seven screens'
 * actual content — data tables, filters, `labels.ts`'s enum copy — is a
 * separate, much larger effort than this nav strip).
 */
const NAV_EN = [
  { href: '/opportunities', label: 'Browse' },
  { href: '/listings', label: 'Listings' },
  { href: '/real-estate', label: 'Real estate' },
  { href: '/cv-ranked', label: 'CV Ranked' },
  { href: '/profile', label: 'Profile' },
  { href: '/ranked', label: 'Ranked' },
  { href: '/drafts', label: 'Drafts' },
  { href: '/saved', label: 'Shortlist' },
  { href: '/review', label: 'Duplicate review' },
  { href: '/taxonomy-review', label: 'Taxonomy review' },
  { href: '/health', label: 'Source health' },
] as const;

const NAV_KA = [
  { href: '/opportunities', label: 'ვაკანსიები' },
  { href: '/listings', label: 'განცხადებები' },
  { href: '/real-estate', label: 'უძრავი ქონება' },
  { href: '/cv-ranked', label: 'CV რანჟირება' },
  { href: '/profile', label: 'პროფილი' },
  { href: '/ranked', label: 'რანჟირება' },
  { href: '/drafts', label: 'მონახაზები' },
  { href: '/saved', label: 'შენახულები' },
  { href: '/review', label: 'დუბლიკატების შემოწმება' },
  { href: '/taxonomy-review', label: 'კატეგორიების შემოწმება' },
  { href: '/health', label: 'წყაროების მდგომარეობა' },
] as const;

/**
 * The `admin` surface's own nav (Stage 8) — none of `NAV_EN`/`NAV_KA`'s links
 * exist there (`proxy.ts` 404s everything outside `/admin*`/`/api/auth*` on
 * this surface), and `admin` is an ops dashboard for the one operator, not a
 * bilingual product surface, so it gets one fixed English list rather than a
 * locale variant. English only, deliberately: nothing about this list
 * interacts with the `lib/locale.ts` cookie the way `NAV_EN`/`NAV_KA` do.
 */
const NAV_ADMIN = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/sources', label: 'Sources' },
  { href: '/admin/duplicates', label: 'Duplicates' },
  { href: '/admin/taxonomy', label: 'Taxonomy' },
  { href: '/admin/matching', label: 'Matching' },
] as const;

/**
 * Client only for what genuinely needs the browser: which link is "active"
 * (needs the current pathname), the mobile menu's open state, and the theme
 * switch. `dbLabel`/`writesOn`/`surface`/`theme` are passed in from the
 * server parent (`site-header.tsx`) rather than computed here: computing
 * server-only values again on the client once produced a real hydration
 * mismatch ("scraplify" on the server, "no database" on the client).
 *
 * The bar is the Phase 16 design (`docs/PHASE_16_PLAN.md`): yellow in both
 * themes, the logo, the links as plain ink words with the current page an
 * ink pill, then the database badge (local only), the theme switch, the
 * language and, below the width the links fit in, the menu button.
 */
export function SiteHeaderNav({
  dbLabel,
  writesOn,
  locale,
  surface,
  cvRanked,
  theme,
}: {
  dbLabel: string;
  writesOn: boolean;
  locale: Locale;
  surface: Surface;
  /** False while `XTELO_CV_RANKED=off` (Phase 8E rollback switch). */
  cvRanked: boolean;
  /** The theme the server painted, from the visitor's cookie. */
  theme: Theme;
}) {
  const pathname = usePathname();
  // Exact match for both root links ('/' and admin's own '/admin'
  // dashboard): otherwise `startsWith` also matches every child route
  // (`/admin/sources`, ...), highlighting two nav items at once (Codex,
  // 2026-09-24).
  const isActive = (href: string) =>
    href === '/' || href === '/admin' ? pathname === href : (pathname?.startsWith(href) ?? false);
  const navFull = locale === 'ka' ? NAV_KA : NAV_EN;
  // Public hosted nav is `Browse | Listings | Real estate | CV Ranked` only
  // (concept §30.1 and §31; the first four entries of both lists): the other
  // links all 404 on that surface. Sliced from the same array rather than a
  // second literal list, so the two surfaces can never drift on a link they
  // share. `admin` gets its own fixed list: none of `navFull`'s links exist
  // there at all.
  const surfaceNav =
    surface === 'admin' ? NAV_ADMIN : surface === 'public' ? navFull.slice(0, 4) : navFull;
  const nav = cvRanked ? surfaceNav : surfaceNav.filter((item) => item.href !== '/cv-ranked');
  const { deskFlex, deskHidden } = deskBreakpoints(surface, locale);
  // On the yellow bar the site's lime focus ring would vanish: ink instead.
  const focusInk =
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

  return (
    <header className="relative z-30 flex h-14 items-center gap-7 bg-header px-4 text-ink min-[900px]:h-16">
      {/* Plain `<img>`, not `next/image`: a small fixed-size static header
          logo doesn't need Next's optimization pipeline, and `next/image`'s
          own shipped types don't resolve cleanly under this repo's
          `nodenext` module resolution. Explicit width/height (the real
          2172×724 asset, scaled by the `h-*`/`w-auto` classes) avoid layout
          shift. `/` is refused on the `admin` surface, so the logo goes to
          `/admin` there (Codex, 2026-09-24). */}
      <a href={surface === 'admin' ? '/admin' : '/'} className={`flex flex-none ${focusInk}`}>
        {/* biome-ignore lint/performance/noImgElement: next/image doesn't
            type-check under this repo's nodenext resolution (see comment
            above); a fixed-size static logo has no LCP/bandwidth case for
            it anyway. */}
        <img
          src="/logo.v2.webp"
          alt="Xtelo"
          width={264}
          height={88}
          className="h-[30px] w-auto min-[900px]:h-9"
        />
      </a>

      <nav aria-label="Main" className={`hidden ${deskFlex}`}>
        <ul className="flex gap-1">
          {nav.map((item) => (
            <li key={item.href}>
              <a
                href={item.href}
                aria-current={isActive(item.href) ? 'page' : undefined}
                className={`block rounded-lg px-3 py-1.5 text-[15px] font-semibold whitespace-nowrap ${focusInk} ${
                  isActive(item.href) ? 'bg-ink text-header' : 'text-ink hover:bg-ink/8'
                }`}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="ml-auto flex flex-none items-center gap-3.5">
        {/* An operator's reminder of which database this instance reads and
            whether it may write. Local only: a hosted visitor has no business
            knowing either. Shown with the inline links, where there is room. */}
        {surface === 'local' && (
          <span className={`hidden items-center gap-2 text-xs text-ink/70 ${deskFlex}`}>
            <span>{dbLabel}</span>
            <span
              title={
                writesOn
                  ? 'This instance can modify the database. It should be pointed at a disposable copy, not the live corpus.'
                  : 'Read-only. Set XTELO_WRITES_ENABLED=true against a disposable database to make changes.'
              }
              className={
                writesOn
                  ? 'rounded-full border border-ink/40 px-2 py-0.5 text-ink'
                  : 'rounded-full border border-ink/20 px-2 py-0.5 text-ink/70'
              }
            >
              {writesOn ? 'writes on' : 'read-only'}
            </span>
          </span>
        )}

        <ThemeSwitch initial={theme} locale={locale} />

        {/* `admin` has no screen that reads the language cookie, so a sign-out
            control takes the language switch's place there. Both are real
            `<form>` submits, so they work with scripting off. The language
            label shows the language a click switches INTO; "EN"/"KA" are
            codes, never translated. */}
        {surface === 'admin' ? (
          <SignOutButton
            className={`rounded-lg px-1 py-1.5 text-sm font-bold text-ink hover:bg-ink/8 ${focusInk}`}
          />
        ) : (
          <form action={toggleLocale}>
            <button
              type="submit"
              className={`rounded-lg px-1 py-1.5 text-sm font-bold text-ink hover:bg-ink/8 ${focusInk}`}
              aria-label={locale === 'ka' ? 'Switch to English' : 'Switch to Georgian'}
            >
              {locale === 'ka' ? 'EN' : 'KA'}
            </button>
          </form>
        )}

        <button
          type="button"
          popoverTarget="site-nav-mobile"
          aria-label={locale === 'ka' ? 'მენიუ' : 'Menu'}
          className={`-mr-1 flex size-10 items-center justify-center rounded-lg text-ink hover:bg-ink/8 ${focusInk} ${deskHidden}`}
        >
          <MenuIcon />
        </button>
      </div>

      {/* The menu below the width the inline links fit in. Its top follows
          the bar's own height (56px, then 64px from 900px). */}
      <div
        id="site-nav-mobile"
        popover="auto"
        className={`m-0 mt-14 ml-auto h-[calc(100vh-56px)] w-64 max-h-none overscroll-contain rounded-none border-0 border-l border-border bg-surface p-5 text-foreground min-[900px]:mt-16 min-[900px]:h-[calc(100vh-64px)] ${deskHidden}`}
      >
        <ul className="flex flex-col gap-1">
          {nav.map((item) => (
            <li key={item.href}>
              <a
                href={item.href}
                aria-current={isActive(item.href) ? 'page' : undefined}
                className={`block rounded-[var(--radius)] px-3 py-2 text-sm ${
                  isActive(item.href)
                    ? 'bg-brand font-semibold text-ink'
                    : 'text-muted hover:bg-surface-raised hover:text-foreground'
                }`}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </header>
  );
}

/**
 * The width each bar's links fit inline from: below it they move into the
 * menu. Measured in a real browser on 2026-11-14 as the natural width of
 * logo, links, badge, switch and language with the gaps and 16px sides,
 * then a page scrollbar (15px) and some room added: the public bar is 665px
 * in English and 827px in Georgian, the local bar (eleven links and the
 * database badge) 1,598px and 2,186px. `admin`'s five English links fit the
 * public width. Every class is a complete literal so Tailwind's source
 * scanner generates it.
 */
function deskBreakpoints(
  surface: Surface,
  locale: Locale,
): { deskFlex: string; deskHidden: string } {
  if (surface === 'local') {
    return locale === 'ka'
      ? { deskFlex: 'min-[2230px]:flex', deskHidden: 'min-[2230px]:hidden' }
      : { deskFlex: 'min-[1640px]:flex', deskHidden: 'min-[1640px]:hidden' };
  }
  return { deskFlex: 'min-[900px]:flex', deskHidden: 'min-[900px]:hidden' };
}

/** The `admin` surface's sign-out control — a real `<form>` submit, same reasoning as `toggleLocale`'s own form (works with scripting off). */
function SignOutButton({ className }: { className: string }) {
  return (
    <form action={signOutAction}>
      <button type="submit" className={className}>
        Sign out
      </button>
    </form>
  );
}

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M3 5h14M3 10h14M3 15h14"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
