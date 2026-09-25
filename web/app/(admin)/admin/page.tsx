import { requireAdmin } from '../../../lib/admin-auth.js';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Admin · Xtelo' };

/**
 * The admin dashboard root (change.md §5's own route table). Deliberately
 * thin: the actual operational screens are `/admin/sources`,
 * `/admin/duplicates` and `/admin/taxonomy` — this page's only job is to be
 * a real, reachable `/admin` landing spot (so a sign-in's `callbackUrl` or a
 * bare `/admin` visit has somewhere to land) and name who's signed in, since
 * change.md §5/§13 asks for a dashboard root distinct from the three
 * operational screens themselves.
 */
export default async function AdminDashboardPage() {
  const session = await requireAdmin();

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">Admin</h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          Signed in as{' '}
          <span className="text-foreground">{session.user.name ?? session.user.email}</span>.
        </p>
      </header>

      <ul className="mt-8 flex flex-col gap-3">
        <DashboardLink
          href="/admin/sources"
          title="Sources"
          description="Per-source crawl health — whether each board is being crawled, and whether those crawls covered the whole corpus."
        />
        <DashboardLink
          href="/admin/duplicates"
          title="Duplicates"
          description="The duplicate-review queue — pairs the scorer proposes as the same vacancy but will not link automatically."
        />
        <DashboardLink
          href="/admin/taxonomy"
          title="Taxonomy"
          description="Inspect and correct how listings are categorized."
        />
        <DashboardLink
          href="/admin/matching"
          title="Matching"
          description="The public matching bundle — what is published for CV matching, when it was built, and whether the last build succeeded."
        />
      </ul>
    </main>
  );
}

function DashboardLink({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <li>
      <a
        href={href}
        className="block max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-3 hover:border-border-strong hover:bg-surface-raised"
      >
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </a>
    </li>
  );
}
