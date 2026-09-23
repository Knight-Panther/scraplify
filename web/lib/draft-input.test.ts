import { describe, expect, it } from 'vitest';
import {
  InvalidDraftInputError,
  MAX_BODY_CHARS,
  mailtoHref,
  readDraftEdit,
  readDraftId,
  readExpectedContentHash,
  readGenerationConsent,
  readLanguage,
} from './draft-input.js';

function form(values: Record<string, string>) {
  return { get: (name: string) => values[name] ?? null };
}

describe('draft form input', () => {
  it('requires a real uuid', () => {
    expect(readDraftId(form({ draftId: '0f8fad5b-d9cb-469f-a165-70867728950e' }))).toBe(
      '0f8fad5b-d9cb-469f-a165-70867728950e',
    );
    expect(() => readDraftId(form({ draftId: "1' or '1'='1" }))).toThrow(InvalidDraftInputError);
  });

  it('accepts only ka, en, or the listing’s own language', () => {
    expect(readLanguage(form({ language: 'ka' }))).toBe('ka');
    expect(readLanguage(form({ language: 'auto' }))).toBeUndefined();
    expect(readLanguage(form({}))).toBeUndefined();
    expect(() => readLanguage(form({ language: 'fr' }))).toThrow(InvalidDraftInputError);
  });

  it('reads consent only when the box was ticked', () => {
    expect(readGenerationConsent(form({ consent: 'on' }))).toBe(true);
    expect(readGenerationConsent(form({}))).toBe(false);
  });

  it('keeps the body exactly, normalizing only line endings, and bounds its size', () => {
    expect(readDraftEdit(form({ subject: ' Hello ', body: 'ა\r\nბ ' }))).toEqual({
      subject: 'Hello',
      body: 'ა\nბ ',
    });
    // A cover letter's form has no subject field at all.
    expect(readDraftEdit(form({ body: 'Body' })).subject).toBeNull();
    // An email whose generated subject was blank renders an empty input; an
    // untouched save posts subject: '', which must normalize to the same
    // null a blank generated subject is stored as — otherwise saving nothing
    // still changes the hash and silently withdraws a current approval.
    expect(readDraftEdit(form({ subject: '', body: 'Body' })).subject).toBeNull();
    expect(readDraftEdit(form({ subject: '   ', body: 'Body' })).subject).toBeNull();
    expect(() => readDraftEdit(form({ body: '   ' }))).toThrow(InvalidDraftInputError);
    expect(() => readDraftEdit(form({ body: 'x'.repeat(MAX_BODY_CHARS + 1) }))).toThrow(
      InvalidDraftInputError,
    );
  });

  it('requires the exact content hash the person reviewed', () => {
    const hash = 'a'.repeat(64);
    expect(readExpectedContentHash(form({ contentHash: hash }))).toBe(hash);
    expect(() => readExpectedContentHash(form({ contentHash: 'abc' }))).toThrow(
      InvalidDraftInputError,
    );
  });

  it('builds a mailto link with every part encoded and CRLF line breaks', () => {
    const href = mailtoHref('hr@example.ge', 'გამარჯობა & hello', 'Line one\nLine two?');
    expect(href).not.toBeNull();
    expect(href?.startsWith('mailto:hr@example.ge?subject=')).toBe(true);
    expect(href).toContain(`subject=${encodeURIComponent('გამარჯობა & hello')}`);
    expect(href).toContain(`body=${encodeURIComponent('Line one\r\nLine two?')}`);
    expect(mailtoHref('hr@example.ge', null, 'x')).toBe('mailto:hr@example.ge?body=x');
  });

  it('refuses to build a mailto link long enough to be unsafe, but still allows one just under the bound', () => {
    // Georgian expands ~9x under percent-encoding (3 bytes/char, 3 chars each), so
    // a short Georgian body alone is enough to cross a 1,800-character bound.
    expect(mailtoHref('hr@example.ge', null, 'გამარჯობა '.repeat(30))).toBeNull();
    expect(mailtoHref('hr@example.ge', null, 'x'.repeat(100))).not.toBeNull();
  });
});
