'use client';

import { useEffect, useRef, useState } from 'react';
import type { OpportunityRow } from '../lib/opportunity-row.js';

/**
 * The landing hero's marquee strip — a client component (the rest of the
 * page is server-rendered) for a real, keyboard- and touch-operable pause
 * control, not just a CSS hover/focus convenience.
 *
 * Found by three rounds of the per-commit Codex review (2026-09-15):
 *
 * 1. `group-hover`/`group-focus-within` alone gives no PERSISTENT pause on
 *    a touch-only device — tapping an item just navigates away, so the
 *    strip's WCAG pause/stop requirement went unmet for exactly the
 *    visitors most likely to be on mobile (the required 390px checkpoint
 *    included). A related finding: DOM tab order stays fixed while the
 *    strip visually translates, so a keyboard user tabbing in could land
 *    focus on a link already scrolled outside the clip before
 *    `group-focus-within`'s pause had any chance to help.
 *
 *    Fixed with a real `<button>` driving React state, not a CSS
 *    pseudo-class: it both sets `animation-play-state` and gates every
 *    real link's `tabIndex`, so links are only reachable once the strip
 *    is genuinely paused.
 *
 * 2. That first fix kept the CSS `group-hover`/`group-focus-within`
 *    pausing ALONGSIDE the button, meaning clicking "Play" while the
 *    pointer or keyboard focus was still on the button (which is inside
 *    the same `.group`) left the CSS rule still forcing
 *    `animation-play-state: paused` — the button read "Play" but nothing
 *    moved until the pointer/focus left it. Fixed by dropping the CSS
 *    pause entirely; the button's own state is now the one source of
 *    truth, so Play genuinely resumes the instant it's activated.
 *
 *    Pausing stops the motion but does not make the whole (much wider
 *    than the clip) track visible at once — at 390px several real titles
 *    are themselves wider than the whole wrapper, so a strict "fully
 *    unclipped" visibility rule could leave nothing tabbable at all,
 *    depending on where the animation happened to stop. Fixed with an
 *    intersection-ratio measurement (see `isSubstantiallyVisible` below)
 *    instead of exact containment.
 *
 * 3. Two more real gaps in that same fix: `globals.css`'s own
 *    `prefers-reduced-motion` rule already freezes this track (via
 *    `animation-iteration-count: 1`) without this component's `paused`
 *    state ever becoming `true` — so a reduced-motion visitor saw a
 *    stationary strip with a button still reading "Pause" and every real
 *    link stuck at `tabIndex={-1}` forever, unreachable by keyboard. And
 *    the one-time, effect-on-`paused` measurement never reran if the
 *    viewport resized (or a device rotated) while paused, leaving stale
 *    `tabIndex`es pointing at links that had since scrolled out of (or
 *    into) view. Fixed by tracking `prefers-reduced-motion` directly
 *    (mirroring `hero-video.tsx`'s own `matchMedia` pattern) and folding
 *    it into one `effectivePaused` flag alongside the button's state, and
 *    by re-running the measurement on a `ResizeObserver` firing on the
 *    wrapper, not just once when pausing begins.
 */
