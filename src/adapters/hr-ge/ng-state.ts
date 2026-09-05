import type { CheerioAPI } from 'cheerio';

/**
 * One entry of Angular's `TransferState` island (RECON_NOTES.md): the
 * verbatim JSON body of one HTTP call the SSR server made while rendering,
 * keyed by a content hash that differs per page — lookup must go by `u`
 * (the request URL), never by that key.
 */
export interface NgStateEntry {
  /** Response body. */
  readonly b: unknown;
  readonly h?: unknown;
  /** HTTP status. */
  readonly s?: number;
  readonly st?: string;
  /** The request URL this entry's body answers. */
  readonly u: string;
  readonly rt?: string;
}

export type NgState = Readonly<Record<string, NgStateEntry>>;

export class NgStateMissingError extends Error {
  constructor(reason: string) {
    super(`hr.ge ng-state island missing or unparseable: ${reason}`);
    this.name = 'NgStateMissingError';
  }
}

const NG_STATE_SELECTOR = 'script#ng-state[type="application/json"]';

/**
 * Extracts and parses hr.ge's Angular TransferState island. Plain
 * `JSON.parse`, no entity pre-decoding: RECON_NOTES.md's correction found
 * the island escapes `<` as an ordinary uppercase-hex `<` JSON string
 * escape (which `JSON.parse` already handles natively), and pre-decoding
 * HTML entities would corrupt the `description` field's own entity-encoded
 * content, which is part of the VALUE, not the transport encoding. A
 * `<script>` tag's text content is raw text per the HTML spec (never
 * HTML-entity-decoded by the parser), which is exactly why the serializer
 * needs its own escaping scheme for `<` in the first place — `.text()`
 * below returns that raw content unmodified, matching what `JSON.parse`
 * expects.
 *
 * Throws when the island is absent or fails to parse — real structural
 * drift the caller must quarantine, not silently absorb into an empty
 * result (the same lesson jobs-ge's ninth adversarial-review round learned
 * the hard way for a scaffold that degrades quietly: docs/STATUS.md).
 */
export function extractNgState($: CheerioAPI): NgState {
  const raw = $(NG_STATE_SELECTOR).first().text();
  if (!raw) {
    throw new NgStateMissingError('no <script id="ng-state" type="application/json"> element found');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new NgStateMissingError(
      `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NgStateMissingError('parsed island is not a plain object');
  }

  return parsed as NgState;
}

/**
 * Finds the ng-state entry whose own request URL (`u`) matches `urlPattern`
 * — see NgStateEntry's own doc: lookup must go by `u`, never by the
 * per-page-varying numeric key.
 */
export function findNgStateEntry(state: NgState, urlPattern: RegExp): NgStateEntry | null {
  for (const entry of Object.values(state)) {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      typeof (entry as NgStateEntry).u === 'string' &&
      urlPattern.test((entry as NgStateEntry).u)
    ) {
      return entry as NgStateEntry;
    }
  }
  return null;
}
