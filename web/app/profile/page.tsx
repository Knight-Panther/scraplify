import { SubmitButton } from '../../components/submit-button.js';
import type { RawSearchParams } from '../../lib/search-params.js';
import { one } from '../../lib/search-params.js';
import { writesEnabled } from '../../lib/writes.js';
import { uploadCv } from './actions.js';

/**
 * CV upload — Phase 5's intake path. A PDF or DOCX becomes a draft profile
 * on `/profile/[id]` for correction before ranking (§17.1); nothing here is
 * invented, and nothing about the file is logged (§21.1, §23.2).
 */

export const metadata = { title: 'New profile · Xtelo' };

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const error = one(raw.error);

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">New profile</h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          Upload a CV (.pdf or .docx) and Claude drafts a candidate profile from it — every claim
          tied to the exact text it came from. You correct it on the next screen before anything is
          ranked against it.
        </p>
      </header>

      {error !== '' && <ErrorNotice message={error} />}

      {writesEnabled() ? <UploadForm /> : <ReadOnlyNotice />}
    </main>
  );
}

function UploadForm() {
  return (
    <form action={uploadCv} className="mt-6 flex max-w-[var(--measure)] flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Label</span>
        <input
          type="text"
          name="label"
          required
          autoComplete="off"
          placeholder="e.g. my 2026 CV"
          className="rounded-[var(--radius)] border border-border bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-faint"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">CV file (.pdf or .docx, up to 8MB)</span>
        <input
          type="file"
          name="file"
          accept=".pdf,.docx"
          required
          className="rounded-[var(--radius)] border border-border bg-surface px-3 py-1.5 text-sm text-foreground file:mr-3 file:rounded-[var(--radius)] file:border-0 file:bg-surface-raised file:px-3 file:py-1 file:text-sm"
        />
      </label>

      <label className="flex items-start gap-2 text-sm text-muted">
        <input
          type="checkbox"
          name="consent"
          className="mt-0.5 size-4 accent-[var(--color-accent-strong)]"
        />
        <span>
          I understand this file is sent to Anthropic&rsquo;s API to extract profile information.
          The file itself is discarded immediately after — it is not stored.
        </span>
      </label>

      <SubmitButton
        pendingLabel="Uploading and parsing…"
        className="self-start rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 text-sm hover:bg-surface-active disabled:cursor-not-allowed disabled:opacity-60"
      >
        Upload and parse
      </SubmitButton>
    </form>
  );
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-4 py-3 text-sm">
      {message}
    </div>
  );
}

function ReadOnlyNotice() {
  return (
    <p className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-3 text-sm text-muted">
      This instance is pointed at the live corpus and cannot write, so a profile cannot be created
      here. <span className="numeric">npm run dev:web:qa</span> runs against a disposable copy where
      it can.
    </p>
  );
}