export function HeroTicker({
  rows,
  pauseLabel,
  playLabel,
}: {
  rows: OpportunityRow[];
  pauseLabel: string;
  playLabel: string;
}) {
  const [paused, setPaused] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string>>(new Set());
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(query.matches);
    const onChange = () => setPrefersReducedMotion(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const effectivePaused = paused || prefersReducedMotion;

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!effectivePaused || wrapper === null) {
      setVisibleIds(new Set());
      return;
    }

    const measure = () => {
      const wrapperRect = wrapper.getBoundingClientRect();
      const links = wrapper.querySelectorAll<HTMLAnchorElement>('a[data-ticker-id]');
      const ids = new Set<string>();
      for (const link of links) {
        if (isSubstantiallyVisible(link.getBoundingClientRect(), wrapperRect)) {
          const id = link.dataset.tickerId;
          if (id !== undefined) ids.add(id);
        }
      }
      setVisibleIds(ids);
    };

    // `animation-play-state: paused` (or the reduced-motion freeze) takes
    // effect on the next paint, not synchronously here — measuring
    // immediately can still read a pre-settled transform.
    // requestAnimationFrame (a paint has happened by the time it fires)
    // rather than a fixed timeout, which would either race a slow paint or
    // add a visible delay to a fast one.
    const frame = requestAnimationFrame(measure);
    // Re-measure on resize/rotation while paused — the wrapper's own width
    // and every link's position can both change without `effectivePaused`
    // itself changing, and the previous measurement is stale the instant
    // that happens.
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [effectivePaused]);

  if (rows.length < 3) return null;

  return (
    <div
      ref={wrapperRef}
      className="group relative mt-14 w-full overflow-hidden border-t border-[var(--color-browse-border)] bg-[var(--color-browse-panel)]"
    >
      {/* Nothing to toggle once the OS preference has already frozen the
          strip — a "Pause" button over already-stationary content is a
          control with no effect, which is its own kind of misleading. */}
      {!prefersReducedMotion && (
        <button
          type="button"
          onClick={() => setPaused((value) => !value)}
          aria-pressed={paused}
          className="absolute top-1/2 right-3 z-10 -translate-y-1/2 rounded-full border border-[var(--color-browse-border-control)] bg-[var(--color-browse-panel)] px-3 py-1.5 text-[11px] text-[var(--color-browse-text-pill)] hover:border-[var(--color-browse-accent)] hover:text-[var(--color-browse-accent)]"
        >
          {paused ? playLabel : pauseLabel}
        </button>
      )}
      <div
        className={`flex w-max animate-hero-ticker ${effectivePaused ? '[animation-play-state:paused]' : ''}`}
      >
        <TickerItems rows={rows} visibleIds={effectivePaused ? visibleIds : undefined} />
        <TickerItems rows={rows} duplicate />
      </div>
    </div>
  );
}

/**
 * Not "fully unclipped" — measured directly against real content and found
 * impossible to require: several real titles render wider than the whole
 * 390px wrapper on their own, so nothing would ever qualify at that width
 * under a strict full-containment rule. Instead: at least 90% of whichever
 * is smaller, the link's own width or the wrapper's — which passes a short
 * item that fully fits, and also passes a too-wide item on the rare
 * occasion it happens to land covering essentially the whole visible strip
 * (in which case it IS, practically, "what's currently shown"), while
 * still excluding the common case this was found from: a link only a
 * sliver (Codex measured ~11px) into view.
 */
function isSubstantiallyVisible(rect: DOMRect, wrapperRect: DOMRect): boolean {
  const visibleWidth =
    Math.min(rect.right, wrapperRect.right) - Math.max(rect.left, wrapperRect.left);
  return visibleWidth >= Math.min(rect.width, wrapperRect.width) * 0.9;
}

function TickerItems({
  rows,
  duplicate = false,
  visibleIds,
}: {
  rows: OpportunityRow[];
  duplicate?: boolean;
  /** Real links only: `undefined` (never tabbable) while running, a
   * measured `Set` of ids once paused (or reduced-motion) and settled. */
  visibleIds?: ReadonlySet<string> | undefined;
}) {
  return (
    <div aria-hidden={duplicate || undefined} className="flex">
      {rows.map((row, index) => {
        const employers = row.employers.length > 0 ? ` · ${row.employers.join(' · ')}` : '';
        const key = duplicate ? `dup-${index}` : row.opportunityId;
        const content = (
          <>
            <span
              aria-hidden="true"
              className="mr-3 h-1 w-1 flex-none bg-[var(--color-browse-accent)]"
            />
            {row.title}
            {employers}
          </>
        );
        // The duplicated copy is decorative only (it exists so the -50%
        // loop has a second run to travel into) and must never be
        // reachable by keyboard or a screen reader — real <a> elements
        // here would be Tab-stops with no independent meaning, so it
        // renders as plain markup instead, under this function's own
        // aria-hidden container.
        return duplicate ? (
          <span
            key={key}
            className="flex items-center whitespace-nowrap py-3.5 pr-7 text-[13px] text-[var(--color-browse-text-muted)]"
          >
            {content}
          </span>
        ) : (
          <a
            key={key}
            href={`/opportunities/${row.opportunityId}`}
            data-ticker-id={row.opportunityId}
            tabIndex={visibleIds?.has(row.opportunityId) === true ? 0 : -1}
            className="flex items-center whitespace-nowrap py-3.5 pr-7 text-[13px] text-[var(--color-browse-text-muted)] hover:text-white"
          >
            {content}
          </a>
        );
      })}
    </div>
  );
}
