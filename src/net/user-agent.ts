/**
 * Identifies this project's crawler to source sites per ordinary crawling
 * etiquette (a bare, anonymous User-Agent gives a site operator no way to
 * reach out about unexpected load or behavior). Points at the public repo
 * rather than a personal contact — project decision, 2026-09-05 — since no
 * project-specific contact address or page exists yet.
 */
const DEFAULT_USER_AGENT = 'ScraplifyBot/0.1 (+https://github.com/Knight-Panther/scraplify)';

/** Overridable via SCRAPLIFY_USER_AGENT for a future deployment with its own contact details. */
export function resolveUserAgent(): string {
  const configured = process.env.SCRAPLIFY_USER_AGENT?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_USER_AGENT;
}
