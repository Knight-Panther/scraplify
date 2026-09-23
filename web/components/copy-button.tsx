'use client';

import { useState } from 'react';

/**
 * Copies text to the clipboard and says so. A client component only because
 * the Clipboard API is browser-side; rendered by the draft screen only while
 * the draft's approval is current.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState('copied');
          } catch {
            setState('failed');
          }
        }}
        className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-3 py-1 text-sm hover:bg-surface-active"
      >
        {label}
      </button>
      <span className="text-xs text-faint" aria-live="polite">
        {state === 'copied'
          ? 'Copied.'
          : state === 'failed'
            ? 'Copy failed — select the text instead.'
            : ''}
      </span>
    </>
  );
}
