import { describe, expect, it } from 'vitest';
import { cvRankedEnabled, InvalidCvRankedSwitchError } from './availability.js';

describe('cvRankedEnabled', () => {
  it('is on when unset or on, off only when off', () => {
    expect(cvRankedEnabled(undefined)).toBe(true);
    expect(cvRankedEnabled('on')).toBe(true);
    expect(cvRankedEnabled('off')).toBe(false);
  });

  it('refuses anything else, so a typo cannot leave CV entry on', () => {
    for (const value of ['of', 'OFF', 'false', '0', '']) {
      expect(() => cvRankedEnabled(value)).toThrow(InvalidCvRankedSwitchError);
    }
  });
});
