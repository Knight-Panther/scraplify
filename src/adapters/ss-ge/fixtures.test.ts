import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FIXTURES = new URL('./fixtures/', import.meta.url);

/**
 * This repository is public, and ss.ge pages carry people's phone numbers
 * and names plus a working access token for the site's own gateway
 * (guideline §15, traps 7 and 8). Fixtures are trimmed and scrubbed before
 * they are committed; this is what notices when one is not.
 */
const FORBIDDEN: readonly [string, RegExp][] = [
  ['the gateway token field', /credentialsToken/],
  ['a JSON web token', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['a user id field', /"userId"/],
  ['a phone list', /applicationPhones|"phoneNumber"/],
  ['a contact name', /contactPerson|"name"\s*:/],
  ['a Georgian mobile number', /(?<![0-9])5[0-9]{8}(?![0-9])/],
  ['an international phone prefix', /\+995/],
];

describe('ss.ge fixtures', () => {
  const files = readdirSync(FIXTURES).filter((name) => name.endsWith('.html'));

  it('exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s carries no token, phone number or name', (name) => {
    const content = readFileSync(new URL(name, FIXTURES), 'utf-8');
    for (const [what, pattern] of FORBIDDEN) {
      expect(pattern.test(content), `${name} contains ${what}`).toBe(false);
    }
  });
});
