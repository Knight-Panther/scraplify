import { expect, request, test } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import {
  ADMIN_GITHUB_ID,
  NON_ADMIN_GITHUB_ID,
  origin,
  type SurfaceName,
  TEST_AUTH_SECRET,
} from './servers.js';

/**
 * Route-level surface enforcement against three real servers (see
 * `playwright.surfaces.config.ts`). Every request is a direct URL with
 * redirects NOT followed, so each assertion is about what that one surface
 * answers, not where a browser would end up.
 *
 * A proxy-level refusal (`proxy.ts`'s `refuse()`) is a 404 with an EMPTY
 * body; Next's own not-found page is a 404 with HTML. The two are asserted
 * separately on purpose: "this path 404s" alone would also pass if the proxy
 * let the request through and the page happened not to exist, which is not
 * the boundary this suite is here to prove.
 */

const STATIC_ASSETS = ['/icon.svg', '/logo.png', '/hero-bg.mp4'];
const PUBLIC_ROUTES = ['/', '/opportunities', '/listings'];
const LOCAL_ONLY_ROUTES = [
  '/saved',
  '/review',
  '/health',
  '/ranked',
  '/drafts',
  '/drafts/new',
  '/profile',
  '/taxonomy-review',
];
const ADMIN_ROUTES = ['/admin', '/admin/duplicates', '/admin/taxonomy', '/admin/sources'];
const SESSION_COOKIE = 'authjs.session-token';

interface Reply {
  status: number;
  location: string | undefined;
  body: Buffer;
}

async function get(surface: SurfaceName, path: string, cookie?: string): Promise<Reply> {
  const context = await request.newContext({
    baseURL: origin(surface),
    extraHTTPHeaders: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });
  try {
    const response = await context.get(path, { maxRedirects: 0 });
    return {
      status: response.status(),
      location: response.headers().location,
      body: await response.body(),
    };
  } finally {
    await context.dispose();
  }
}

async function expectProxyRefusal(surface: SurfaceName, path: string): Promise<void> {
  const reply = await get(surface, path);
  expect(reply.status, `${surface} ${path}`).toBe(404);
  expect(reply.body.length, `${surface} ${path} should be the proxy's bare 404`).toBe(0);
}

/** A real Auth.js session cookie, encrypted with the admin server's own secret. */
async function sessionCookie(githubId: string): Promise<string> {
  return encode({
    token: { sub: githubId, name: 'E2E user', githubId },
    secret: TEST_AUTH_SECRET,
    salt: SESSION_COOKIE,
  });
}

test.describe('every surface', () => {
  for (const surface of ['local', 'public', 'admin'] as const) {
    for (const asset of STATIC_ASSETS) {
      test(`${surface} serves ${asset}`, async () => {
        expect((await get(surface, asset)).status).toBe(200);
      });
    }
  }
});

test.describe('XTELO_SURFACE=local', () => {
  for (const path of [...PUBLIC_ROUTES, ...LOCAL_ONLY_ROUTES]) {
    test(`serves ${path}`, async () => {
      expect((await get('local', path)).status).toBe(200);
    });
  }

  for (const path of ['/api/auth/signin', '/api/auth/session']) {
    test(`refuses ${path} at the proxy`, async () => {
      await expectProxyRefusal('local', path);
    });
  }

  // The proxy lets `/admin*` through on local; `requireAdmin()` in the admin
  // layout is what refuses (it 404s off the admin surface).
  for (const path of ADMIN_ROUTES) {
    test(`does not render ${path}`, async () => {
      expect((await get('local', path)).status).toBe(404);
    });
  }
});

test.describe('XTELO_SURFACE=public', () => {
  for (const path of PUBLIC_ROUTES) {
    test(`serves ${path}`, async () => {
      expect((await get('public', path)).status).toBe(200);
    });
  }

  for (const path of [
    ...LOCAL_ONLY_ROUTES,
    ...ADMIN_ROUTES,
    '/api/auth/signin',
    '/api/auth/session',
    // Prefix look-alikes: an allow-list matched by `startsWith` alone would pass these.
    '/opportunities-export',
    '/listingsx',
    '/admin/sources/jobs.ge',
  ]) {
    test(`refuses ${path} at the proxy`, async () => {
      await expectProxyRefusal('public', path);
    });
  }
});

test.describe('XTELO_SURFACE=admin', () => {
  for (const path of [...PUBLIC_ROUTES, ...LOCAL_ONLY_ROUTES, '/adminx']) {
    test(`refuses ${path} at the proxy`, async () => {
      await expectProxyRefusal('admin', path);
    });
  }

  test('leaves /api/auth/* reachable without a session (it is the sign-in flow)', async () => {
    expect((await get('admin', '/api/auth/session')).status).toBe(200);
  });

  for (const path of ADMIN_ROUTES) {
    test(`redirects an unauthenticated ${path} to sign-in`, async () => {
      const response = await get('admin', path);
      expect(response.status).toBe(307);
      const location = new URL(response.location ?? '', origin('admin'));
      expect(location.pathname).toBe('/api/auth/signin');
      expect(location.searchParams.get('callbackUrl')).toBe(path);
    });
  }

  test('keeps the query string through the sign-in round trip', async () => {
    const response = await get('admin', '/admin/taxonomy?text=manager&show=100');
    const location = new URL(response.location ?? '', origin('admin'));
    expect(location.searchParams.get('callbackUrl')).toBe('/admin/taxonomy?text=manager&show=100');
  });

  for (const path of ADMIN_ROUTES) {
    test(`refuses a signed-in but non-allowlisted user on ${path}`, async () => {
      const response = await get('admin', path, await sessionCookie(NON_ADMIN_GITHUB_ID));
      expect(response.status).toBe(404);
      expect(response.body.length).toBe(0);
    });

    test(`serves ${path} to an allowlisted admin`, async () => {
      const response = await get('admin', path, await sessionCookie(ADMIN_GITHUB_ID));
      expect(response.status).toBe(200);
    });
  }

  test('rejects a session cookie signed with a different secret', async () => {
    const forged = await encode({
      token: { sub: ADMIN_GITHUB_ID, githubId: ADMIN_GITHUB_ID },
      secret: 'a-different-secret-an-attacker-might-guess-0123',
      salt: SESSION_COOKIE,
    });
    const response = await get('admin', '/admin', forged);
    expect(response.status).toBe(307);
  });
});
