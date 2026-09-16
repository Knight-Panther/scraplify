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
}: {
  children: React.ReactNode;
  pendingLabel: string;
  className: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}
