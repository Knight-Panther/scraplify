import { angleDelta, distance, fromBody, lerp, solveKnee, type Vec } from './geometry.js';

/**
 * The landing page's crawler (Phase 10B pilot): a small eight-legged
 * "spider" drawn on a canvas over the board-update rows and the newest
 * listings, walking from row to row the way the real crawler visits boards.
 *
 * Where a foot lands on an element marked `data-crawl`, that element is
 * "scraped" for a moment: `data-scraped` is set to one of a few CSS states
 * (`globals.css`) that change only outline, background and colour, never
 * the text and never its size, so nothing reflows and the listing itself
 * stays exactly what the board published.
 *
 * It gets out of the way of a reader: a pointer entering the area, a touch
 * or keyboard focus sends it to the edge, fades it out and clears every
 * effect; it comes back after a few idle seconds. The canvas never takes
 * pointer events, so a click lands on the link underneath. The caller does
 * not start it at all for reduced-motion visitors, and it stops drawing
 * while the area is off screen or the tab is hidden.
 */

const PAD = 24; // the canvas overhangs the host by this much on every side
const UPPER = 26;
const LOWER = 30;
const SPEED = 85; // px/s while crawling: one loop of the panel in about 20 s
const FLEE_SPEED = 420;
const STEP_AT = 22; // a planted foot steps once its rest point is this far away
const STEP_MS = 95;
const SCRAPE_MS = 1500;
const PALETTE_MS = 7000;
const RETURN_AFTER_LEAVE_MS = 2500;
const RETURN_AFTER_TOUCH_MS = 5000;

/** Hip along the body, and the foot's rest point, both in the body's frame (forward, lateral). */
const LEGS = [
  { hip: 8, forward: 30, lateral: 38 },
  { hip: 3, forward: 12, lateral: 46 },
  { hip: -3, forward: -8, lateral: 46 },
  { hip: -8, forward: -26, lateral: 38 },
] as const;

const PALETTES = [
  { leg: '#d6ff3f', joint: '#3ff0ff' },
  { leg: '#3ff0ff', joint: '#ff4fd8' },
  { leg: '#ff4fd8', joint: '#d6ff3f' },
] as const;

const EFFECTS = ['box', 'bar', 'tint', 'invert'] as const;

interface Leg {
  side: -1 | 1;
  slot: number;
  group: 0 | 1;
  foot: Vec;
  from: Vec;
  to: Vec;
  /** 1 when planted. */
  progress: number;
}

type Mode = 'crawl' | 'hiding' | 'hidden';

export interface Crawler {
  destroy(): void;
}

