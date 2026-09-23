import { afterEach, describe, expect, it } from 'vitest';
import { currentSurface, InvalidSurfaceError } from './surface.js';

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
