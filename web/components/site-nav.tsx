import { databaseLabel, writesEnabled } from '../lib/writes.js';

/**
 * Site chrome: where you are, and — deliberately prominent — which database
 * this instance is pointed at and whether it can write to it.
 *
 * That chip is not decoration. Read-only QA runs against the live corpus while
 * write testing runs against a disposable copy, and confusing the two is how
 * this project has twice corrupted real data. Making the answer permanently
 * visible is cheaper than remembering.
 *
 * Plain <a>, not next/link, and deliberately so: every page here is
 * force-dynamic, and <Link> prefetches on hover and in-viewport, which would
 * turn idle pointer movement into real database queries against the live
 * corpus. A full navigation is also more predictable for a tool whose pages
 * must always show current state.
 */

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/health', label: 'Source health' },
];

export function SiteNav() {
  return (
    <nav aria-label="Main" className="border-b border-border">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
        <span className="font-semibold">Xtelo</span>
        <ul className="flex gap-x-5 text-sm">
          {LINKS.map((link) => (
            <li key={link.href}>
              <a className="text-muted hover:text-foreground" href={link.href}>
                {link.label}
              </a>
            </li>
          ))}
        </ul>
        <span className="ml-auto flex items-center gap-2 text-xs">
          <span className="text-faint">{databaseLabel()}</span>
          <span
            className={
              writesEnabled()
                ? 'rounded-[--radius] border border-status-held px-2 py-0.5 text-status-held'
                : 'rounded-[--radius] border border-border px-2 py-0.5 text-faint'
            }
            title={
              writesEnabled()
                ? 'This instance can modify the database. It should be pointed at a disposable copy, not the live corpus.'
                : 'Read-only. Set XTELO_WRITES_ENABLED=true against a disposable database to make changes.'
            }
          >
            {writesEnabled() ? 'writes on' : 'read-only'}
          </span>
        </span>
      </div>
    </nav>
  );
}
