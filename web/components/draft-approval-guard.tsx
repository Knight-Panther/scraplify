'use client';

import { useEffect, useState } from 'react';
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
 */
type DirtyState = 'unknown' | 'clean' | 'dirty';

function useEditFormDirtyState(editFormId: string): DirtyState {
  const [state, setState] = useState<DirtyState>('unknown');

  useEffect(() => {
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
 * Copy and the "open in your mail app" link, shown only once the edit form
 * is CONFIRMED clean — not merely "not yet known to be dirty".
 *
 * `mailtoHref` is a plain, static anchor `href`, not a form submission —
 * there is no server round trip to check it against anything, so hiding it
 * is the only lever this screen has. Rendering it by default and hiding it
 * once JavaScript proves the form dirty (the earlier version of this
 * component) left it live during hydration and permanently live with no
 * JavaScript at all. Starting hidden and only revealing it once confirmed
 * clean has no such gap: with no JavaScript, or before hydration completes,
 * these stay hidden — a real cost to convenience, but the approved text is
 * still fully visible and selectable in the page below regardless, so
 * nothing is actually blocked, only the one-click affordance.
 */
export function LiveApprovedActions({
  editFormId,
  text,
  mailtoHref,
}: {
  editFormId: string;
  text: string;
  mailtoHref: string | null;
}) {
  const state = useEditFormDirtyState(editFormId);

  if (state === 'dirty') {
    return (
      <p className="mt-3 text-xs text-faint" role="status">
        You have unsaved changes — save them to update what copying or opening in your mail app
        sends.
      </p>
    );
  }
  if (state === 'unknown') return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <CopyButton text={text} label="Copy text" />
      {mailtoHref !== null && (
        <a
          href={mailtoHref}
          className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-3 py-1 text-sm hover:bg-surface-active"
        >
          Open in your mail app
        </a>
      )}
    </div>
  );
}
