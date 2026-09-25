import type { Surface } from './surface.js';

/**
 * The Content Security Policy (Phase 8E, change.md §11: "strict CSP; CV
 * pages connect only to required same-origin assets/endpoints").
 *
 * The threat it answers is XSS as CV exfiltration: a CV is read in this
 * page's own worker, so any injected script could read it and send it
 * anywhere. With this policy an injected script does not run (scripts need
 * this response's nonce), and even one that did could only talk to this
 * origin (`connect-src 'self'`, no third-party anything).
 *
 * - Scripts: a fresh nonce per response plus `'strict-dynamic'`, the pattern
 *   Next's own CSP guide gives. Next reads the nonce from the request's CSP
 *   header and stamps it on its own scripts, which works because every page
 *   is already dynamically rendered (`force-dynamic` in the root layout).
 *   `'unsafe-eval'` is added in development only, where React needs it.
 * - Workers: `'self'` only. The CV worker is a same-origin `_next/static`
 *   chunk, and PDF.js runs in-thread inside it (no blob: or nested worker).
 * - Styles keep `'unsafe-inline'`: React renders `style` attributes, which a
 *   nonce cannot cover, and style injection cannot read or send the CV.
 * - `form-action` also allows GitHub on `admin`, whose sign-in form redirects
 *   there (browsers apply `form-action` to a form's redirects too).
 * - No `upgrade-insecure-requests`: every load is same-origin already, and
 *   HTTPS is enforced by the reverse proxy's HSTS, not by rewriting URLs.
 */
export function contentSecurityPolicy(options: {
  nonce: string;
  surface: Surface;
  dev: boolean;
}): string {
  const { nonce, surface, dev } = options;
  const directives: [string, ...string[]][] = [
    ['default-src', "'self'"],
    [
      'script-src',
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(dev ? ["'unsafe-eval'"] : []),
    ],
    ['style-src', "'self'", "'unsafe-inline'"],
    ['img-src', "'self'", 'data:'],
    ['font-src', "'self'"],
    ['media-src', "'self'"],
    ['connect-src', "'self'", ...(dev ? ['ws:'] : [])],
    ['worker-src', "'self'"],
    ['manifest-src', "'self'"],
    ['frame-src', "'none'"],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'self'", ...(surface === 'admin' ? ['https://github.com'] : [])],
    ['frame-ancestors', "'none'"],
  ];
  return directives.map((directive) => directive.join(' ')).join('; ');
}

/** A per-response nonce: 128 random bits, base64. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
