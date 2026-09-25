import { db } from '../../../../../src/db/client.js';
import { OutreachError } from '../../../../../src/outreach/draft-store.js';
import { loadDraftTarget } from '../../../../../src/outreach/generate-draft.js';
import { loadCandidateProfile } from '../../../../../src/ranking/profile-store.js';
import { SubmitButton } from '../../../../components/submit-button.js';
import { UUID } from '../../../../lib/profile-input.js';
import type { RawSearchParams } from '../../../../lib/search-params.js';
import { one } from '../../../../lib/search-params.js';
import { writesEnabled } from '../../../../lib/writes.js';
import { generateDraftAction } from '../actions.js';

/**
 * The step before a draft is written: shows exactly which listing it will
 * answer, whether it becomes an email (and to whom — the listing's own stated
 * address) or a cover letter, and asks for the acknowledgment §23.2 requires
 * before profile data is sent to Anthropic. Generation is a billed model call,
 * so it is a deliberate button press here, never a side effect of opening a page.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'New draft · Xtelo' };

export default async function NewDraftPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const profileId = one(raw.profile);
  const opportunityId = one(raw.opportunity);
  const error = one(raw.error);

  if (!UUID.test(profileId) || !UUID.test(opportunityId)) {
    return <Problem title="Nothing to draft" message="Open a draft from a row on Ranked." />;
  }
  const profile = await loadCandidateProfile(db, profileId);
  if (profile === null) {
    return <Problem title="Profile not found" message="It may have been deleted." />;
  }

  let target: Awaited<ReturnType<typeof loadDraftTarget>>;
  try {
    target = await loadDraftTarget(db, opportunityId);
  } catch (err) {
    if (err instanceof OutreachError) return <Problem title="Cannot draft" message={err.message} />;
    throw err;
  }

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">Draft an application</h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          Claude writes a first draft from the claims in{' '}
          <a
            href={`/profile/${profile.profileId}`}
            className="text-accent underline underline-offset-2 hover:text-foreground"
          >
            {profile.label}
          </a>{' '}
          and this listing. It may only state what your claims support, and it cites which ones it
          used. Nothing is sent: you review, edit and approve the exact text yourself.
        </p>
      </header>

      {error !== '' && <ErrorNotice message={error} />}

      <dl className="mt-6 grid max-w-[var(--measure)] gap-3 rounded-[var(--radius)] border border-border bg-surface px-4 py-3 text-sm">
        <div>
          <dt className="text-xs text-faint">Listing</dt>
          <dd className="ml-0">
            <a
              href={`/opportunities/${opportunityId}`}
              className="underline decoration-border-strong underline-offset-2 hover:decoration-accent"
            >
              {target.title}
            </a>
            {target.organization !== null && (
              <span className="text-muted"> · {target.organization}</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-faint">Draft type</dt>
          <dd className="ml-0">
            {target.kind === 'email' ? (
              <>
                Application email to{' '}
                <span translate="no" className="font-medium">
                  {target.recipient}
                </span>{' '}
                <span className="text-muted">
                  — the address this listing gives for applications
                </span>
              </>
            ) : (
              <>
                Cover letter{' '}
                <span className="text-muted">
                  — this listing gives no application email, so there is no recipient
                </span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-faint">Profile claims available</dt>
          <dd className="ml-0 numeric">{profile.claims.length}</dd>
        </div>
      </dl>

      {writesEnabled() ? (
        <form
          action={generateDraftAction}
          className="mt-6 flex max-w-[var(--measure)] flex-col gap-4"
        >
          <input type="hidden" name="profileId" value={profile.profileId} />
          <input type="hidden" name="opportunityId" value={opportunityId} />
          {/* What this screen showed, so the server can refuse to generate
              against anything that moved since — see generateDraftAction. */}
          <input type="hidden" name="expectedProfileVersion" value={profile.version} />
          <input
            type="hidden"
            name="expectedOpportunityRevisionId"
            value={target.opportunityRevisionId}
          />
          <input type="hidden" name="expectedListingRevisionId" value={target.revisionId} />

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Language</span>
            <select
              name="language"
              defaultValue="auto"
              className="self-start rounded-[var(--radius)] border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
            >
              <option value="auto">
                Same as the listing ({target.language === 'ka' ? 'Georgian' : 'English'})
              </option>
              <option value="ka">Georgian</option>
              <option value="en">English</option>
            </select>
          </label>

          <label className="flex items-start gap-2 text-sm text-muted">
            <input
              type="checkbox"
              name="consent"
              className="mt-0.5 size-4 accent-[var(--color-accent-strong)]"
            />
            <span>
              I understand my profile claims and this listing are sent to Anthropic&rsquo;s API to
              write the draft.
            </span>
          </label>

          <SubmitButton
            pendingLabel="Writing draft…"
            className="self-start rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 text-sm hover:bg-surface-active disabled:cursor-not-allowed disabled:opacity-60"
          >
            Write draft
          </SubmitButton>
        </form>
      ) : (
        <p className="mt-6 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-3 text-sm text-muted">
          This instance is pointed at the live corpus and cannot write, so drafts cannot be created
          here. <span className="numeric">npm run dev:web:qa</span> runs against a disposable copy
          where they can.
        </p>
      )}

      <p className="mt-6 text-sm">
        <a
          href={`/ranked?profile=${profile.profileId}`}
          className="text-accent underline underline-offset-2 hover:text-foreground"
        >
          Back to Ranked
        </a>
      </p>
    </main>
  );
}

function ErrorNotice({ message }: { message: string }) {
  // `role="alert"`, as on the other two draft screens: these messages arrive
  // after a redirect, so without it a refusal — an unticked acknowledgment, a
  // failed generation — lands silently for a screen reader.
  return (
    <div
      role="alert"
      className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-4 py-3 text-sm"
    >
      {message}
    </div>
  );
}

function Problem({ title, message }: { title: string; message: string }) {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">{message}</p>
    </main>
  );
}
