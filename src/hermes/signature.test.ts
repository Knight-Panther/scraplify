import { describe, expect, it } from 'vitest';
import { signHermesRequest } from './signature.js';

describe('signHermesRequest', () => {
  // The same vector from Python, which is what Hermes verifies with:
  //   hmac.new(b'test-secret-0123456789',
  //            b'1791900000.' + b'{"event_type":"xtelo.test","schema":1}',
  //            hashlib.sha256).hexdigest()
  const secret = 'test-secret-0123456789';
  const timestamp = 1791900000;
  const body = Buffer.from('{"event_type":"xtelo.test","schema":1}');
  const digest = '100e5d554d2c14d1540806dc2bc256ea1a7061e740bb8e84e922fa1e9cd82ad2';

  it('gives the known digest for a fixed secret, timestamp and body', () => {
    expect(signHermesRequest(secret, timestamp, body)).toBe(digest);
  });

  it('binds the timestamp, the body and the secret', () => {
    expect(signHermesRequest(secret, timestamp + 1, body)).not.toBe(digest);
    expect(signHermesRequest(secret, timestamp, Buffer.from(`${body} `))).not.toBe(digest);
    expect(signHermesRequest(`${secret}x`, timestamp, body)).not.toBe(digest);
  });

  it('signs the bytes, so Georgian text in a body is not re-encoded', () => {
    const georgian = Buffer.from('{"host":"თბილისი"}', 'utf8');
    expect(signHermesRequest(secret, timestamp, georgian)).toBe(
      signHermesRequest(secret, timestamp, new Uint8Array(georgian)),
    );
  });
});
