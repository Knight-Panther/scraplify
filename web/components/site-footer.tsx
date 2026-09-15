/**
 * The one footer, used by every screen via the root layout — matches
 * `site-header.tsx` in being shared rather than redrawn per page.
 *
 * Deliberately minimal: no invented metrics, no link list duplicating the
 * header's nav. Just what the product is and where its data comes from,
 * which is true on every screen and needs no per-page data fetch.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-border px-4 py-5 sm:px-6">
      <p className="numeric text-xs text-faint">
        Xtelo — jobs.ge <span className="text-[var(--color-browse-accent)]">+</span> hr.ge,
        deduplicated into one row per vacancy.
      </p>
    </footer>
  );
}
