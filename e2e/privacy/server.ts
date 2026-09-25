/**
 * The one production server the CV Ranked privacy suite runs against, shared
 * by `playwright.privacy.config.ts` (which starts it) and the spec (which
 * drives it and then reads its log).
 *
 * It is the `public` surface on purpose: that is the process a hosted
 * visitor's CV page talks to, so it is the one whose logs and database access
 * the privacy promise is about.
 */
export const PRIVACY_PORT = 3103;
export const PRIVACY_ORIGIN = `http://127.0.0.1:${PRIVACY_PORT}`;
/** Under `tmp/` (gitignored). Truncated each time the server starts. */
export const PRIVACY_SERVER_LOG = 'tmp/e2e-privacy/public-server.log';
