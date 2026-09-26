import { createHash } from 'node:crypto';

/**
 * Phase 7C: a listing's list-page fingerprint, the sha256 of the fields a
 * list page shows for it. A crawl fetches the detail page again only when
 * this changes (see each adapter's `needsDetailFetch`), so the fields must
 * be ones that change when the vacancy does, and never placement or
 * promotion state (VIP section, priority), which would force pointless
 * re-fetches. Whitespace is collapsed and each field kept in its own slot,
 * so a value moving between fields still changes the hash.
 */
export function discoveryFingerprint(
  fields: readonly (string | readonly string[] | null)[],
): string {
  const normalized = fields.map((field) =>
    field === null ? null : typeof field === 'string' ? collapse(field) : field.map(collapse),
  );
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function collapse(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}
