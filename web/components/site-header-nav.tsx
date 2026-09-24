'use client';

import { usePathname } from 'next/navigation.js';
import { signOutAction, toggleLocale } from '../app/actions.js';
import type { Locale } from '../lib/locale.js';
import type { Surface } from '../lib/surface.js';

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
] as const;

/**
 * Client only for the two things that genuinely need the browser: which
 * link is "active" (needs the current pathname) and the mobile menu's
 * open/closed state. `dbLabel`/`writesOn`/`surface` are passed in from the
 * server parent (`site-header.tsx`) rather than computed here — this
 * component used to call `databaseLabel()`/`writesEnabled()` directly when
 * it was still the whole `SiteNav`, and because those read server-only env
 * vars, running them again on the client (undefined there) produced a real
 * hydration mismatch: the server said "scraplify", the client said "no
 * database". Passing the already-resolved values down avoids that class of
 * bug entirely rather than working around its symptom.
 */
export function SiteHeaderNav({
  dbLabel,
  writesOn,
  locale,
  surface,
}: {
  dbLabel: string;
  writesOn: boolean;
  locale: Locale;
  surface: Surface;
}) {
  const pathname = usePathname();
  // Exact match for both root links ('/' and admin's own '/admin'
  // dashboard) — otherwise `startsWith` also matches every child route
  // (`/admin/sources`, ...), highlighting two nav items at once (Codex,
  // 2026-09-24).
  const isActive = (href: string) =>
    href === '/' || href === '/admin' ? pathname === href : (pathname?.startsWith(href) ?? false);
  const navFull = locale === 'ka' ? NAV_KA : NAV_EN;
  // Public hosted nav is `Browse | Listings` only (concept §30.1; `CV Ranked`
  // stays withheld until Phase 8D actually builds it) — the other links
  // (`/profile`, `/ranked`, `/drafts`, `/review`, `/taxonomy-review`,
  // `/health`) all 404 once Stage 6 allow-lists routes by surface, and
  // linking to them here would send a public visitor at a dead end. Sliced
  // from the same array rather than a second literal list, so the two
  // surfaces can never drift on the label/href for a link they share.
  //
  // `admin` gets its own fixed list (Stage 8) rather than a slice of
  // `navFull`: none of `navFull`'s links exist on that surface at all, unlike
  // public's subset which genuinely is a subset of local's.
  const nav =
    surface === 'admin' ? NAV_ADMIN : surface === 'public' ? navFull.slice(0, 2) : navFull;
  // Per-locale, not one shared value: Georgian's longer nav words need
  // more room than English's (see the desktop-nav comment below), and a
  // single breakpoint sized for Georgian would needlessly drop English
  // users at 1480-1719px into the mobile popover when their content
  // actually fits there. Each variant below is a complete literal class
  // name (`min-[1480px]:flex`, `min-[1720px]:flex`, ...) so Tailwind's
  // source scanner — which matches raw text, not evaluated JS — still
  // finds and generates both.
  const deskFlex = locale === 'ka' ? 'min-[1720px]:flex' : 'min-[1480px]:flex';
  const deskHidden = locale === 'ka' ? 'min-[1720px]:hidden' : 'min-[1480px]:hidden';

  return (
    <header className="flex h-[58px] items-stretch bg-[var(--color-browse-nav-yellow)] lg:h-[78px]">
      {/* Plain `<img>`, not `next/image`: a small fixed-size static header
          logo doesn't need Next's optimization pipeline, and `next/image`'s
          own shipped types don't resolve cleanly under this repo's
          `nodenext` module resolution (shared with the CLI build) — the
          same class of problem `types.d.ts`'s `next/font/google` shim
          exists to patch, not worth a second shim for one `<img>` tag.
          Explicit width/height (the real 2172×724 asset, scaled by the
          `h-*`/`w-auto` classes) avoid layout shift the way `next/image`
          would have handled automatically. */}
      {/* `/` is refused outright on the `admin` surface (`proxy.ts`'s admin
          branch only ever passes `/admin*`/`/api/auth*`) — the wordmark must
          target `/admin` there instead of the shared default (Codex,
          2026-09-24). */}
      <a href={surface === 'admin' ? '/admin' : '/'} className="flex items-center pl-4 lg:pl-8">
        {/* biome-ignore lint/performance/noImgElement: next/image doesn't
            type-check under this repo's nodenext resolution (see comment
            above); a fixed-size static logo has no LCP/bandwidth case for
            it anyway. */}
        <img
          src="/logo.png"
          alt="Xtelo"
          width={2172}
          height={724}
          className="h-[34px] w-auto lg:h-[44px]"
        />
      </a>

      {/* Desktop: every link inline, in the handoff's clipped-corner blocks.
          `min-[1360px]:flex` in English, not `xl:flex` (1280px) — the
          original threshold, chosen when this bar had 6 then 8 links and
          claimed to fit "at xl" in isolation. It didn't: measured via real
          `header.scrollWidth` at exactly 1280px CSS width (Phase 3E's own
          browser-QA sweep, 2026-09-15, found only because it tested the
          true boundary rather than a devicePixelRatio-skewed approximation
          of it), the 8-link nav alone overflowed by 37px at 1280px, and
          together with the write-gate badge below (which shares this
          threshold) by 155px. Dropping the redundant `/` ("Design system")
          entry the same day (it's the landing page now, already reachable
          via the wordmark link) took the count back to 7 — measured natural
          width (wordmark + nav + badge, unclipped) is ~1270px in English, so
          1360px is used there for real margin without the first fix's much
          wider 1500px.

          `min-[1600px]:flex` in Georgian (this bilingual change) — its nav
          labels are longer words, not the short English ones the 1360px
          number was tuned for: measured natural width in `ka` is ~1505px
          (`getBoundingClientRect` summed across the wordmark, nav `<ul>`,
          language toggle and badge at an unconstrained 2000px viewport) —
          already past 1360px itself, which is how a shared-breakpoint
          version of this first shipped with a visible horizontal scrollbar
          at 1440px before being caught in browser QA. Kept per-locale
          rather than raising the English breakpoint too, so English users
          at 1360-1599px keep the desktop bar their content actually fits
          in — see `deskFlex`/`deskHidden` above. The mobile popover below
          still covers the gap under whichever threshold is active.

          Raised again for the 9th link, "Drafts" (Phase 6A, 2026-09-16), by the
          same method rather than by estimate: at a real 1360px viewport the
          English header measured 1434px wide in a 1345px client (overflowing),
          and fit with 11px to spare at 1460px, so 1480px; Georgian measured
          1664px in 1585px at 1600px, so 1720px. The comments above keep the
          earlier numbers as history. */}
      <nav aria-label="Main" className={`ml-auto hidden items-stretch ${deskFlex}`}>
        <ul className="flex items-stretch">
          {nav.map((item, index) => (
            <li key={item.href}>
              <a
                href={item.href}
                aria-current={isActive(item.href) ? 'page' : undefined}
                className={`flex h-11 items-center text-[13px] font-semibold whitespace-nowrap text-white hover:bg-[var(--color-browse-nav-yellow)] hover:text-[var(--color-browse-ink)] ${
                  locale === 'en' ? 'uppercase [letter-spacing:0.1em]' : ''
                } ${
                  isActive(item.href)
                    ? 'bg-[var(--color-browse-nav-yellow)] text-[var(--color-browse-ink)]'
                    : 'bg-[var(--color-browse-nav-olive)]'
                }`}
                style={{
                  padding: index === 0 ? '0 22px 0 34px' : '0 22px',
                  clipPath:
                    index === 0 ? 'polygon(28px 0, 100% 0, 100% 100%, 0 100%, 0 28px)' : undefined,
                  marginLeft: index === 0 ? undefined : -1,
                }}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
        {/* `admin` has no `lib/locale.ts`-reading screen at all (`/`, the
            only page that cookie affects, is unreachable on this surface —
            `proxy.ts` refuses it), so the locale toggle would flip a cookie
            with no visible effect anywhere admin can reach. A sign-out
            control fills the same slot instead — the one admin-specific
            action this bar needs that public/local's shared nav has no
            equivalent for. */}
        {surface === 'admin' ? (
          <SignOutButton className="flex h-11 items-center border-l border-white/24 bg-[var(--color-browse-nav-olive)] pr-5 pl-5 text-[13px] font-semibold text-white [letter-spacing:0.1em] hover:bg-[var(--color-browse-nav-yellow)] hover:text-[var(--color-browse-ink)]" />
        ) : (
          // Switches the landing page's (`/`) language — see `lib/locale.ts`.
          // Every other screen ignores this cookie and stays English, so the
          // action always redirects to `/` rather than the current path;
          // clicking it elsewhere would otherwise flip the cookie with no
          // visible effect. A real `<form>` submit, not a client `onClick`,
          // so it works with scripting off like the rest of this app's
          // controls (`saved/actions.ts`'s own note). Label shows the
          // language a click switches INTO, not the current one — "EN"/"KA"
          // are language codes, never translated.
          <form action={toggleLocale}>
            <button
              type="submit"
              className="flex h-11 items-center border-l border-white/24 bg-[var(--color-browse-nav-olive)] pr-5 pl-5 text-[13px] font-semibold text-white [letter-spacing:0.1em] hover:bg-[var(--color-browse-nav-yellow)] hover:text-[var(--color-browse-ink)]"
              style={{ clipPath: 'polygon(0 0, 100% 0, calc(100% - 22px) 100%, 0 100%)' }}
              aria-label={locale === 'ka' ? 'Switch to English' : 'Switch to Georgian'}
            >
              {locale === 'ka' ? 'EN' : 'KA'}
            </button>
          </form>
        )}
      </nav>

      {/* Mobile: language toggle (or sign-out, on `admin`) + popover trigger,
          both visible in the bar itself rather than living only inside the
          popover — a control a visitor needs in order to even read the rest
          of the page shouldn't require opening the menu first to reach. */}
      <div className={`ml-auto flex items-center ${deskHidden}`}>
        {surface === 'admin' ? (
          <SignOutButton className="flex h-11 items-center px-3 text-[13px] font-semibold text-[var(--color-browse-ink)]" />
        ) : (
          <form action={toggleLocale}>
            <button
              type="submit"
              className="flex h-11 items-center px-3 text-[13px] font-semibold text-[var(--color-browse-ink)]"
              aria-label={locale === 'ka' ? 'Switch to English' : 'Switch to Georgian'}
            >
              {locale === 'ka' ? 'EN' : 'KA'}
            </button>
          </form>
        )}
        <button
          type="button"
          popoverTarget="site-nav-mobile"
          aria-label="Menu"
          className="flex items-center px-4 text-[var(--color-browse-ink)]"
        >
          <MenuIcon />
        </button>
      </div>
      <div
        id="site-nav-mobile"
        popover="auto"
        // mt-[58px]/h-[calc(100vh-58px)] alone matched the header's own
        // default height, but not its lg:h-[78px] — at 1024-1359px (now
        // routed through this menu rather than the desktop nav, widened
        // when that nav's own breakpoint moved past `lg` for the overflow
        // fix above) the popover started 20px too high, its top overlapping
        // the taller header instead of sitting below it (Codex, 2026-09-15).
        // lg: variants below mirror the header's own threshold exactly
        // rather than introducing a third breakpoint value to keep in sync.
        className={`m-0 mt-[58px] ml-auto h-[calc(100vh-58px)] w-64 max-h-none rounded-none border-0 border-l border-border bg-surface p-5 text-foreground lg:mt-[78px] lg:h-[calc(100vh-78px)] ${deskHidden}`}
      >
        <ul className="flex flex-col gap-1">
          {nav.map((item) => (
            <li key={item.href}>
              <a
                href={item.href}
                aria-current={isActive(item.href) ? 'page' : undefined}
                className={`block rounded-[var(--radius)] px-3 py-2 text-sm ${
                  isActive(item.href)
                    ? 'bg-[var(--color-browse-accent)] font-semibold text-[var(--color-browse-ink)]'
                    : 'text-muted hover:bg-surface-raised hover:text-foreground'
                }`}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </div>

      {/* Matches the desktop nav's own threshold above — this badge already
          lived only alongside the full desktop nav, so the two breakpoints
          staying equal keeps that relationship. It is a "nice to have"
          operator dev/env indicator (which database, whether writes are on),
          not something a real page depends on seeing, so it simply doesn't
          render at all below the shared threshold rather than needing its
          own separate fit budget — and not on any surface but `local` at
          all: a hosted public visitor has no business knowing which
          database or write-mode this instance runs, and `admin` gets its
          own dashboard chrome once Stage 8 builds it, not this operator
          debug strip. */}
      {surface === 'local' && (
        <span
          className={`my-auto ml-4 mr-4 hidden items-center gap-2 text-xs text-[var(--color-browse-ink)]/70 ${deskFlex}`}
        >
          <span>{dbLabel}</span>
          <span
            title={
              writesOn
                ? 'This instance can modify the database. It should be pointed at a disposable copy, not the live corpus.'
                : 'Read-only. Set XTELO_WRITES_ENABLED=true against a disposable database to make changes.'
            }
            className={
              writesOn
                ? 'rounded-full border border-[var(--color-browse-ink)]/40 px-2 py-0.5 text-[var(--color-browse-ink)]'
                : 'rounded-full border border-[var(--color-browse-ink)]/20 px-2 py-0.5 text-[var(--color-browse-ink)]/70'
            }
          >
            {writesOn ? 'writes on' : 'read-only'}
          </span>
        </span>
      )}
    </header>
  );
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
