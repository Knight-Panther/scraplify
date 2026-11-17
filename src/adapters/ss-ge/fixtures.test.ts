import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FAKE_PHOTO_GUID, FAKE_USER_ID_RE, fakePhotoFileName, fakeUserId } from './fakes.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);

/**
 * This repository is public, and ss.ge pages carry people's phone numbers,
 * names and account ids, photo paths, and a working access token for the
 * site's own gateway (guideline §15, traps 7 and 8). Fixtures are trimmed and
 * scrubbed before they are committed (scripts/capture-ss-ge-fixture.mjs);
 * this is what notices when one is not. Since Phase 17B an account id or a
 * photo path may appear, but only as a reserved fake (`reserved-fakes.json`).
 */
const FORBIDDEN: readonly [string, RegExp][] = [
  ['the gateway token field', /credentialsToken/],
  ['a JSON web token', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['a phone list', /applicationPhones|"phoneNumber"/],
  ['a contact name', /contactPerson|agentContactName|"name"\s*:/],
  ['an agency or company name', /"agencyName"|"companyName"/],
  ['a Georgian mobile number', /(?<![0-9])5[0-9]{8}(?![0-9])/],
  ['an international phone prefix', /\+995/],
];

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const USER_ID_FIELD_RE = /"userId"\s*:\s*("[^"]*"|[^,}\]]+)/g;

/** What is wrong with a fixture's account ids and GUIDs; empty when nothing is. */
function realIdentifiers(content: string): string[] {
  const problems: string[] = [];
  for (const [, value] of content.matchAll(USER_ID_FIELD_RE)) {
    const plain = (value as string).replace(/^"|"$/g, '');
    if (plain !== 'null' && !FAKE_USER_ID_RE.test(plain)) problems.push('a real account id');
  }
  for (const [guid] of content.matchAll(GUID_RE)) {
    if (!FAKE_USER_ID_RE.test(guid) && guid !== FAKE_PHOTO_GUID) {
      problems.push('a GUID that is not a reserved fake (an account id or a photo path)');
    }
  }
  return problems;
}

describe('ss.ge fixtures', () => {
  const files = readdirSync(FIXTURES).filter((name) => name.endsWith('.html'));

  it('exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)(
    '%s carries no token, phone number, name, real account id or photo path',
    (name) => {
      const content = readFileSync(new URL(name, FIXTURES), 'utf-8');
      for (const [what, pattern] of FORBIDDEN) {
        expect(pattern.test(content), `${name} contains ${what}`).toBe(false);
      }
      expect(realIdentifiers(content), name).toEqual([]);
    },
  );

  it('allows the reserved fakes and refuses anything else', () => {
    const fake = JSON.stringify({
      userId: fakeUserId(1),
      appImages: [{ fileName: fakePhotoFileName('20241105', 1, 'thumbs') }],
    });
    expect(realIdentifiers(fake)).toEqual([]);
    expect(realIdentifiers('{"userId":null}')).toEqual([]);
    expect(realIdentifiers('{"userId":"9b2c4f6e-1d3a-4b5c-8d7e-0f1a2b3c4d5e"}')).toHaveLength(2);
    expect(
      realIdentifiers(
        '{"fileName":"https://static.ss.ge/20241105/1_9b2c4f6e-1d3a-4b5c-8d7e-0f1a2b3c4d5e_thumbs.jpg"}',
      ),
    ).toHaveLength(1);
    expect(realIdentifiers('{"userId":"12345"}')).toEqual(['a real account id']);
  });
});
