'use client';

import { type ReactNode, useEffect, useRef } from 'react';
import { startCrawler } from '../lib/landing-crawler/engine.js';

/**
 * Wraps the landing page's board-update rows and newest listings with the
 * crawler overlay (`web/lib/landing-crawler/engine.ts`, Phase 10B pilot).
 * The children render exactly as they would without it: the canvas sits on
 * top, takes no pointer events and is hidden from assistive technology.
 * Nothing starts for a visitor who asked their system for reduced motion,
 * and it stops if they switch that on mid-visit.
 */
export function LandingCrawler({ children }: { children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (host === null || canvas === null) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let crawler = reduced.matches ? null : startCrawler(host, canvas);
    const onChange = () => {
      if (reduced.matches) {
        crawler?.destroy();
        crawler = null;
      } else if (crawler === null) {
        crawler = startCrawler(host, canvas);
      }
    };
    reduced.addEventListener('change', onChange);
    return () => {
      reduced.removeEventListener('change', onChange);
      crawler?.destroy();
    };
  }, []);

  return (
    <div ref={hostRef} className="relative">
      {children}
      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a canvas with no tabindex is not focusable, and this one is pure decoration that a screen reader should skip */}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute -inset-6 h-[calc(100%+3rem)] w-[calc(100%+3rem)]"
      />
    </div>
  );
}
