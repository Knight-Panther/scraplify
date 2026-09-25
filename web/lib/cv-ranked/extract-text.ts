import mammoth from 'mammoth';
import * as pdfjs from 'pdfjs-dist';
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import { CvError, type CvKind, LIMITS, letterCount, sniffKind } from './document-checks.js';
import type { DocumentSummary } from './protocol.js';

/**
 * CV text extraction, run ONLY inside the CV worker (Phase 8D, change.md §7).
 *
 * PDF.js normally spawns its own worker from `workerSrc`. Here it is
 * already inside one, so its worker-side handler is installed on
 * `globalThis.pdfjsWorker` and PDF.js runs it in this same thread (its
 * documented "fake worker" path, checked in `pdfjs-dist@6.3.289`'s
 * `pdf.mjs`). No nested worker, no `workerSrc` URL and no script fetched
 * from anywhere at run time.
 *
 * `getDocument` is also given no cMap, standard-font or wasm URL (and wasm
 * and worker-side fetching are switched off), so it has
 * nothing to fetch: text extraction does not need them, and a PDF that
 * would need one yields less text rather than a network request.
 */
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const task = pdfjs.getDocument({
    data: bytes,
    useWasm: false,
    useWorkerFetch: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    verbosity: 0,
  });
  let document: Awaited<typeof task.promise>;
  try {
    document = await task.promise;
  } catch (error) {
    // PDF.js names the class; its message is not trusted or forwarded.
    if ((error as { name?: string } | null)?.name === 'PasswordException') {
      throw new CvError('encrypted');
    }
    throw new CvError('unreadable');
  }
  try {
    if (document.numPages > LIMITS.pages) throw new CvError('too_many_pages');
    const parts: string[] = [];
    let length = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item)) continue;
        parts.push(item.str, item.hasEOL ? '\n' : ' ');
        length += item.str.length + 1;
      }
      parts.push('\n');
      page.cleanup();
      if (length > LIMITS.characters) throw new CvError('too_much_text');
    }
    return { text: parts.join(''), pages: document.numPages };
  } catch (error) {
    if (error instanceof CvError) throw error;
    throw new CvError('unreadable');
  } finally {
    await task.destroy();
  }
}

async function docxText(bytes: Uint8Array): Promise<string> {
  try {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const result = await mammoth.extractRawText({ arrayBuffer: buffer as ArrayBuffer });
    return result.value;
  } catch {
    throw new CvError('unreadable');
  }
}

export async function extractText(file: File): Promise<{ text: string; summary: DocumentSummary }> {
  if (file.size > LIMITS.bytes) throw new CvError('too_large');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind: CvKind = sniffKind(file.name, bytes);

  let text: string;
  let pages: number | null = null;
  if (kind === 'pdf') {
    const result = await pdfText(bytes);
    text = result.text;
    pages = result.pages;
  } else {
    text = await docxText(bytes);
  }

  if (text.length > LIMITS.characters) throw new CvError('too_much_text');
  // A scanned PDF yields page furniture at most. Change.md §7: ask for a
  // text PDF or DOCX rather than upload it anywhere for OCR.
  if (letterCount(text) < LIMITS.minimumLetters) throw new CvError('no_text');
  return { text, summary: { kind, pages, characters: text.length } };
}
