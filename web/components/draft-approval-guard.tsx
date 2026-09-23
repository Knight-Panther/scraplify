'use client';

import { useEffect, useState } from 'react';
import { checkApprovalCurrentAction } from '../app/drafts/actions.js';
import { CopyButton } from './copy-button.js';
import { SubmitButton } from './submit-button.js';

/**
 * Whether the edit form's fields match what the server rendered.
 *
 * `'unknown'` is the deliberate starting value — matching what a server-
 * rendered page must show before any client script has run — and it is NOT
 * treated as safe by either consumer below. Without that, the `mailto:` link
 * (a plain, static `href` computed from the STORED draft) would sit in the
 * initial HTML sent to the browser and stay there, active, for as long as
 * JavaScript is off or has not yet hydrated — exactly the gap that made
 * Approve unsafe before it moved to a server-side check, except `mailto:`
 * has no server round trip to check anything against at all. So here,
 * "don't know yet" and "dirty" get the same treatment: only a CONFIRMED
 * `'clean'` state is treated as safe to act on.
 *
 * `editFormId === null` means there is no editable form at all (the
 * read-only production profile, `XTELO_WRITES_ENABLED` off) — nothing can
 * ever become dirty there, so this reports 'clean' immediately rather than
 * looking up a form id that will never exist and getting stuck on
 * 'unknown' forever.
 */
type DirtyState = 'unknown' | 'clean' | 'dirty';

function useEditFormDirtyState(editFormId: string | null): DirtyState {
  const [state, setState] = useState<DirtyState>(editFormId === null ? 'clean' : 'unknown');

  useEffect(() => {
    if (editFormId === null) return;
    const form = document.getElementById(editFormId);
    if (!(form instanceof HTMLFormElement)) return;

    const check = () => {
      const dirty = Array.from(form.elements).some(
        (el) =>
          (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) &&
          el.type !== 'hidden' &&
          el.value !== el.defaultValue,
      );
      setState(dirty ? 'dirty' : 'clean');
    };

    check();
    form.addEventListener('input', check);
    return () => form.removeEventListener('input', check);
  }, [editFormId]);

  return state;
}

/**
 * Local form state ('clean') is only half the guarantee: it proves the text
 * on screen matches what THIS tab last saved, not that the approval covering
 * it is still current on the server. Another tab's save, a profile revision,
 * or a crawl advancing the listing can invalidate the approval with this
 * tab's form never becoming dirty at all. So once the form is confirmed
 * clean (or there is no form to be dirty, in read-only mode), this
 * re-verifies against the server before letting either consumer below treat
 * the approval as usable — and fails closed: 'checking' is not 'current',
 * the same way 'unknown' is not 'clean' above.
 *
 * 'error' is deliberately its own state, not folded into 'stale': a failed
 * check (a network blip, the server briefly unreachable) says nothing about
 * whether the approval is actually current, unlike 'stale', which is an
 * answer. Collapsing the two would either hide Copy/mailto indefinitely on a
 * transient failure with no way back short of a reload, or — worse — risk
 * treating "couldn't ask" as "asked and it's fine". `retry` lets the caller
 * ask again without one.
 */
type LiveState = 'unknown' | 'dirty' | 'checking' | 'current' | 'stale' | 'error';

function useLiveApprovalState(
  editFormId: string | null,
  draftId: string,
  expectedContentHash: string,
): [LiveState, () => void] {
  const dirty = useEditFormDirtyState(editFormId);
  const [remote, setRemote] = useState<'checking' | 'current' | 'stale' | 'error'>('checking');
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is never read inside the effect — it exists solely so `retry()` below can force this effect to run again after a failed check.
  useEffect(() => {
    if (dirty !== 'clean') return;
    let cancelled = false;
    setRemote('checking');
    checkApprovalCurrentAction(draftId, expectedContentHash)
      .then((isCurrent) => {
        if (!cancelled) setRemote(isCurrent ? 'current' : 'stale');
      })
      .catch(() => {
        if (!cancelled) setRemote('error');
      });
    return () => {
      cancelled = true;
    };
  }, [dirty, draftId, expectedContentHash, attempt]);

  const retry = () => setAttempt((n) => n + 1);
  if (dirty === 'unknown') return ['unknown', retry];
  if (dirty === 'dirty') return ['dirty', retry];
  return [remote, retry];
}

/**
 * The Approve submit button — a `formAction` override on the SAME form Save
 * uses, so pressing it submits the body and subject fields exactly as they
 * stand, not just a draft id and a hash computed at page-load time. That is
 * what makes `approveDraft`'s server-side check meaningful: it compares what
 * was actually submitted against what is actually stored, which is the only
 * way to catch an unsaved edit if JavaScript never runs at all.
 *
 * This component's own disabling is a *second*, cosmetic layer on top of
 * that: instant feedback the moment a keystroke makes the editor dirty,
 * without waiting on a round trip. It is not what makes the guarantee real —
 * `approveDraft` refusing a submitted body/subject that doesn't match the
 * stored draft is what does that, and it does it unconditionally, so an
 * `'unknown'` state here costs nothing beyond a brief disabled flash before
 * hydration (or, with no JS at all, a button that stays enabled and
 * server-refuses — never a button that silently misbinds an approval).
 */
