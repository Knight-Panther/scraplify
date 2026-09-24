import type { ReactNode } from 'react';
import { requireAdmin } from '../../../lib/admin-auth.js';

/**
 * The admin shell (Stage 8, change.md §5/§13). Calls `requireAdmin()` itself
 * — not because a layout check is sufficient on its own (Next's own
 * authentication guide warns it isn't: "a layout also does not control
 * whether the rest of the route renders," since Partial Rendering means a
 * layout doesn't re-run on every navigation) — but so an admin session is
 * confirmed to exist before this shell renders anything at all. Every page
 * under `/admin/*` ALSO calls `requireAdmin()` independently, which is the
 * check that actually matters per-request.
 *
 * No nav/header of its own: `SiteHeader`/`SiteHeaderNav` (the root layout,
 * `web/app/layout.tsx`) already render `admin`'s own nav and sign-out
 * control (Stage 8) — a second header here would duplicate it.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  return <>{children}</>;
}
