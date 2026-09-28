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

/**
 * Georgian unless the visitor chose English (owner decision, 2026-09-28):
 * the audience is Georgian, and a crawler or a first visit carries no cookie,
 * so search results and link previews get Georgian too.
 */
export async function currentLocale(): Promise<Locale> {
  const store = await cookies();
  return store.get(LOCALE_COOKIE)?.value === 'en' ? 'en' : 'ka';
}