export function ApproveSubmitButton({
  editFormId,
  formAction,
  className,
  children,
}: {
  editFormId: string;
  formAction: (formData: FormData) => void | Promise<void>;
  className: string;
  children: React.ReactNode;
}) {
  const state = useEditFormDirtyState(editFormId);
  const notConfirmedClean = state !== 'clean';
  return (
    <>
      <SubmitButton
        pendingLabel="Approving…"
        className={className}
        disabled={notConfirmedClean}
        formAction={formAction}
      >
        {children}
      </SubmitButton>
      {state === 'dirty' && (
        <p className="mt-2 text-xs text-faint" role="status">
          Save your changes first — this would approve the last saved text, not what’s shown above.
        </p>
      )}
    </>
  );
}

/**
 * Copy and the "open in your mail app" link, shown only once BOTH the edit
 * form is CONFIRMED clean (or there is none, in read-only mode) AND the
 * server has just confirmed the approval is still current — never on local
 * state alone. See `useLiveApprovalState` above for why the server check is
 * not optional.
 *
 * `mailtoHref` is a plain, static anchor, not a form submission — there is
 * no server round trip built into following it, so this component performs
 * one itself, immediately before rendering the link (and again, in
 * `MailtoLink` below, immediately before it is actually opened — the state
 * here can go stale in the seconds between a render and a click). Copy asks
 * the same question through `beforeCopy` before it writes to the clipboard.
 */
export function LiveApprovedActions({
  editFormId,
  draftId,
  expectedContentHash,
  text,
  mailtoHref,
  emailWithSuppressedMailto,
}: {
  editFormId: string | null;
  draftId: string;
  expectedContentHash: string;
  text: string;
  mailtoHref: string | null;
  /** True when this is an email draft whose mailto link was withheld for length, not because it isn't an email at all — see `mailtoHref` in `draft-input.ts`. */
  emailWithSuppressedMailto: boolean;
}) {
  const [state, retry] = useLiveApprovalState(editFormId, draftId, expectedContentHash);

  if (state === 'dirty') {
    return (
      <p className="mt-3 text-xs text-faint" role="status">
        You have unsaved changes — save them to update what copying or opening in your mail app
        sends.
      </p>
    );
  }
  if (state === 'unknown' || state === 'checking') return null;
  if (state === 'stale') {
    return (
      <p className="mt-3 text-xs text-status-unconfirmed" role="status">
        This approval is no longer current — reload the page to see why.
      </p>
    );
  }
  if (state === 'error') {
    return (
      <p className="mt-3 text-xs text-status-unconfirmed" role="status">
        Could not confirm this approval is still current.{' '}
        <button type="button" onClick={retry} className="underline underline-offset-2">
          Try again
        </button>
      </p>
    );
  }
  // Click-time recheck for Copy/mailto: fails closed on any error, same
  // reasoning as the mount-time check above, but without a distinct retry
  // affordance here — the persistent 'error' state above is what surfaces
  // that, since a click-time failure just re-shows Copy/mailto's own
  // "no longer current" message on the next render either way.
  const recheck = () => checkApprovalCurrentAction(draftId, expectedContentHash).catch(() => false);
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-3">
        <CopyButton text={text} label="Copy text" beforeCopy={recheck} />
        {mailtoHref !== null && <MailtoLink href={mailtoHref} recheck={recheck} />}
      </div>
      {emailWithSuppressedMailto && <MailtoSuppressedNote />}
    </div>
  );
}

/**
 * The static mail-app link, gated by one last server check right before it
 * is followed — the render-time check in `LiveApprovedActions` can be
 * seconds stale by the time someone actually clicks. A plain `<a href>`
 * cannot ask a question before navigating, so this is a button that performs
 * the same navigation only once the check confirms it is still safe to.
 */
function MailtoLink({ href, recheck }: { href: string; recheck: () => Promise<boolean> }) {
  const [blocked, setBlocked] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          if (await recheck()) {
            window.location.href = href;
          } else {
            setBlocked(true);
          }
        }}
        className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-3 py-1 text-sm hover:bg-surface-active"
      >
        Open in your mail app
      </button>
      {blocked && (
        <p className="text-xs text-status-unconfirmed" role="status">
          This approval is no longer current — reload the page to see why.
        </p>
      )}
    </>
  );
}

/** A note shown in place of the mail-app link when the draft is an email but too long to hand to one safely — Copy remains available regardless. */
export function MailtoSuppressedNote() {
  return (
    <p className="mt-2 text-xs text-faint">
      This draft is too long for a direct mail-app link — use Copy and paste it in instead.
    </p>
  );
}
