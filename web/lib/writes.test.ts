import { afterEach, describe, expect, it } from 'vitest';
import {
  assertWritesEnabled,
  databaseLabel,
  WritesDisabledError,
  writesEnabled,
} from './writes.js';

/**
 * The gate is only worth having if it is closed by default and never leaks a
 * credential into the page, so both are asserted rather than assumed.
 */
describe('write gate', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('is closed when the flag is absent', () => {
    process.env.XTELO_WRITES_ENABLED = undefined;
    delete process.env.XTELO_WRITES_ENABLED;
    expect(writesEnabled()).toBe(false);
    expect(() => assertWritesEnabled()).toThrow(WritesDisabledError);
  });

  it.each(['false', 'TRUE', '1', 'yes', ''])('is closed for %o', (value) => {
    // Exactly 'true' opens it. Anything truthy-looking must not, or a stray
    // value in a shell profile silently arms the live instance.
    process.env.XTELO_WRITES_ENABLED = value;
    expect(writesEnabled()).toBe(false);
  });

  it('opens only for the exact string', () => {
    process.env.XTELO_WRITES_ENABLED = 'true';
    expect(writesEnabled()).toBe(true);
    expect(() => assertWritesEnabled()).not.toThrow();
  });

  it('never exposes credentials in the database label', () => {
    process.env.DATABASE_URL = 'postgres://someuser:hunter2@localhost:5432/scraplify';
    const label = databaseLabel();
    expect(label).toBe('scraplify');
    expect(label).not.toContain('hunter2');
    expect(label).not.toContain('someuser');
  });

  it('degrades without throwing when DATABASE_URL is absent or malformed', () => {
    delete process.env.DATABASE_URL;
    expect(databaseLabel()).toBe('no database');
    process.env.DATABASE_URL = 'not a url';
    expect(databaseLabel()).toBe('unparseable');
  });
});
