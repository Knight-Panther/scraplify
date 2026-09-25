/**
 * Cheap, parser-free checks run on a CV's bytes inside the worker BEFORE
 * PDF.js or mammoth sees them (Phase 8D, change.md §7 "File handling").
 * Pure functions over bytes, so they are unit-tested in Node.
 *
 * The limits match the operator flow's own `src/cv-parsing/read-document.ts`
 * (8 MiB) and add the bounds a browser needs because it has no server to
 * absorb a hostile file: pages, extracted characters and a DOCX's
 * decompressed size (a zip bomb inflates inside the visitor's own tab).
 */

export const LIMITS = {
  bytes: 8 * 1024 * 1024,
  pages: 40,
  characters: 200_000,
  /** Sum of every zip entry's declared uncompressed size. */
  docxUncompressedBytes: 60 * 1024 * 1024,
  docxEntries: 2_000,
  /** Below this many letters a PDF is treated as scanned/image-only. */
  minimumLetters: 40,
  /** Whole-job wall clock, enforced by terminating the worker. */
  timeoutMs: 45_000,
} as const;

/** Bounded failure codes. Never free text: a raw parser error can echo document content. */
export type CvErrorCode =
  | 'too_large'
  | 'unsupported_type'
  | 'type_mismatch'
  | 'encrypted'
  | 'too_many_pages'
  | 'no_text'
  | 'too_much_text'
  | 'unreadable'
  | 'timeout'
  | 'bundle_unavailable'
  | 'bundle_stale'
  | 'bundle_incompatible'
  | 'bundle_integrity'
  | 'network'
  | 'internal';

export class CvError extends Error {
  constructor(readonly code: CvErrorCode) {
    super(code);
    this.name = 'CvError';
  }
}

export type CvKind = 'pdf' | 'docx';

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
// An encrypted .docx is not a zip at all: Office wraps it in an OLE
// compound file, so it arrives with this signature and a .docx name.
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Extension AND magic bytes must agree, like the operator flow. The
 * extension is read here and then discarded; the file name is never
 * stored, sent or shown.
 */
export function sniffKind(name: string, bytes: Uint8Array): CvKind {
  if (bytes.byteLength > LIMITS.bytes) throw new CvError('too_large');
  if (bytes.byteLength === 0) throw new CvError('unreadable');
  const extension = extensionOf(name);
  if (extension === '.pdf') {
    if (!startsWith(bytes, PDF_MAGIC)) throw new CvError('type_mismatch');
    return 'pdf';
  }
  if (extension === '.docx') {
    if (startsWith(bytes, OLE_MAGIC)) throw new CvError('encrypted');
    if (!startsWith(bytes, ZIP_MAGIC)) throw new CvError('type_mismatch');
    inspectZip(bytes);
    return 'docx';
  }
  throw new CvError('unsupported_type');
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/**
 * Walks the zip central directory and refuses an archive whose declared
 * uncompressed total or entry count is over the limit, before anything is
 * inflated. ZIP64 (sizes of 0xFFFFFFFF) is refused outright: no real CV
 * needs a 4 GiB entry, and honouring it would mean trusting a second,
 * larger set of declared sizes.
 *
 * Declared sizes can lie, so this is a first gate, not the only one: the
 * worker's wall-clock timeout and the character cap still bound what
 * mammoth actually produces.
 */
export function inspectZip(bytes: Uint8Array): { entries: number; uncompressedBytes: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const lowest = Math.max(0, bytes.byteLength - EOCD_MIN - MAX_COMMENT);
  for (let offset = bytes.byteLength - EOCD_MIN; offset >= lowest; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) throw new CvError('unreadable');

  const entries = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (entries === 0xffff || directoryOffset === 0xffffffff) throw new CvError('too_large');
  if (entries > LIMITS.docxEntries) throw new CvError('too_large');
  if (directoryOffset + directorySize > eocd) throw new CvError('unreadable');

  let offset = directoryOffset;
  let uncompressedBytes = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new CvError('unreadable');
    }
    const flags = view.getUint16(offset + 8, true);
    // Bit 0: the entry is encrypted (a password-protected zip, not a docx).
    if ((flags & 0x1) !== 0) throw new CvError('encrypted');
    const size = view.getUint32(offset + 24, true);
    if (size === 0xffffffff) throw new CvError('too_large');
    uncompressedBytes += size;
    if (uncompressedBytes > LIMITS.docxUncompressedBytes) throw new CvError('too_large');
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, uncompressedBytes };
}

/** Letters in any script: the image-only test must not count digits, bullets or spaces. */
export function letterCount(text: string): number {
  return text.match(/\p{L}/gu)?.length ?? 0;
}
