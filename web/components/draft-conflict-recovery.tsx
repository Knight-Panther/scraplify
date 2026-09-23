'use client';

import { useEffect } from 'react';

/**
 * Recovers a tab's unsaved edit after `saveDraftAction` refuses it as a
 * stale-content conflict (`editDraft`'s `expectedContentHash` check — see
 * `draft-store.ts`): two tabs open on the same draft, this one saves an
 * edit built from text the other tab already changed underneath it.
 *
 * The refusal is correct and necessary — it is what stops the stale tab
 * from silently overwriting the newer edit — but `saveDraftAction`
 * redirects to a fresh GET on any refusal, and that GET re-renders the form
 * from whatever is now actually stored, discarding whatever this tab had
 * just typed. There is nowhere durable to park that text server-side worth
 * building for a two-tabs-on-one-draft edge case, so this stashes it in
 * `sessionStorage`, scoped to this browser tab, right before every submit,
 * and restores it into the form on the one specific redirect this is for —
 * cleared immediately after, and also on any OTHER load, so a stash never
 * outlives the conflict it was captured for.
 */
export function DraftConflictRecovery({
  formId,
  draftId,
  isSaveConflict,
}: {
  formId: string;
  draftId: string;
  /** True only when this page loaded because of THIS draft's stale-save conflict — see actions.ts's `withError`. */
  isSaveConflict: boolean;
}) {
  const key = `xtelo:draft-conflict:${draftId}`;

  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;
    const subject = form.elements.namedItem('subject');
    const body = form.elements.namedItem('body');
    const bodyField = body instanceof HTMLTextAreaElement ? body : null;
    const subjectField = subject instanceof HTMLInputElement ? subject : null;

    if (isSaveConflict) {
      const raw = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);
      if (raw !== null && bodyField) {
        try {
          const stashed = JSON.parse(raw) as { subject: string; body: string };
          if (subjectField) subjectField.value = stashed.subject;
          bodyField.value = stashed.body;
          // Uncontrolled inputs compare against `defaultValue`, not the
          // live value, to decide "dirty" (see `useEditFormDirtyState`
          // above and `UnsavedChangesGuard`) — restoring only `.value`
          // would leave both reading this restored text as unmodified.
          if (subjectField) subjectField.defaultValue = stashed.subject;
          bodyField.defaultValue = stashed.body;
          bodyField.dispatchEvent(new Event('input', { bubbles: true }));
        } catch {
          // Malformed stash (a prior version, manual tampering) — the
          // server-rendered (now-current) text stays, same as if nothing
          // had been stashed at all.
        }
      }
    } else {
      sessionStorage.removeItem(key);
    }

    const onSubmit = () => {
      try {
        sessionStorage.setItem(
          key,
          JSON.stringify({
            subject: subjectField?.value ?? '',
            body: bodyField?.value ?? '',
          }),
        );
      } catch {
        // Storage unavailable or full (private browsing, quota) — the
        // conflict message still renders without recovered text, same as
        // before this component existed.
      }
    };
    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
  }, [formId, isSaveConflict, key]);

  return isSaveConflict ? (
    <p className="mt-2 text-xs text-faint" role="status">
      Your unsaved text from this tab is restored below — review it against the current version
      before saving again.
    </p>
  ) : null;
}
