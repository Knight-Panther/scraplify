'use server';

import { cookies } from 'next/headers.js';
import { redirect } from 'next/navigation.js';
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
