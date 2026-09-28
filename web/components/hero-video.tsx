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
 * battery cost, just the still frame underneath it (`HeroPoster`).
 *
 * The files are re-encoded for the web (2026-09-28): the original was 5.8 MB
 * at 3 Mbps and was the page's largest request. The clip sits under a
 * 55–94% dark overlay at 0.56x, so a capped bitrate costs nothing visible:
 * 1.4 MB at 1280×720, and 0.7 MB at 640×360 for narrow screens, chosen by
 * each `<source>`'s `media` query.
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
      <source src="/hero-bg.v2-640.mp4" type="video/mp4" media="(max-width: 767px)" />
      <source src="/hero-bg.v2.mp4" type="video/mp4" />
    </video>
  );
}

/**
 * The clip's first frame as a plain server-rendered image, under the video.
 * It is what a reduced-motion visitor sees, and it is the page's largest
 * paint: the video only exists after hydration, which made the hero wait
 * about a second for JavaScript before it could even start loading (the
 * mobile LCP was 3.1 s, 2026-09-28). This image is in the HTML itself, at
 * high fetch priority, so the hero paints immediately and the video fades
 * in over the same frame.
 */
export function HeroPoster() {
  return (
    <img
      src="/hero-poster.v2.webp"
      srcSet="/hero-poster.v2-640.webp 640w, /hero-poster.v2-960.webp 960w, /hero-poster.v2.webp 1280w"
      sizes="100vw"
      width={1280}
      height={720}
      alt=""
      aria-hidden="true"
      fetchPriority="high"
      className="absolute inset-0 h-full w-full object-cover"
    />
  );
}
