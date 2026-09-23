'use client';

import { useState } from 'react';

/**
 * Copies text to the clipboard and says so. A client component only because
 * the Clipboard API is browser-side; rendered by the draft screen only while
 * the draft's approval is current.
 *
 * `beforeCopy`, when given, is called AFTER the clipboard write, not before —
 * `navigator.clipboard.writeText` requires the browser's transient user
 * activation, granted only for a short window after a real click and
 * consumed by the first async call that uses it. Awaiting a server round
 * trip first can outlast that window, especially on a slow connection,
 * making every Copy attempt fail even with a valid approval. Calling it
 * afterward instead means the copy itself is never blocked by the check; a
 * failed re-verification only downgrades the confirmation message, on the
 * reasoning that clipboard content never leaves the person's own machine —
 * unlike the mail-app link, there is nothing here to fail closed against.
 */
export function CopyButton({
  text,
  label,
  beforeCopy,
}: {
  text: string;
  label: string;
  beforeCopy?: () => Promise<boolean>;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'copied-stale' | 'failed'>('idle');
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            setState('failed');
            return;
          }
          if (beforeCopy) {
            const stillCurrent = await beforeCopy().catch(() => false);
            setState(stillCurrent ? 'copied' : 'copied-stale');
            return;
          }
          setState('copied');
        }}
        className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-3 py-1 text-sm hover:bg-surface-active"
      >
        {label}
      </button>
      <span className="text-xs text-faint" aria-live="polite">
        {state === 'copied'
          ? 'Copied.'
          : state === 'copied-stale'
            ? 'Copied, but this approval may no longer be current — reload the page before using it.'
            : state === 'failed'
              ? 'Copy failed — select the text instead.'
              : ''}
      </span>
    </>
  );
}
