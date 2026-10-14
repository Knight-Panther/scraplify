import { createHmac } from 'node:crypto';

/**
 * Hermes' generic webhook signature, version 2: hex HMAC-SHA256 over
 * `"<timestamp>." + <the exact body bytes>` (its receiver,
 * `gateway/platforms/webhook.py`, refuses a timestamp more than five minutes
 * from its own clock). The timestamp is Unix seconds, sent beside the
 * signature in `X-Webhook-Timestamp`.
 */
export function signHermesRequest(secret: string, timestamp: number, body: Uint8Array): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}
