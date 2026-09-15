/**
 * The one footer, used by every screen via the root layout — matches
 * `site-header.tsx` in being shared rather than redrawn per page.
 *
 * Deliberately minimal: no invented metrics, no link list duplicating the
 * header's nav. Just what the product is and where its data comes from,
 * which is true on every screen and needs no per-page data fetch — plus
 * two real personal-profile links (project owner's own Facebook and
 * LinkedIn), not a generic social-icon row: no Twitter/Instagram/etc.
 * placeholders linking nowhere.
 *
 * No ALL-CAPS "FIND US ON" label (unlike the reference screenshot this was
 * modeled on) — this project's own design-direction.md drops ALL-CAPS
 * tracked eyebrows sitewide (a `frontend-design` "generated page" tell, and
 * meaningless on Georgian besides, which this footer's own text just isn't
 * localized for yet — the front-page bilingual switch stops at the hero).
 */
export function SiteFooter() {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-5 sm:px-6">
      <p className="numeric text-xs text-faint">
        Xtelo — jobs.ge <span className="text-[var(--color-browse-accent)]">+</span> hr.ge,
        deduplicated into one row per vacancy.
      </p>
      <div className="flex items-center gap-4">
        <span className="text-xs text-faint">Find us:</span>
        <a
          href="https://www.facebook.com/giorgi.teliashvili.473015"
          target="_blank"
          rel="noreferrer"
          aria-label="Facebook (opens in a new tab)"
          className="text-faint transition-colors duration-150 hover:text-[var(--color-browse-accent)]"
        >
          <FacebookIcon />
        </a>
        <a
          href="https://www.linkedin.com/in/giorgi-teliashvili-77b47935b/"
          target="_blank"
          rel="noreferrer"
          aria-label="LinkedIn (opens in a new tab)"
          className="text-faint transition-colors duration-150 hover:text-[var(--color-browse-accent)]"
        >
          <LinkedinIcon />
        </a>
      </div>
    </footer>
  );
}

function FacebookIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M22 12.06C22 6.51 17.52 2 12 2S2 6.51 2 12.06c0 5 3.66 9.15 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.51 1.49-3.9 3.77-3.9 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.87h2.78l-.45 2.91h-2.33V22c4.78-.79 8.44-4.94 8.44-9.94z" />
    </svg>
  );
}

function LinkedinIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.03-1.85-3.03-1.85 0-2.14 1.45-2.14 2.94v5.66H9.34V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.38-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45z" />
    </svg>
  );
}
