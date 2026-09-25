import type { CvErrorCode } from './document-checks.js';
import { LIMITS } from './document-checks.js';
import type { Stage } from './protocol.js';

/**
 * CV Ranked's user-facing text (Phase 8D). The privacy promise is change.md
 * §2's exact wording, which is deliberately narrower than "deleted": it
 * promises no intentional transmission or persistence, which is what the
 * app actually controls.
 */
export const PRIVACY_PROMISE =
  'The selected CV is read and analysed in this browser. Xtelo does not intentionally upload or store the file, extracted text, profile, embedding or ranking results. Closing or refreshing the tab clears the current session. Public model files and the vacancy index may remain in the browser cache.';

export const STAGES: readonly { stage: Stage; label: string }[] = [
  { stage: 'reading', label: 'Reading the CV' },
  { stage: 'bundle', label: 'Loading the vacancy index' },
  { stage: 'ranking', label: 'Matching and ranking' },
];

const MIB = LIMITS.bytes / 1024 / 1024;

/** One message per bounded error code. Never the parser's own text, which can quote the file. */
export const ERROR_MESSAGES: Readonly<Record<CvErrorCode, { title: string; body: string }>> = {
  too_large: {
    title: 'This file is too large',
    body: `CVs up to ${MIB} MB can be read, and a DOCX must not unpack to far more than a CV would. Try a smaller PDF or DOCX.`,
  },
  unsupported_type: {
    title: 'Only PDF and DOCX can be read',
    body: 'Save the CV as a PDF or a Word .docx file and choose it again.',
  },
  type_mismatch: {
    title: 'The file does not match its extension',
    body: 'Its contents are not what the name says (a renamed file, for example). Save it again as a real PDF or DOCX.',
  },
  encrypted: {
    title: 'This file is password-protected',
    body: 'Save a copy without a password and choose that instead.',
  },
  too_many_pages: {
    title: 'This PDF is too long',
    body: `Up to ${LIMITS.pages} pages can be read. Choose a shorter version of the CV.`,
  },
  no_text: {
    title: 'No text could be read',
    body: 'This looks like a scanned or image-only file. Xtelo does not send files anywhere for text recognition, so choose a PDF with selectable text, or a DOCX.',
  },
  too_much_text: {
    title: 'This file holds too much text',
    body: `Up to ${LIMITS.characters.toLocaleString('en-GB')} characters can be read, far more than a CV. Choose the CV on its own.`,
  },
  unreadable: {
    title: 'The file could not be read',
    body: 'It may be damaged, or not really a PDF or DOCX. Try exporting it again.',
  },
  timeout: {
    title: 'Reading took too long',
    body: `Processing stopped after ${LIMITS.timeoutMs / 1000} seconds. Try a simpler or smaller version of the file.`,
  },
  bundle_unavailable: {
    title: 'The vacancy index is not available',
    body: 'Nothing can be ranked until it is back. Browse still works.',
  },
  bundle_stale: {
    title: 'Matching is paused: the vacancy index is out of date',
    body: 'The index is older than 72 hours, so ranking is paused rather than showing vacancies that may have closed. Browse still shows current data.',
  },
  bundle_incompatible: {
    title: 'This page and the vacancy index do not match',
    body: 'One of them was updated. Reload the page to get the current version.',
  },
  bundle_integrity: {
    title: 'The vacancy index failed its integrity check',
    body: 'It was not used. Try again in a little while.',
  },
  network: {
    title: 'The vacancy index could not be downloaded',
    body: 'Check the connection and try again.',
  },
  internal: {
    title: 'Something went wrong',
    body: 'Processing stopped. Nothing was sent anywhere. Try again, or try the other file format.',
  },
};
