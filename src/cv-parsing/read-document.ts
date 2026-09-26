import { docxText } from './docx-text.js';

/**
 * Turns an uploaded CV file into something `extract-claims.ts` can hand to
 * Claude: a PDF stays as bytes (the Messages API reads PDFs natively), a DOCX
 * is reduced to plain text first since the API has no native DOCX input.
 *
 * Deliberately not a dependency on Phase 4's attachment-safety machinery —
 * Phase 4 isn't built, and the concept doc treats a direct user upload as a
 * different trust surface than a scraped/discovered resource (no SSRF, no
 * redirect chain, no host policy to enforce). This is a small, purpose-built
 * check instead: extension AND magic bytes must agree, and a size ceiling
 * applies before anything is read further.
 */

const MAX_CV_BYTES = 8 * 1024 * 1024;

export class CvTooLargeError extends Error {
  readonly code = 'CV_TOO_LARGE';
  constructor(byteLength: number) {
    super(`CV file is ${byteLength} bytes, over the ${MAX_CV_BYTES} byte limit.`);
    this.name = 'CvTooLargeError';
  }
}

export class UnsupportedCvFormatError extends Error {
  readonly code = 'UNSUPPORTED_CV_FORMAT';
  constructor(reason: string) {
    super(`Unsupported CV file: ${reason}. Only .pdf and .docx are accepted.`);
    this.name = 'UnsupportedCvFormatError';
  }
}

export class EmptyCvTextError extends Error {
  readonly code = 'EMPTY_CV_TEXT';
  constructor() {
    super('No extractable text was found in this CV file.');
    this.name = 'EmptyCvTextError';
  }
}

export type ReadDocumentResult = { kind: 'pdf'; base64: string } | { kind: 'text'; text: string };

const PDF_MAGIC = '%PDF-';
// The zip local-file-header signature. A real .docx is a zip archive, so
// anything not starting with this is not a Word package regardless of its
// extension — `mammoth` is left to reject anything that passes this check
// but still isn't a valid Word document.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

export async function readDocument(input: {
  filename: string;
  buffer: Buffer;
}): Promise<ReadDocumentResult> {
  if (input.buffer.byteLength > MAX_CV_BYTES) {
    throw new CvTooLargeError(input.buffer.byteLength);
  }
  if (input.buffer.byteLength === 0) {
    throw new UnsupportedCvFormatError('the file is empty');
  }

  const ext = extensionOf(input.filename);

  if (ext === '.pdf') {
    const isPdf = input.buffer.subarray(0, PDF_MAGIC.length).toString('latin1') === PDF_MAGIC;
    if (!isPdf) throw new UnsupportedCvFormatError('file extension is .pdf but the content is not');
    return { kind: 'pdf', base64: input.buffer.toString('base64') };
  }

  if (ext === '.docx') {
    const isZip = input.buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC);
    if (!isZip)
      throw new UnsupportedCvFormatError('file extension is .docx but the content is not');
    let extracted: string;
    try {
      extracted = await docxText({ buffer: input.buffer });
    } catch {
      // mammoth's own error may echo file structure details; never surface it.
      throw new UnsupportedCvFormatError('the .docx file could not be read');
    }
    const text = extracted.trim();
    if (text.length === 0) throw new EmptyCvTextError();
    return { kind: 'text', text };
  }

  throw new UnsupportedCvFormatError(`unrecognized extension "${ext}"`);
}
