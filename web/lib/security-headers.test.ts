import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, createNonce } from './security-headers.js';

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split('; ').map((part) => {
      const [name = '', ...values] = part.split(' ');
      return [name, values];
    }),
  );
}

describe('contentSecurityPolicy', () => {
  const production = directives(
    contentSecurityPolicy({ nonce: 'abc', surface: 'public', dev: false }),
  );

  it('runs only nonced scripts, and never eval in production', () => {
    expect(production.get('script-src')).toEqual(["'self'", "'nonce-abc'", "'strict-dynamic'"]);
    expect(production.get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('keeps every fetch, worker and form on this origin', () => {
    expect(production.get('default-src')).toEqual(["'self'"]);
    expect(production.get('connect-src')).toEqual(["'self'"]);
    expect(production.get('worker-src')).toEqual(["'self'"]);
    expect(production.get('form-action')).toEqual(["'self'"]);
  });

  it('refuses framing, plugins and base rewriting', () => {
    expect(production.get('frame-ancestors')).toEqual(["'none'"]);
    expect(production.get('frame-src')).toEqual(["'none'"]);
    expect(production.get('object-src')).toEqual(["'none'"]);
    expect(production.get('base-uri')).toEqual(["'none'"]);
  });

  it('allows GitHub as a form target on admin only, for the sign-in redirect', () => {
    const admin = directives(contentSecurityPolicy({ nonce: 'n', surface: 'admin', dev: false }));
    expect(admin.get('form-action')).toEqual(["'self'", 'https://github.com']);
    const local = directives(contentSecurityPolicy({ nonce: 'n', surface: 'local', dev: false }));
    expect(local.get('form-action')).toEqual(["'self'"]);
  });

  it('adds eval and the HMR socket in development only', () => {
    const dev = directives(contentSecurityPolicy({ nonce: 'n', surface: 'local', dev: true }));
    expect(dev.get('script-src')).toContain("'unsafe-eval'");
    expect(dev.get('connect-src')).toEqual(["'self'", 'ws:']);
  });
});

describe('createNonce', () => {
  it('is 128 random bits, base64, and different every time', () => {
    const nonces = new Set(Array.from({ length: 100 }, createNonce));
    expect(nonces.size).toBe(100);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});
