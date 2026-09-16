import { db } from '../../../src/db/client.js';
import { listCandidateProfiles } from '../../../src/ranking/profile-store.js';
import { SubmitButton } from '../../components/submit-button.js';
import { absoluteTime, count, relativeTime } from '../../lib/format.js';
import type { RawSearchParams } from '../../lib/search-params.js';
import { one } from '../../lib/search-params.js';
import { writesEnabled } from '../../lib/writes.js';
import { deleteProfile, rankProfile, uploadCv } from './actions.js';

/**
 * The profile hub — upload, list, correct, rank, delete, all in one place.
 * Previously `/profile` was upload-only and reachable only through links
 * buried in `/ranked`; this is the direct nav entry point
 * (`site-header-nav.tsx`) and the one screen that owns every profile-wide
 * action, per the project owner's own "put all customizations here" request.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Profiles · Xtelo' };

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const error = one(raw.error);
  const profiles = await listCandidateProfiles(db);

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">Profiles</h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          Upload a CV (.pdf or .docx) and Claude drafts a candidate profile from it — every claim
          tied to the exact text it came from. You correct it before ranking.
        </p>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          Claude is only used for that one extraction step. Matching a profile against listings is a
          separate, deterministic scorer — no model call — which is why every rank on{' '}
          <a
            href="/ranked"
            className="text-accent underline underline-offset-2 hover:text-foreground"
          >
            Ranked
          </a>{' '}
          can show exactly which factors matched and which didn&rsquo;t.
        </p>
      </header>

      {error !== '' && <ErrorNotice message={error} />}

      {writesEnabled() && <UploadForm />}

      <section className="mt-8">
        <h2 className="text-sm font-medium text-muted">
          Your profiles
          {profiles.length > 0 && (
            <span className="numeric text-faint"> ({count(profiles.length)})</span>
          )}
        </h2>

        {profiles.length === 0 ? (
          <p className="mt-3 max-w-[var(--measure)] text-sm text-faint">
            {writesEnabled()
              ? 'No profiles yet — upload a CV above to draft one.'
              : 'No profiles exist in this database.'}
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {profiles.map((profile) => (
              <ProfileRow key={profile.profileId} profile={profile} />
            ))}
          </ul>
        )}
      </section>

      {!writesEnabled() && <ReadOnlyNotice />}
    </main>
  );
}

interface ProfileListRow {
  profileId: string;
  label: string;
  version: number;
  createdAt: string;
  claimCount: number;
}

function ProfileRow({ profile }: { profile: ProfileListRow }) {
  const popoverId = `delete-${profile.profileId}`;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius)] border border-border bg-surface px-4 py-3">
      <div className="min-w-0 flex-1">
        <a
          href={`/profile/${profile.profileId}`}
          className="text-sm text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-accent"
        >
          {profile.label}
        </a>
        <p className="mt-0.5 text-xs text-faint">
          version <span className="numeric">{profile.version}</span> ·{' '}
          <span className="numeric">{count(profile.claimCount)}</span> claim
          {profile.claimCount === 1 ? '' : 's'} ·{' '}
          <time dateTime={profile.createdAt} title={absoluteTime(profile.createdAt)}>
            {relativeTime(profile.createdAt)}
          </time>
        </p>
      </div>

      {writesEnabled() && (
        <div className="flex items-center gap-2">
          <form action={rankProfile}>
            <input type="hidden" name="profileId" value={profile.profileId} />
            <SubmitButton
              pendingLabel="Ranking…"
              className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-3 py-1 text-sm hover:bg-surface-active disabled:cursor-not-allowed disabled:opacity-60"
            >
              Rank now
            </SubmitButton>
          </form>

          {/* Zero-JS confirmation via the native popover API — same
              mechanism `site-header-nav.tsx`'s mobile menu already uses.
              This delete is a real, cascading DELETE (no undo), so a plain
              one-click button here would be exactly the anti-pattern
              anti-patterns.md warns against. */}
          <button
            type="button"
            popoverTarget={popoverId}
            className="rounded-[var(--radius)] px-3 py-1 text-sm text-status-held underline underline-offset-2 hover:text-foreground"
          >
            Delete
          </button>
          <div
            id={popoverId}
            popover="auto"
            className="m-auto max-w-sm rounded-[var(--radius)] border border-border bg-surface p-4 text-sm text-foreground"
          >
            <p>
              Delete <span className="font-medium">{profile.label}</span> permanently? This cannot
              be undone.
            </p>
            <div className="mt-3 flex items-center gap-3">
              <form action={deleteProfile}>
                <input type="hidden" name="profileId" value={profile.profileId} />
                <button
                  type="submit"
                  className="rounded-[var(--radius)] border border-status-held px-3 py-1 text-sm text-status-held hover:bg-status-held hover:text-white"
                >
                  Yes, delete permanently
                </button>
              </form>
              <button
                type="button"
                popoverTarget={popoverId}
                popoverTargetAction="hide"
                className="text-sm text-muted underline underline-offset-2 hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </li>
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
    <p className="mt-6 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-3 text-sm text-muted">
      This instance is pointed at the live corpus and cannot write, so profiles can be read here but
      not created, ranked, or deleted. <span className="numeric">npm run dev:web:qa</span> runs
      against a disposable copy where they can.
    </p>
  );
}
