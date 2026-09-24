import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mocks only the identity-resolution boundary (`auth()` from `web/auth.ts`,
 * which itself decodes a real HTTP request's session cookie — machinery
 * that needs a real request, not a bare vitest test, and is already proven
 * live via Stage 6/7/8's own forged-cookie build-record verification). Every
 * other piece — `resolveAdminAccess`, `redirect()`/`notFound()` — runs for
 * real, so this test exercises `requireAdmin()`'s actual logic, not a mock
 * of it.
 *
 * `requireAdmin()` is wrapped in React's `cache()` (per-render memoization),
 * which is a genuine no-op outside an active React render pass — verified
 * directly before writing this file, since a real cache here would have
 * made every test after the first see the first test's mocked session.
 */
const authMock = vi.fn();
vi.mock('../auth.js', () => ({ auth: () => authMock() }));

const { requireAdmin, isDeniedError } = await import('./admin-auth.js');

describe('requireAdmin', () => {
  // Every test below exercises the real `auth()`-reached decision logic, so
  // the surface must genuinely be `admin` for them — vitest sets no
  // `XTELO_SURFACE` at all, which `currentSurface()` defaults to `local`,
  // and the one test below that deliberately wants that default unsets it.
  beforeEach(() => {
    process.env.XTELO_SURFACE = 'admin';
  });

  afterEach(() => {
    delete process.env.XTELO_SURFACE;
  });

  it('404s off the admin surface without ever calling auth() (no AUTH_SECRET there to crash on)', async () => {
    delete process.env.XTELO_SURFACE;
    authMock.mockClear();
    await expect(requireAdmin()).rejects.toMatchObject({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
    });
    expect(authMock).not.toHaveBeenCalled();
  });

  it('redirects to sign-in when there is no session at all', async () => {
    authMock.mockResolvedValueOnce(null);
    await expect(requireAdmin()).rejects.toMatchObject({
      digest: expect.stringContaining('NEXT_REDIRECT'),
    });
  });

  it('404s (denies) a real session that is not allowlisted, never redirects it', async () => {
    // The exact case Stage 6/7's own redirect-loop fix exists for — reused
    // here at the DAL layer via the same `resolveAdminAccess`, not a
    // separately re-derived rule.
    authMock.mockResolvedValueOnce({ user: { isAdmin: false } });
    await expect(requireAdmin()).rejects.toMatchObject({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
    });
  });

  it('returns the session for an allowlisted admin', async () => {
    const session = { user: { isAdmin: true, name: 'Test Admin' } };
    authMock.mockResolvedValueOnce(session);
    await expect(requireAdmin()).resolves.toBe(session);
  });

  it("attaches the denied actor's GitHub id for Stage 11's audit trail to read", async () => {
    authMock.mockResolvedValueOnce({ user: { isAdmin: false, githubId: '424242' } });
    try {
      await requireAdmin();
      expect.unreachable('requireAdmin() should have thrown for a non-admin session');
    } catch (error) {
      expect(isDeniedError(error)).toBe(true);
      if (isDeniedError(error)) expect(error.deniedActorGithubId).toBe('424242');
    }
  });
});
