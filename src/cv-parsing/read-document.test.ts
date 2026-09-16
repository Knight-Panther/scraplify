import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CvTooLargeError,
  EmptyCvTextError,
  readDocument,
  UnsupportedCvFormatError,
} from './read-document.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function fixture(name: string): Promise<Buffer> {
  return readFile(path.join(fixturesDir, name));
}

describe('readDocument', () => {
  it('returns base64 for a real PDF', async () => {
    const buffer = await fixture('sample-cv.pdf');
    const result = await readDocument({ filename: 'cv.pdf', buffer });
    expect(result.kind).toBe('pdf');
    if (result.kind === 'pdf') {
      expect(Buffer.from(result.base64, 'base64').equals(buffer)).toBe(true);
    }
  });

  it('extracts plain text from a real DOCX', async () => {
    const buffer = await fixture('sample-cv.docx');
    const result = await readDocument({ filename: 'cv.docx', buffer });
    expect(result.kind).toBe('text');
    if (result.kind === 'text') {
      expect(result.text).toContain('Jane Doe');
      expect(result.text).toContain('TypeScript');
    }
  });

  it('rejects a .pdf extension whose content is not actually a PDF', async () => {
    const buffer = await fixture('not-a-cv.pdf');
    await expect(readDocument({ filename: 'cv.pdf', buffer })).rejects.toBeInstanceOf(
      UnsupportedCvFormatError,
    );
  });

  it('rejects a .docx extension whose content is not a zip', async () => {
    const buffer = Buffer.from('plain text pretending to be a docx');
    await expect(readDocument({ filename: 'cv.docx', buffer })).rejects.toBeInstanceOf(
      UnsupportedCvFormatError,
    );
  });

  it('rejects an unrecognized extension', async () => {
    const buffer = await fixture('sample-cv.pdf');
    await expect(readDocument({ filename: 'cv.txt', buffer })).rejects.toBeInstanceOf(
      UnsupportedCvFormatError,
    );
  });

  it('rejects an empty file', async () => {
    await expect(
      readDocument({ filename: 'cv.pdf', buffer: Buffer.alloc(0) }),
    ).rejects.toBeInstanceOf(UnsupportedCvFormatError);
  });

  it('rejects a file over the size ceiling', async () => {
    const oversized = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(8 * 1024 * 1024 + 1)]);
    await expect(readDocument({ filename: 'cv.pdf', buffer: oversized })).rejects.toBeInstanceOf(
      CvTooLargeError,
    );
  });

  it('rejects a valid zip that is not a Word document', async () => {
    // A minimal, syntactically valid empty zip (PK\x05\x06 end-of-central-directory
    // only) — passes the local-file-header magic-byte check for a *populated*
    // zip only if it happens to start with PK\x03\x04, so build one that does
    // but has no real Word parts inside, exercising mammoth's own rejection.
    const fakeZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(20)]);
    await expect(readDocument({ filename: 'cv.docx', buffer: fakeZip })).rejects.toBeInstanceOf(
      UnsupportedCvFormatError,
    );
  });

  it('rejects a real, valid DOCX with no text content', async () => {
    const buffer = await fixture('empty-cv.docx');
    await expect(readDocument({ filename: 'cv.docx', buffer })).rejects.toBeInstanceOf(
      EmptyCvTextError,
    );
  });
});