export function startCrawler(host: HTMLElement, canvas: HTMLCanvasElement): Crawler {
  const context = canvas.getContext('2d');
  if (context === null) return { destroy() {} };
  const ctx = context;

  let width = 0;
  let height = 0;
  let body: Vec = { x: PAD + 40, y: PAD + 20 };
  let heading = 0;
  let waypoint = 0;
  let direction = 1;
  let dwellUntil = 0;
  let startAt = 0;
  let mode: Mode = 'crawl';
  let opacity = 0;
  let onScreen = true;
  let frame = 0;
  let last = 0;
  let stepGroup: 0 | 1 = 0;
  let returnTimer = 0;
  let thread: { element: Element; until: number } | null = null;
  const scraped = new Map<Element, number>();

  const legs: Leg[] = [];
  for (const side of [-1, 1] as const) {
    LEGS.forEach((_, slot) => {
      const rest = restPoint(side, slot);
      legs.push({
        side,
        slot,
        group: ((slot + (side === 1 ? 1 : 0)) % 2) as 0 | 1,
        foot: rest,
        from: rest,
        to: rest,
        progress: 1,
      });
    });
  }

  function restPoint(side: -1 | 1, slot: number): Vec {
    const leg = LEGS[slot] ?? LEGS[0];
    return fromBody(body, heading, leg.forward, leg.lateral * side);
  }

  /** An element's box in canvas coordinates. */
  function boxOf(element: Element): DOMRect {
    const rect = element.getBoundingClientRect();
    const origin = canvas.getBoundingClientRect();
    return new DOMRect(rect.left - origin.left, rect.top - origin.top, rect.width, rect.height);
  }

  function stops(): Element[] {
    return [...host.querySelectorAll('[data-crawl-stop]')].filter(
      (element) => element.getClientRects().length > 0,
    );
  }

  function palette() {
    return PALETTES[Math.floor(performance.now() / PALETTE_MS) % PALETTES.length] ?? PALETTES[0];
  }

  function scrape(element: Element, effect?: (typeof EFFECTS)[number]) {
    if (!(element instanceof HTMLElement)) return;
    const colors = palette();
    if (!element.hasAttribute('data-scraped')) {
      element.dataset.scraped = effect ?? EFFECTS[Math.floor(Math.random() * EFFECTS.length)];
      element.style.setProperty('--scrape-color', Math.random() < 0.5 ? colors.leg : colors.joint);
    }
    scraped.set(element, performance.now() + SCRAPE_MS);
  }

  function clearScraped(element: Element) {
    if (!(element instanceof HTMLElement)) return;
    delete element.dataset.scraped;
    element.style.removeProperty('--scrape-color');
    scraped.delete(element);
  }

  function clearAll() {
    for (const element of [...scraped.keys()]) clearScraped(element);
    thread = null;
  }

  /** The marked element under a foot, if any. */
  function landOn(point: Vec) {
    for (const element of host.querySelectorAll('[data-crawl]')) {
      const box = boxOf(element);
      if (
        point.x >= box.left - 4 &&
        point.x <= box.right + 4 &&
        point.y >= box.top - 4 &&
        point.y <= box.bottom + 4
      ) {
        scrape(element);
        return;
      }
    }
  }

  function nextWaypoint(now: number) {
    const list = stops();
    if (list.length === 0) return;
    if (waypoint + direction < 0 || waypoint + direction >= list.length) direction *= -1;
    waypoint = Math.max(0, Math.min(list.length - 1, waypoint + direction));
    dwellUntil = now + 450 + Math.random() * 900;
    // Sometimes throw a thread to the row's board link, as if tying the
    // vacancy to its source.
    const chip = list[waypoint]?.querySelector('a[data-crawl][target="_blank"]');
    if (chip && Math.random() < 0.55) {
      thread = { element: chip, until: now + 1100 };
      scrape(chip, 'box');
    }
  }

  function target(): Vec | null {
    const list = stops();
    const stop = list[Math.min(waypoint, list.length - 1)];
    if (stop === undefined) return null;
    const box = boxOf(stop);
    // Walk the left part of each row, where its text starts.
    return { x: box.left + Math.min(box.width * 0.35, 150), y: box.top + box.height / 2 };
  }

  function exitPoint(): Vec {
    return { x: -60, y: Math.max(PAD, Math.min(height - PAD, body.y)) };
  }

  function update(dt: number, now: number) {
    if (mode === 'crawl') {
      if (now >= startAt) opacity = Math.min(1, opacity + dt / 400);
      const goal = target();
      if (goal !== null) {
        const gap = distance(body, goal);
        if (gap < 4) {
          if (now >= dwellUntil) nextWaypoint(now);
        } else if (now >= dwellUntil) {
          const want = Math.atan2(goal.y - body.y, goal.x - body.x);
          heading += angleDelta(heading, want) * Math.min(1, dt / 180);
          const stride = Math.min(gap, (SPEED * dt) / 1000) * (0.7 + Math.random() * 0.6);
          body = { x: body.x + Math.cos(heading) * stride, y: body.y + Math.sin(heading) * stride };
        }
      }
    } else {
      opacity = Math.max(0, opacity - dt / 260);
      const exit = exitPoint();
      const gap = distance(body, exit);
      if (gap > 2) {
        heading += angleDelta(heading, Math.atan2(exit.y - body.y, exit.x - body.x)) * 0.5;
        const stride = Math.min(gap, (FLEE_SPEED * dt) / 1000);
        body = { x: body.x + Math.cos(heading) * stride, y: body.y + Math.sin(heading) * stride };
      }
      if (opacity === 0) mode = 'hidden';
    }

    // Legs: one alternating group steps at a time, so the gait reads as a
    // walk rather than a slide; a step is quick, which gives the jerky,
    // insect-like rhythm.
    let groupMoving = false;
    for (const leg of legs) {
      if (leg.progress < 1) {
        leg.progress = Math.min(1, leg.progress + dt / STEP_MS);
        leg.foot = lerp(leg.from, leg.to, leg.progress);
        if (leg.progress === 1 && mode === 'crawl') landOn(leg.foot);
        groupMoving = true;
      }
    }
    if (!groupMoving) {
      let stepped = false;
      for (const leg of legs) {
        if (leg.group !== stepGroup) continue;
        const rest = restPoint(leg.side, leg.slot);
        if (distance(leg.foot, rest) > STEP_AT || mode !== 'crawl') {
          const lead = mode === 'crawl' ? 6 : 18;
          leg.from = leg.foot;
          leg.to = fromBody(rest, heading, lead, (Math.random() - 0.5) * 6);
          leg.progress = 0;
          stepped = true;
        }
      }
      if (stepped || Math.random() < 0.2) stepGroup = stepGroup === 0 ? 1 : 0;
    }

    for (const [element, until] of scraped) {
      if (now >= until) clearScraped(element);
    }
    if (thread !== null && now >= thread.until) thread = null;
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    if (opacity === 0) return;
    const colors = palette();
    ctx.globalAlpha = opacity;
    ctx.lineCap = 'round';

    if (thread !== null) {
      const box = boxOf(thread.element);
      ctx.strokeStyle = colors.joint;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(body.x, body.y);
      ctx.lineTo(box.left + box.width / 2, box.top + box.height / 2);
      ctx.stroke();
    }

    for (const leg of legs) {
      const slot = LEGS[leg.slot] ?? LEGS[0];
      const hip = fromBody(body, heading, slot.hip, 3 * leg.side);
      const knee = solveKnee(hip, leg.foot, UPPER, LOWER, body);
      ctx.strokeStyle = colors.leg;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(hip.x, hip.y);
      ctx.lineTo(knee.x, knee.y);
      ctx.lineTo(leg.foot.x, leg.foot.y);
      ctx.stroke();
      ctx.fillStyle = colors.joint;
      for (const joint of [knee, leg.foot]) {
        ctx.beginPath();
        ctx.arc(joint.x, joint.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Body: a narrow rectangle along the heading, with a head dot.
    ctx.save();
    ctx.translate(body.x, body.y);
    ctx.rotate(heading);
    ctx.fillStyle = '#0e1114';
    ctx.strokeStyle = colors.leg;
    ctx.lineWidth = 1.5;
    ctx.fillRect(-11, -4, 22, 8);
    ctx.strokeRect(-11, -4, 22, 8);
    ctx.fillStyle = colors.joint;
    ctx.beginPath();
    ctx.arc(9, 0, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function tick(now: number) {
    frame = 0;
    const dt = Math.min(now - (last || now), 50);
    last = now;
    update(dt, now);
    draw();
    schedule();
  }

  function schedule() {
    const running = onScreen && document.visibilityState === 'visible' && mode !== 'hidden';
    if (running && frame === 0) frame = requestAnimationFrame(tick);
    if (!running) last = 0;
  }

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    width = host.clientWidth + PAD * 2;
    height = host.clientHeight + PAD * 2;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw();
  }

  function hide(returnAfter: number | null) {
    window.clearTimeout(returnTimer);
    if (mode === 'crawl') mode = 'hiding';
    clearAll();
    schedule();
    if (returnAfter !== null) returnTimer = window.setTimeout(reappear, returnAfter);
  }

  function reappear() {
    if (host.matches(':hover') || host.contains(document.activeElement)) return;
    mode = 'crawl';
    // Re-enter from the edge it left by.
    body = exitPoint();
    heading = 0;
    for (const leg of legs) {
      leg.foot = restPoint(leg.side, leg.slot);
      leg.progress = 1;
    }
    schedule();
  }

  const onPointerEnter = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') hide(null);
  };
  const onPointerLeave = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') hide(RETURN_AFTER_LEAVE_MS);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') hide(RETURN_AFTER_TOUCH_MS);
  };
  const onFocusIn = () => hide(null);
  const onFocusOut = () => hide(RETURN_AFTER_LEAVE_MS);
  const onVisibility = () => schedule();

  host.addEventListener('pointerenter', onPointerEnter);
  host.addEventListener('pointerleave', onPointerLeave);
  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('focusin', onFocusIn);
  host.addEventListener('focusout', onFocusOut);
  document.addEventListener('visibilitychange', onVisibility);
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  const intersectionObserver = new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    schedule();
  });
  intersectionObserver.observe(host);

  resize();
  // Start on the first stop, already standing.
  const start = target();
  if (start !== null) body = { x: start.x - 30, y: start.y };
  for (const leg of legs) leg.foot = restPoint(leg.side, leg.slot);
  // Out of sight, and still, until the page's own entrance animation has settled.
  startAt = performance.now() + 1600;
  dwellUntil = startAt + 400;
  schedule();

  return {
    destroy() {
      cancelAnimationFrame(frame);
      window.clearTimeout(returnTimer);
      host.removeEventListener('pointerenter', onPointerEnter);
      host.removeEventListener('pointerleave', onPointerLeave);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('focusin', onFocusIn);
      host.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('visibilitychange', onVisibility);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      clearAll();
    },
  };
}
