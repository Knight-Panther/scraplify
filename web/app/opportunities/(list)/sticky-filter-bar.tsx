'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

/**
 * The one motion behaviour the handoff calls load-bearing: the title block
 * and the applied-filter row collapse as the list scrolls, so the search box
 * stays reachable without the bar permanently eating vertical space.
 *
 * An IntersectionObserver on a sentinel sized to the collapse threshold,
 * rather than a scroll listener — the handoff's own recommendation, and it
 * means no scroll-position arithmetic to keep in sync with the CSS. The
 * sentinel sits in normal flow directly above the sticky bar, so it scrolls
 * out of view at exactly the scrollTop where the bar's own `sticky` starts
 * engaging — collapse and stick happen together, which is the intended
 * effect. Its height is set in CSS (56px below `lg`, 72px from `lg` up), so
 * the two viewports collapse at their own threshold with no JS branching —
 * `prefers-reduced-motion` is likewise handled once, globally, in
 * `globals.css`, not duplicated here.
 */
export function StickyFilterBar({
  title,
  search,
  chips,
}: {
  title: ReactNode;
  search: ReactNode;
  chips: ReactNode;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry !== undefined) setCollapsed(!entry.isIntersecting);
      },
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinelRef} className="h-14 lg:h-[72px]" aria-hidden="true" />
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 sm:px-6">
        <div
          className={`overflow-hidden transition-[max-height,padding-top] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${
            collapsed ? 'max-h-0 pt-0' : 'max-h-40 pt-6'
          }`}
        >
          <div
            className={`pb-5 transition-opacity duration-200 ${collapsed ? 'opacity-0' : 'opacity-100'}`}
          >
            {title}
          </div>
        </div>
        <div className="py-3">{search}</div>
        <div
          className={`overflow-hidden transition-[max-height] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${
            collapsed ? 'max-h-0' : 'max-h-16'
          }`}
        >
          <div
            className={`pb-4 transition-opacity duration-200 ${collapsed ? 'opacity-0' : 'opacity-100'}`}
          >
            {chips}
          </div>
        </div>
      </div>
    </>
  );
}
