'use client';

/**
 * The shortlist's own error state.
 *
 * Worth its own wording rather than a generic one: this is the only screen
 * whose contents are the reader's own work rather than crawled data, so the
 * message says plainly that nothing has been lost — the decisions are in the
 * database, and this is a failure to read them.
 *
 * The message itself is not printed — it can carry a connection string — while
 * the digest is what makes the server log findable.
 */
export default function SavedError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  // `retry`, not `reset`: in this Next version `reset()` re-renders the
  // boundary's children without re-fetching, so against a server-component
  // database failure the button would appear to work and change nothing.
  retry: () => void;
}) {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Shortlist</h1>
      <div className="mt-6 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-4 py-4">
        <p className="text-sm">Your decisions could not be loaded.</p>
        <p className="mt-2 text-sm text-muted">
          Nothing has been lost — this is a failure to read them, not to keep them. The screen
          queries the database on every request, so the usual cause is that Postgres is not running.{' '}
          <span className="numeric">npm run dev</span> starts it and applies migrations.
        </p>
        {error.digest !== undefined && (
          <p className="mt-2 text-xs text-faint">
            Server log reference: <span className="numeric">{error.digest}</span>
          </p>
        )}
        <button
          type="button"
          onClick={() => retry()}
          className="mt-4 rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 text-sm hover:bg-surface-active"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
