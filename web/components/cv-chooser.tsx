'use client';

import { useRouter } from 'next/navigation.js';
import { useId } from 'react';
import { useCvSession } from '../lib/cv-ranked/session.js';

/** What the file picker offers. The worker still checks extension and magic bytes itself. */
const ACCEPT =
  '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Picks a CV and hands it to the in-memory session (Phase 8D). A labelled
 * native file input rather than a custom drop zone: it is keyboard- and
 * screen-reader-operable as is, and the file never leaves this tab — there
 * is no form, no action and no request carrying it.
 *
 * `navigate` is set on the landing page: processing starts, then a CLIENT
 * navigation (not `<a>`, which would reload the page and end the session)
 * opens `/cv-ranked` with the worker still running.
 */
export function CvChooser({
  label,
  note,
  navigate = false,
  className,
}: {
  label: string;
  note: string;
  navigate?: boolean;
  className: string;
}) {
  const { start } = useCvSession();
  const router = useRouter();
  const noteId = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <label
        className={`${className} cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-[var(--color-browse-accent)]`}
      >
        {label}
        <input
          type="file"
          accept={ACCEPT}
          aria-describedby={noteId}
          className="sr-only"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            // Cleared so choosing the same file again still fires `change`,
            // and so the input itself keeps no reference to it.
            event.currentTarget.value = '';
            if (file === undefined) return;
            start(file);
            if (navigate) router.push('/cv-ranked');
          }}
        />
      </label>
      <span id={noteId} className="text-xs text-[var(--color-browse-text-muted)]">
        {note}
      </span>
    </div>
  );
}
