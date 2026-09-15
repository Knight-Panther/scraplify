'use client';

import { usePathname } from 'next/navigation.js';

/**
 * The site's nav links, one list shared by the desktop bar and the mobile
 * menu — a second, hand-kept copy is exactly how the two drifted before
 * (`SiteNav` had six links, the browse screen's one-off header had four).
 *
 * No entry for `/` itself (Phase 3E, 2026-09-15) — it is the landing page
 * now, not a "Design system" reference screen, and the wordmark link
 * (`XTELO`, below) already goes there; a second link to the same
 * destination in the nav proper would be redundant, not a real page in
 * its own right the way every other entry here is.
 */
const NAV = [
  { href: '/opportunities', label: 'Browse' },
  { href: '/listings', label: 'Listings' },
  { href: '/ranked', label: 'Ranked' },
  { href: '/saved', label: 'Shortlist' },
  { href: '/review', label: 'Duplicate review' },
  { href: '/taxonomy-review', label: 'Taxonomy review' },
  { href: '/health', label: 'Source health' },
] as const;

/**
 * Client only for the two things that genuinely need the browser: which
 * link is "active" (needs the current pathname) and the mobile menu's
 * open/closed state. `dbLabel`/`writesOn` are passed in from the server
 * parent (`site-header.tsx`) rather than computed here — this component
 * used to call `databaseLabel()`/`writesEnabled()` directly when it was
 * still the whole `SiteNav`, and because those read server-only env vars,
 * running them again on the client (undefined there) produced a real
 * hydration mismatch: the server said "scraplify", the client said "no
 * database". Passing the already-resolved strings down avoids that class of
 * bug entirely rather than working around its symptom.
 */
export function SiteHeaderNav({ dbLabel, writesOn }: { dbLabel: string; writesOn: boolean }) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : (pathname?.startsWith(href) ?? false);

  return (
    <header className="flex h-[58px] items-stretch bg-[var(--color-browse-nav-yellow)] lg:h-[78px]">
      <a
        href="/"
        className="flex items-center pl-4 font-[family-name:var(--font-display)] text-[22px] text-[var(--color-browse-ink)] lg:pl-8 lg:text-[30px]"
      >
        XTELO
      </a>

      {/* Desktop: every link inline, in the handoff's clipped-corner blocks.
          `min-[1360px]:flex`, not `xl:flex` (1280px) — the original
          threshold, chosen when this bar had 6 then 8 links and claimed to
          fit "at xl" in isolation. It didn't: measured via real
          `header.scrollWidth` at exactly 1280px CSS width (Phase 3E's own
          browser-QA sweep, 2026-09-15, found only because it tested the
          true boundary rather than a devicePixelRatio-skewed approximation
          of it), the 8-link nav alone overflowed by 37px at 1280px, and
          together with the write-gate badge below (which shares this
          threshold) by 155px. Dropping the redundant `/` ("Design system")
          entry the same day (it's the landing page now, already reachable
          via the wordmark link) took the count back to 7 — measured natural
          width (wordmark + nav + badge, unclipped) is ~1270px, so 1360px is
          used for real margin without the first fix's much wider 1500px,
          which stopped being necessary once the link count dropped. The
          mobile popover below still covers the 1024–1359px gap. */}
      <nav aria-label="Main" className="ml-auto hidden items-stretch min-[1360px]:flex">
        <ul className="flex items-stretch">
          {NAV.map((item, index) => (
            <li key={item.href}>
              <a
                href={item.href}
                aria-current={isActive(item.href) ? 'page' : undefined}
                className={`flex h-11 items-center text-[13px] font-semibold whitespace-nowrap text-white uppercase [letter-spacing:0.1em] hover:bg-[var(--color-browse-nav-yellow)] hover:text-[var(--color-browse-ink)] ${
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
        {/* Static — this app has no language switch. A plain label rather
            than a dropdown so it doesn't imply a control that isn't there. */}
        <span
          className="flex h-11 items-center border-l border-white/24 bg-[var(--color-browse-nav-olive)] pr-5 pl-5 text-[13px] font-semibold text-white uppercase [letter-spacing:0.1em]"
          style={{ clipPath: 'polygon(0 0, 100% 0, calc(100% - 22px) 100%, 0 100%)' }}
        >
          KA
        </span>
      </nav>

      {/* Mobile: a popover menu, no client handler needed to open it. */}
      <button
        type="button"
        popoverTarget="site-nav-mobile"
        aria-label="Menu"
        className="ml-auto flex items-center px-4 text-[var(--color-browse-ink)] min-[1360px]:hidden"
      >
        <MenuIcon />
      </button>
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
        className="m-0 mt-[58px] ml-auto h-[calc(100vh-58px)] w-64 max-h-none rounded-none border-0 border-l border-border bg-surface p-5 text-foreground lg:mt-[78px] lg:h-[calc(100vh-78px)] min-[1360px]:hidden"
      >
        <ul className="flex flex-col gap-1">
          {NAV.map((item) => (
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
          dev/env indicator, not something a real page depends on seeing, so
          it simply doesn't render at all below the shared threshold rather
          than needing its own separate fit budget. */}
      <span className="my-auto ml-4 mr-4 hidden items-center gap-2 text-xs text-[var(--color-browse-ink)]/70 min-[1360px]:flex">
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
    </header>
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
