import { describe, expect, it } from 'vitest';
import { SCRAPLIFY_VERSION } from './index.js';

describe('scaffold smoke test', () => {
  it('exports a version string', () => {
    expect(SCRAPLIFY_VERSION).toBe('0.0.0');
  });
});
