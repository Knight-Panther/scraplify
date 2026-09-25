'use server';

import { cookies } from 'next/headers.js';
import { redirect } from 'next/navigation.js';
import { signOut } from '../auth.js';
import { LOCALE_COOKIE, currentLocale } from '../lib/locale.js';

/**
 * Flips the front-page language cookie and sends the visitor back to `/` —
 * always `/`, not `request.referer`, because `/` is the only screen that
 * reads this cookie (see `lib/locale.ts`). Redirecting to wherever the nav
 * badge was clicked from (e.g. `/opportunities`) would flip the cookie with
 * no visible effect, which reads as a broken control.
 */
export async function toggleLocale(): Promise<void> {
  const store = await cookies();
  const next = (await currentLocale()) === 'ka' ? 'en' : 'ka';
  store.set(LOCALE_COOKIE, next, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  redirect('/');
}

/**
 * The admin nav's own sign-out control (`site-header-nav.tsx`). Lives here
 * rather than under `web/lib/admin-auth.ts` for the same reason
 * `toggleLocale` lives here rather than under `lib/locale.ts`: this file is
 * this app's one shared, cross-surface nav-action module. No `requireAdmin()`
 * guard — signing out of a session that may not even be an admin session
 * (or may not exist at all) is harmless either way, and Auth.js's own
 * `signOut()` already no-ops correctly against an absent session.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/api/auth/signin' });
}
