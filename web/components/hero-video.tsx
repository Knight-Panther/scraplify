'use client';

import { useEffect, useState } from 'react';

/** 56% of native speed — a 30% slowdown (0.7x, the clip read as too fast
 * natively), then another 20% slower on top of that (0.7 * 0.8 = 0.56),
 * both by explicit project-owner request, 2026-09-15. Only `playbackRate`
 * achieves this; there is no HTML attribute or CSS property for video
 * speed, so it has to be set imperatively once the element exists. */
const PLAYBACK_RATE = 0.56;

/**
 * The hero's motion background — client-only because whether it renders at
 * all depends on `prefers-reduced-motion`, which is not knowable on the
 * server. Rather than shipping the `<video>` element to every visitor and
 * fighting the reduced-motion media query over whether it plays, a reduced-
 * motion visitor gets no `<video>` in the DOM at all: no decode, no CPU, no
 * battery cost, just the static gradient underneath it.
 */
export function HeroVideo() {
  const [allowMotion, setAllowMotion] = useState<boolean | null>(null);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setAllowMotion(!query.matches);
    const onChange = () => setAllowMotion(!query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  if (allowMotion !== true) return null;

  return (
    <video
      className="absolute inset-0 h-full w-full object-cover"
      autoPlay
      muted
      loop
      playsInline
      tabIndex={-1}
      aria-hidden="true"
      onLoadedMetadata={(event) => {
        event.currentTarget.playbackRate = PLAYBACK_RATE;
      }}
    >
      <source src="/hero-bg.mp4" type="video/mp4" />
    </video>
  );
}
