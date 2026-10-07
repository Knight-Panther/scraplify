/**
 * Pure geometry for the landing page's crawler (`engine.ts`): no DOM, so it
 * is testable in Node. A leg is two segments, hip to knee and knee to foot;
 * given where the foot is planted, the knee is wherever both lengths meet,
 * bent away from the body (two-bone inverse kinematics).
 */

export interface Vec {
  x: number;
  y: number;
}

export function distance(a: Vec, b: Vec): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function lerp(a: Vec, b: Vec, t: number): Vec {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** `offset` given in the body's frame (forward, lateral), turned by `heading` and moved to `origin`. */
export function fromBody(origin: Vec, heading: number, forward: number, lateral: number): Vec {
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  return {
    x: origin.x + forward * cos - lateral * sin,
    y: origin.y + forward * sin + lateral * cos,
  };
}

/**
 * The knee of a two-segment leg from `hip` to `foot`, on the side away from
 * `away` (the body's centre), so legs always bend outward. A foot out of
 * reach is treated as just in reach: the leg straightens toward it rather
 * than the solve failing.
 */
export function solveKnee(hip: Vec, foot: Vec, upper: number, lower: number, away: Vec): Vec {
  const reach = upper + lower - 1e-3;
  const span = Math.min(Math.max(distance(hip, foot), 1e-3), reach);
  const dx = (foot.x - hip.x) / (distance(hip, foot) || 1);
  const dy = (foot.y - hip.y) / (distance(hip, foot) || 1);
  // Distance from the hip, along the hip-foot line, to the point under the knee.
  const along = (upper * upper - lower * lower + span * span) / (2 * span);
  const rise = Math.sqrt(Math.max(upper * upper - along * along, 0));
  const base = { x: hip.x + dx * along, y: hip.y + dy * along };
  const a = { x: base.x - dy * rise, y: base.y + dx * rise };
  const b = { x: base.x + dy * rise, y: base.y - dx * rise };
  return distance(a, away) >= distance(b, away) ? a : b;
}

/** Shortest signed turn from angle `from` to angle `to`, in (-π, π]. */
export function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (2 * Math.PI);
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta <= -Math.PI) delta += 2 * Math.PI;
  return delta;
}
