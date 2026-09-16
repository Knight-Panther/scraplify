import { CandidateClaimKind } from '../../../../src/domain/candidate.js';
import { db } from '../../../../src/db/client.js';
import { loadCandidateProfile, type LoadedProfile } from '../../../../src/ranking/profile-store.js';
import { SubmitButton } from '../../../components/submit-button.js';
import { claimKindLabel } from '../../../lib/labels.js';
import { UUID } from '../../../lib/profile-input.js';
import type { RawSearchParams } from '../../../lib/search-params.js';
import { one } from '../../../lib/search-params.js';
import { writesEnabled } from '../../../lib/writes.js';
import { saveCorrections } from './actions.js';

/**
 * The correction screen §17.1 requires: "users can correct the profile
 * before ranking." Every claim from the last extraction or edit is shown,
 * grouped by kind, editable or deletable, with room to add a few by hand —
 * pressing Save writes a new version via `reviseCandidateProfile`, the same
 * function the CLI uses to apply a hand-edited correction.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Profile · Xtelo' };

const CLAIM_KINDS = CandidateClaimKind.options;
const ADD_SLOTS = 4;

export default async function ProfileDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { id } = await params;
  const raw = await searchParams;
  const error = one(raw.error);
  const saved = one(raw.saved) === '1';

  if (!UUID.test(id)) return <NotFound />;
  const profile = await loadCandidateProfile(db, id);
  if (profile === null) return <NotFound />;

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">{profile.label}</h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          Version <span className="numeric">{profile.version}</span> ·{' '}
          <span className="numeric">{profile.claims.length}</span> claim
          {profile.claims.length === 1 ? '' : 's'}. Each one below carries the exact text it was
          drawn from — correct, remove, or add to it, then save.
        </p>
      </header>

      {error !== '' && <ErrorNotice message={error} />}
      {saved && (
        <p className="mt-4 text-sm text-status-open" aria-live="polite">
          Saved.
        </p>
      )}

      {writesEnabled() ? (
        <CorrectionForm profile={profile} />
      ) : (
        <ReadOnlyNotice claims={profile.claims} />
      )}

      <p className="mt-6 text-sm">
        <a
          href={`/ranked?profile=${profile.profileId}`}
          className="text-accent underline underline-offset-2 hover:text-foreground"
        >
          Rank against this profile
        </a>
      </p>
    </main>
  );
}

function CorrectionForm({ profile }: { profile: LoadedProfile }) {
  const totalRows = profile.claims.length + ADD_SLOTS;

  return (
    <form action={saveCorrections} className="mt-6 flex max-w-[var(--measure)] flex-col gap-6">
      <input type="hidden" name="profileId" value={profile.profileId} />
      <input type="hidden" name="rowCount" value={totalRows} />

      {CLAIM_KINDS.map((kind) => {
        const rows = profile.claims
          .map((claim, index) => ({ claim, index }))
          .filter(({ claim }) => claim.kind === kind);
        if (rows.length === 0) return null;
        return (
          <fieldset key={kind} className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{claimKindLabel(kind).short}</legend>
            {rows.map(({ claim, index }) => (
              <ExistingClaimRow key={index} index={index} kind={kind} claim={claim} />
            ))}
          </fieldset>
        );
      })}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Add a claim</legend>
        {Array.from({ length: ADD_SLOTS }, (_, slot) => (
          // A fixed number of blank slots that never reorder, insert, or
          // remove — the index is a stable identity here, not a proxy for one.
          // biome-ignore lint/suspicious/noArrayIndexKey: static slot count
          <AddClaimRow key={slot} index={profile.claims.length + slot} />
        ))}
      </fieldset>

      <SubmitButton
        pendingLabel="Saving…"
        className="self-start rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 text-sm hover:bg-surface-active disabled:cursor-not-allowed disabled:opacity-60"
      >
        Save corrections
      </SubmitButton>
    </form>
  );
}

function ExistingClaimRow({
  index,
  kind,
  claim,
}: {
  index: number;
  kind: string;
  claim: LoadedProfile['claims'][number];
}) {
  return (
    <div className="flex flex-wrap items-start gap-2 rounded-[var(--radius)] border border-border bg-surface px-3 py-2">
      <input type="hidden" name={`claims[${index}].existing`} value="1" />
      <input type="hidden" name={`claims[${index}].kind`} value={kind} />
      {claim.evidence !== null && (
        <input type="hidden" name={`claims[${index}].evidence`} value={claim.evidence} />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          type="text"
          name={`claims[${index}].value`}
          defaultValue={claim.value}
          className="w-full rounded-[var(--radius)] border border-border bg-surface-raised px-2 py-1 text-sm text-foreground"
        />
        {claim.evidence !== null && (
          <p className="text-xs text-faint" title="The exact text this claim was drawn from">
            “{claim.evidence}”
          </p>
        )}
      </div>
      {kind === 'role' && (
        <label className="flex items-center gap-1 text-xs text-faint">
          years
          <input
            type="number"
            min={0}
            step="0.5"
            name={`claims[${index}].years`}
            defaultValue={claim.years ?? ''}
            className="w-16 rounded-[var(--radius)] border border-border bg-surface-raised px-2 py-1 text-sm text-foreground"
          />
        </label>
      )}
      <label className="flex items-center gap-1 text-xs text-faint">
        <input type="checkbox" name={`claims[${index}].delete`} className="size-4" />
        remove
      </label>
    </div>
  );
}

function AddClaimRow({ index }: { index: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-border bg-surface px-3 py-2">
      <select
        name={`claims[${index}].kind`}
        defaultValue="skill"
        className="rounded-[var(--radius)] border border-border bg-surface-raised px-2 py-1 text-sm text-foreground"
      >
        {CLAIM_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {claimKindLabel(kind).short}
          </option>
        ))}
      </select>
      <input
        type="text"
        name={`claims[${index}].value`}
        placeholder="value"
        className="min-w-0 flex-1 rounded-[var(--radius)] border border-border bg-surface-raised px-2 py-1 text-sm text-foreground placeholder:text-faint"
      />
      <label className="flex items-center gap-1 text-xs text-faint">
        years
        <input
          type="number"
          min={0}
          step="0.5"
          name={`claims[${index}].years`}
          className="w-16 rounded-[var(--radius)] border border-border bg-surface-raised px-2 py-1 text-sm text-foreground"
        />
      </label>
    </div>
  );
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-4 py-3 text-sm">
      {message}
    </div>
  );
}

function ReadOnlyNotice({ claims }: { claims: LoadedProfile['claims'] }) {
  return (
    <div className="mt-6 max-w-[var(--measure)]">
      <p className="rounded-[var(--radius)] border border-border bg-surface px-4 py-3 text-sm text-muted">
        This instance is pointed at the live corpus and cannot write, so this profile can be read
        here but not corrected. <span className="numeric">npm run dev:web:qa</span> runs against a
        disposable copy where it can.
      </p>
      <ul className="mt-4 flex flex-col gap-2">
        {claims.map((claim) => (
          <li
            key={`${claim.kind}:${claim.value}`}
            className="rounded-[var(--radius)] border border-border bg-surface px-3 py-2 text-sm"
          >
            <span className="text-faint">{claimKindLabel(claim.kind).short}:</span> {claim.value}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NotFound() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Profile not found</h1>
      <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
        This profile does not exist, or has been deleted.
      </p>
    </main>
  );
}
