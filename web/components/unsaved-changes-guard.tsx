'use client';

import { useEffect } from 'react';

/**
 * Warns before a real page unload while a form holds unsaved edits.
 *
 * The draft editor is the one screen where leaving silently costs real work:
 * the body is text the person has read through and reworded, and the only copy
 * of an unsaved edit is the textarea itself. The "All drafts" link and the nav
 * are plain `<a href>`s, so a stray click is a genuine document unload.
 *
 * Saving is unaffected — a server action posts and redirects client-side, which
 * is not an unload — so this fires only for the case it is meant for.
 */
export function UnsavedChangesGuard({ formId }: { formId: string }) {
  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;

    let submitting = false;
    const isDirty = () =>
      !submitting &&
      Array.from(form.elements).some(
        (el) =>
          (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) &&
          el.type !== 'hidden' &&
          el.value !== el.defaultValue,
      );

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (isDirty()) event.preventDefault();
    };
    // Covers a native submit, the no-JS path the server action falls back to.
    const onSubmit = () => {
      submitting = true;
    };

    form.addEventListener('submit', onSubmit);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      form.removeEventListener('submit', onSubmit);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [formId]);

  return null;
}
