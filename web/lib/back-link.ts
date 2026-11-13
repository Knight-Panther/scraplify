/**
 * Back from an opportunity page to the list the reader came from: Browse,
 * or the Programmes tab (Phase 15E) when its rows pass `from=programmes`.
 *
 * `from` is looked up in an allow-list rather than trusted, and `back` is
 * only ever used as the query part of one of this app's own list routes, so
 * a crafted value cannot send the reader anywhere else. The fragment is the
 * opportunity's own id, which comes from the database, so returning lands on
 * this row even after a crawl reordered the list.
 */
const LISTS = {
  opportunities: { path: '/opportunities', label: 'Back to opportunities' },
  programmes: { path: '/programmes', label: 'Back to programmes' },
} as const;

type Param = string | string[] | undefined;

const first = (value: Param): string | undefined => (Array.isArray(value) ? value[0] : value);

export function backLink({
  back,
  from,
  opportunityId,
}: {
  back: Param;
  from: Param;
  opportunityId: string;
}): { href: string; label: string } {
  const list = first(from) === 'programmes' ? LISTS.programmes : LISTS.opportunities;
  const rawBack = first(back);
  const search = rawBack === undefined || rawBack === '' ? '' : `?${rawBack.replace(/^\?/, '')}`;
  return { href: `${list.path}${search}#opp-${opportunityId}`, label: list.label };
}
