import { describe, expect, it } from 'vitest';
import {
  isAdminAuthRoute,
  isAdminDashboardRoute,
  isPublicRoute,
  isStaticAssetRoute,
  resolveAdminAccess,
} from './surface-routing.js';

describe('isPublicRoute', () => {
  it.each([
    '/',
    '/opportunities',
    '/opportunities/abc-123',
    '/listings',
    '/listings/held',
    '/cv-ranked',
    '/api/matching/manifest',
    '/api/matching/bundles/abc/opportunities.json',
  ])('allows %s', (pathname) => {
    expect(isPublicRoute(pathname)).toBe(true);
  });

  it.each(['/admin', '/admin/sources', '/api/auth/session', '/profile', '/health', '/review'])(
    'refuses %s',
    (pathname) => {
      expect(isPublicRoute(pathname)).toBe(false);
    },
  );

  it('does not treat a route with a shared prefix as a match', () => {
    // A hypothetical future `/opportunities-archive` route must not be
    // allowed just because it starts with the same characters as
    // `/opportunities` — `pathIs` requires an exact match or a `/` boundary.
    expect(isPublicRoute('/opportunitiesarchive')).toBe(false);
    expect(isPublicRoute('/listingsx')).toBe(false);
    expect(isPublicRoute('/cv-rankedx')).toBe(false);
    expect(isPublicRoute('/api/matchingx')).toBe(false);
    expect(isPublicRoute('/api')).toBe(false);
  });
});

describe('isAdminAuthRoute', () => {
  it.each(['/api/auth', '/api/auth/session', '/api/auth/callback/github', '/api/auth/signin'])(
    'allows %s',
    (pathname) => {
      expect(isAdminAuthRoute(pathname)).toBe(true);
    },
  );

  it.each(['/admin', '/api', '/api/authx', '/opportunities'])('refuses %s', (pathname) => {
    expect(isAdminAuthRoute(pathname)).toBe(false);
  });
});

describe('isAdminDashboardRoute', () => {
  it.each(['/admin', '/admin/sources', '/admin/duplicates'])('allows %s', (pathname) => {
    expect(isAdminDashboardRoute(pathname)).toBe(true);
  });

  it.each(['/adminx', '/api/auth/session', '/opportunities', '/'])('refuses %s', (pathname) => {
    expect(isAdminDashboardRoute(pathname)).toBe(false);
  });

  it('does not treat a real route that merely LOOKS like a static asset as one', () => {
    // This app's own crawl sources are named `jobs.ge`/`hr.ge` — a real
    // future admin route for one of them must still be gated, not skipped
    // as if it were a file. isAdminDashboardRoute itself doesn't do any
    // extension-based guessing at all, so this just pins that down.
    expect(isAdminDashboardRoute('/admin/sources/jobs.ge')).toBe(true);
  });
});

describe('isStaticAssetRoute', () => {
  it.each(['/logo.png', '/hero-bg.mp4', '/icon.svg'])('allows %s', (pathname) => {
    expect(isStaticAssetRoute(pathname)).toBe(true);
  });

  it.each([
    '/admin/sources/jobs.ge',
    '/opportunities/jobs.ge-listing-123',
    '/logo.png/extra',
    '/logo.png.evil',
    '/LOGO.PNG',
  ])('refuses %s (an exact allowlist, not an extension heuristic)', (pathname) => {
    expect(isStaticAssetRoute(pathname)).toBe(false);
  });
});

describe('resolveAdminAccess', () => {
  it('allows an admin session', () => {
    expect(resolveAdminAccess({ user: { isAdmin: true } })).toBe('allow');
  });

  it('sends to sign-in when there is no session at all', () => {
    expect(resolveAdminAccess(null)).toBe('signin');
    expect(resolveAdminAccess(undefined)).toBe('signin');
  });

  it('denies (404) rather than redirects a real session that is not allowlisted', () => {
    // The case an infinite redirect loop came from: a genuinely
    // authenticated, genuinely non-admin session. Sending this back to
    // sign-in would just replay the same already-valid GitHub session and
    // land here again — it must be a hard denial instead.
    expect(resolveAdminAccess({ user: { isAdmin: false } })).toBe('deny');
    expect(resolveAdminAccess({ user: {} })).toBe('deny');
  });
});
