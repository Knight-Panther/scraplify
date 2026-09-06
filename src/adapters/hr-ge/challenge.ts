export type HrGeResponseHealth = 'ok' | 'challenged' | 'unknown';

export interface ClassifyHrGeResponseInput {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | null {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ?? null;
}

const WAF_ACTION_HEADER = 'x-amzn-waf-action';

/**
 * Classifies an hr.ge HTTP response as healthy, WAF-challenged, or
 * inconclusive — concept §21.3: "HTTP 200 is not sufficient evidence of
 * success." A caller must back off and record a typed fetch attempt on
 * 'challenged', never attempt to solve or bypass it (§22).
 *
 * Deliberately does NOT key on the presence of the string "awswaf" or a
 * `challenge.js` reference — RECON_NOTES.md's own documented trap: AWS
 * WAF's browser SDK script tag is embedded in EVERY healthy hr.ge page,
 * including all 8 committed fixtures, so that check would flag 100% of
 * normal responses. 'challenged' is instead recognized only by signals
 * that are never present on an ordinary page (an explicit WAF action
 * header, or a status AWS WAF specifically uses for a block/challenge);
 * 'ok' additionally requires the positive health markers every real page
 * in this project's fixtures carries (`ng-server-context="ssr"` and a
 * parseable `ng-state` island — see ng-state.ts).
 *
 * No genuine WAF challenge was ever encountered during the
 * acquisition-decision spike (46 read-only requests, RECON_NOTES.md), so
 * the 'challenged' branches below are evidenced only by AWS WAF's
 * documented, publicly-known response shapes for this infrastructure, not
 * by a captured real example — that gap is recorded as still open in
 * RECON_NOTES.md, and is exactly why anything this function isn't
 * confident about returns 'unknown' rather than a guessed 'challenged'.
 * 'unknown' lets a caller fall back to its own ordinary fetch/parse-failure
 * handling instead of this function inventing a specific cause it has no
 * real evidence for.
 */
export function classifyHrGeResponse(input: ClassifyHrGeResponseInput): HrGeResponseHealth {
  if (headerValue(input.headers, WAF_ACTION_HEADER) !== null) {
    return 'challenged';
  }
  // AWS WAF's own documented response codes for a blocked/challenged
  // request: 403 (block), 405 (a captcha/challenge action rejecting the
  // method), 202 (a JS/captcha challenge issued to a browser client, not
  // applicable to this project's plain-HTTP fetcher but included for
  // completeness against a future browser-fallback path per §10.1).
  //
  // 405 was documented here but missing from the check until 2026-09-06:
  // a 405 challenge classified 'unknown', so crawl.ts's classifyHttpResult
  // saw an ordinary 'failure' rather than 'blocked', never set the run's
  // stop flag, and kept issuing requests at an actively blocking WAF —
  // contradicting both this function's own contract above and concept
  // §6.2's "honor retry instructions." The fetch-failure-rate guard meant
  // such a run could never mass-close anything, so the cost was politeness
  // and wasted requests, not corrupted state.
  if (input.status === 202 || input.status === 403 || input.status === 405) {
    return 'challenged';
  }

  const looksHealthy =
    input.body.includes('ng-server-context="ssr"') && input.body.includes('id="ng-state"');
  if (input.status === 200 && looksHealthy) {
    return 'ok';
  }

  return 'unknown';
}

/**
 * Whether a response carries an explicit rate-limit backoff signal.
 * hr.ge publishes `Ratelimit-Policy: 20;w=60` (RECON_NOTES.md) — a `429`
 * or an exhausted `Ratelimit-Remaining: 0` are first-class signals to slow
 * down, independent of (and checked before) any WAF classification above.
 */
export function isHrGeRateLimited(
  status: number,
  headers: Readonly<Record<string, string | string[] | undefined>>,
): boolean {
  if (status === 429) return true;
  return headerValue(headers, 'ratelimit-remaining') === '0';
}
