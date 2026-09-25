import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLocalSurface,
  currentSurface,
  InvalidSurfaceError,
  NotLocalSurfaceError,
} from './surface.js';

/**
 * The whole point of this selector is that an unrecognized value cannot
 * silently become a surface nobody chose — so the invalid case is asserted
 * as strictly as the valid ones.
 */
describe('runtime surface', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('defaults to local when unset', () => {
    delete process.env.XTELO_SURFACE;
    expect(currentSurface()).toBe('local');
  });

  it.each(['local', 'public', 'admin'] as const)('accepts %o', (value) => {
    process.env.XTELO_SURFACE = value;
    expect(currentSurface()).toBe(value);
  });

  it.each(['Local', 'PUBLIC', 'operator', '', ' local'])(
    'fails closed for %o rather than guessing',
    (value) => {
      process.env.XTELO_SURFACE = value;
      expect(() => currentSurface()).toThrow(InvalidSurfaceError);
    },
  );
});

/**
 * `assertLocalSurface()` authorizes by `XTELO_SURFACE` alone, not by user
 * identity — so its own matrix is "reject under public/admin, succeed
 * unconditionally under local", never a "non-allowlisted user" variant,
 * which would misdescribe what this guard checks (per this stage's own
 * plan in docs/STATUS.md).
 */
describe('assertLocalSurface', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('succeeds unconditionally on local (including unset)', () => {
    delete process.env.XTELO_SURFACE;
    expect(() => assertLocalSurface()).not.toThrow();
    process.env.XTELO_SURFACE = 'local';
    expect(() => assertLocalSurface()).not.toThrow();
  });

  it.each(['public', 'admin'] as const)('refuses on %o', (surface) => {
    process.env.XTELO_SURFACE = surface;
    expect(() => assertLocalSurface()).toThrow(NotLocalSurfaceError);
  });
});
