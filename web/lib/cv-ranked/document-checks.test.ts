import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CvError, inspectZip, LIMITS, letterCount, sniffKind } from './document-checks.js';

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../../../src/cv-parsing/fixtures/${name}`, import.meta.url)),
  );

/** A one-entry zip whose central directory declares `uncompressed` bytes and `flags`. */
function zip({ uncompressed = 10, flags = 0, entries = 1 } = {}): Uint8Array {
  const name = new TextEncoder().encode('a.xml');
  const local = new Uint8Array(30 + name.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  local.set(name, 30);
  lv.setUint16(26, name.length, true);

  const central = new Uint8Array((46 + name.length) * entries);
  const cv = new DataView(central.buffer);
  for (let i = 0; i < entries; i++) {
    const at = i * (46 + name.length);
    cv.setUint32(at, 0x02014b50, true);
    cv.setUint16(at + 8, flags, true);
    cv.setUint32(at + 24, uncompressed, true);
    cv.setUint16(at + 28, name.length, true);
    central.set(name, at + 46);
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries, true);
  ev.setUint16(10, entries, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);

  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(eocd, local.length + central.length);
  return out;
}

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof CvError ? error.code : 'not-a-CvError';
  }
}

describe('sniffKind', () => {
  it('accepts the real PDF and DOCX fixtures', () => {
    expect(sniffKind('cv.pdf', fixture('sample-cv.pdf'))).toBe('pdf');
    expect(sniffKind('CV.DOCX', fixture('sample-cv.docx'))).toBe('docx');
  });

  it('requires extension and content to agree', () => {
    expect(code(() => sniffKind('cv.pdf', fixture('sample-cv.docx')))).toBe('type_mismatch');
    expect(code(() => sniffKind('cv.docx', fixture('sample-cv.pdf')))).toBe('type_mismatch');
    expect(code(() => sniffKind('cv.doc', fixture('sample-cv.docx')))).toBe('unsupported_type');
  });

  it('recognises an encrypted Office file by its OLE wrapper', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(code(() => sniffKind('cv.docx', ole))).toBe('encrypted');
  });

  it('refuses empty and oversized files before reading them', () => {
    expect(code(() => sniffKind('cv.pdf', new Uint8Array()))).toBe('unreadable');
    expect(code(() => sniffKind('cv.pdf', new Uint8Array(LIMITS.bytes + 1)))).toBe('too_large');
  });
});

describe('inspectZip', () => {
  it('sums declared sizes of a real docx', () => {
    const result = inspectZip(fixture('sample-cv.docx'));
    expect(result.entries).toBeGreaterThan(0);
    expect(result.uncompressedBytes).toBeGreaterThan(0);
  });

  it('refuses a zip bomb by its declared size, without inflating it', () => {
    expect(code(() => inspectZip(zip({ uncompressed: LIMITS.docxUncompressedBytes + 1 })))).toBe(
      'too_large',
    );
    expect(code(() => inspectZip(zip({ uncompressed: 0xffffffff })))).toBe('too_large');
  });

  it('refuses too many entries and encrypted entries', () => {
    expect(code(() => inspectZip(zip({ entries: LIMITS.docxEntries + 1 })))).toBe('too_large');
    expect(code(() => inspectZip(zip({ flags: 1 })))).toBe('encrypted');
  });

  it('refuses a truncated archive', () => {
    const whole = zip();
    expect(code(() => inspectZip(whole.slice(0, whole.length - 5)))).toBe('unreadable');
  });
});

describe('letterCount', () => {
  it('counts Georgian and Latin letters but not digits, bullets or spaces', () => {
    expect(letterCount('ბუღალტერი CV • 2024 —')).toBe(11);
  });
});
