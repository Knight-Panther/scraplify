import { cookies } from 'next/headers.js';

/**
 * The front page's language switch (Phase 3E follow-up). Scoped to `/`
 * only — every other screen still reads `src/browse/queries.ts` labels and
 * `labels.ts` enum copy in English regardless of this cookie, so the switch
 * always redirects back to `/` rather than the page it was clicked from
 * (see `toggleLocale` in `app/actions.ts`).
 */
export type Locale = 'en' | 'ka';

export const LOCALE_COOKIE = 'xtelo-locale';

export async function currentLocale(): Promise<Locale> {
  const store = await cookies();
  return store.get(LOCALE_COOKIE)?.value === 'ka' ? 'ka' : 'en';
}
