import { describe, expect, it } from 'vitest';
import { angleDelta, distance, easeFactor, fromBody, solveKnee, stepToward } from './geometry.js';

describe('solveKnee', () => {
  it('keeps both segment lengths for a foot within reach', () => {
    const hip = { x: 0, y: 0 };
    const foot = { x: 40, y: 20 };
    const knee = solveKnee(hip, foot, 30, 34, { x: -10, y: 0 });
    expect(distance(hip, knee)).toBeCloseTo(30, 6);
    expect(distance(knee, foot)).toBeCloseTo(34, 6);
  });

  it('bends the knee away from the body', () => {
    const hip = { x: 0, y: 0 };
    const foot = { x: 50, y: 0 };
    expect(solveKnee(hip, foot, 30, 34, { x: 25, y: 10 }).y).toBeLessThan(0);
    expect(solveKnee(hip, foot, 30, 34, { x: 25, y: -10 }).y).toBeGreaterThan(0);
  });

  it('straightens toward a foot out of reach instead of failing', () => {
    const knee = solveKnee({ x: 0, y: 0 }, { x: 500, y: 0 }, 30, 34, { x: 0, y: 5 });
    expect(Number.isFinite(knee.x) && Number.isFinite(knee.y)).toBe(true);
    expect(knee.x).toBeCloseTo(30, 1);
  });

  it('survives a foot planted on the hip', () => {
    const knee = solveKnee({ x: 3, y: 3 }, { x: 3, y: 3 }, 30, 34, { x: 0, y: 0 });
    expect(Number.isFinite(knee.x) && Number.isFinite(knee.y)).toBe(true);
  });
});

describe('fromBody', () => {
  it('turns a body-frame offset by the heading', () => {
    const point = fromBody({ x: 10, y: 10 }, Math.PI / 2, 5, 0);
    expect(point.x).toBeCloseTo(10, 6);
    expect(point.y).toBeCloseTo(15, 6);
  });
});

describe('stepToward', () => {
  it('never passes the goal', () => {
    expect(stepToward({ x: 0, y: 0 }, { x: 3, y: 4 }, 10)).toEqual({ x: 3, y: 4 });
    const step = stepToward({ x: 0, y: 0 }, { x: 30, y: 40 }, 10);
    expect(step.x).toBeCloseTo(6, 6);
    expect(step.y).toBeCloseTo(8, 6);
  });

  it('reaches a close target at any frame rate (the 144 Hz orbit bug)', () => {
    for (const hz of [30, 60, 144, 240]) {
      const dt = 1000 / hz;
      let body = { x: 0, y: 0 };
      const goal = { x: 4, y: 18 }; // the next board row, just below
      let frames = 0;
      while (distance(body, goal) > 0.5 && frames < 10_000) {
        body = stepToward(body, goal, (85 * dt) / 1000);
        frames += 1;
      }
      expect(frames * dt, `${hz} Hz`).toBeLessThan(400);
    }
  });
});

describe('easeFactor', () => {
  it('closes the same share per second at any frame rate', () => {
    const remaining = (hz: number) => {
      let left = 1;
      for (let i = 0; i < hz; i++) left *= 1 - easeFactor(1000 / hz, 150);
      return left;
    };
    expect(remaining(60)).toBeCloseTo(remaining(144), 9);
  });
});

describe('angleDelta', () => {
  it('takes the short way round', () => {
    expect(angleDelta(0.1, 2 * Math.PI - 0.1)).toBeCloseTo(-0.2, 6);
    expect(angleDelta(-3, 3)).toBeCloseTo(6 - 2 * Math.PI, 6);
  });
});
