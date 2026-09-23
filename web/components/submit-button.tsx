'use client';

import { useFormStatus } from 'react-dom';

/**
 * A submit button that disables itself and shows a pending label while its
 * form's action is in flight.
 *
 * Without this, `/profile`'s upload button gives no feedback during the real,
 * several-second Claude API call `uploadCv` makes — long enough that a second
 * click starts a second billed extraction rather than just feeling
 * unresponsive. `useFormStatus` needs a client component; this is that one
 * boundary, kept as small as the ticker's own.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className,
  disabled = false,
  formAction,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  className: string;
  /** An external reason to disable the button besides its own pending state. */
  disabled?: boolean;
  /**
   * Overrides which server action THIS button submits to — for a form with
   * more than one submit button (the draft editor's Save and Approve share
   * one form; see `draft-approval-guard.tsx`). `useFormStatus()` reports the
   * whole form's pending state to every descendant, regardless of which
   * button triggered it, so without this every button in a shared form would
   * show its pending label at once. Passing `formAction` lets this button
   * compare `status.action` — the specific action actually in flight —
   * against its own, and show the pending label only when it's the one that
   * was pressed. Omit it in the ordinary one-button-per-form case, where the
   * ambiguity doesn't exist.
   */
  formAction?: (formData: FormData) => void | Promise<void>;
}) {
  const status = useFormStatus();
  const isThisPending =
    status.pending && (formAction === undefined || status.action === formAction);
  return (
    <button
      type="submit"
      formAction={formAction}
      disabled={status.pending || disabled}
      className={className}
      aria-busy={isThisPending}
      aria-disabled={disabled || undefined}
    >
      {isThisPending ? pendingLabel : children}
    </button>
  );
}
