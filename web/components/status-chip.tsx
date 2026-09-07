import { listingStatusLabel } from '../lib/labels.js';

/**
 * A §13 lifecycle state, rendered so it survives being printed, photocopied, or
 * looked at by someone who cannot distinguish the hues.
 *
 * `data-density.md` requires status to carry more than colour, so each state
 * gets a distinct SHAPE as well: a filled dot for open, a hollow ring for the
 * unconfirmed "may be gone", a bar for the settled dead states, and a filled
 * square for held-back. The written label is always present too — the shape is
 * redundancy, not the message.
 */

type Shape = 'filled' | 'hollow' | 'bar' | 'square';

const SHAPE_BY_STATUS: Record<string, { shape: Shape; className: string }> = {
  active: { shape: 'filled', className: 'text-status-open' },
  discovered: { shape: 'hollow', className: 'text-faint' },
  missing_suspected: { shape: 'hollow', className: 'text-status-unconfirmed' },
  closed: { shape: 'bar', className: 'text-status-closed' },
  expired: { shape: 'bar', className: 'text-status-closed' },
  quarantined: { shape: 'square', className: 'text-status-held' },
};

function Glyph({ shape }: { shape: Shape }) {
  // aria-hidden throughout: the adjacent text already says what this means, so
  // announcing the shape would be noise for a screen reader.
  const common = { width: 8, height: 8, viewBox: '0 0 8 8', 'aria-hidden': true } as const;
  switch (shape) {
    case 'filled':
      return (
        <svg {...common}>
          <circle cx="4" cy="4" r="3.5" fill="currentColor" />
        </svg>
      );
    case 'hollow':
      return (
        <svg {...common}>
          <circle cx="4" cy="4" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case 'bar':
      return (
        <svg {...common}>
          <rect x="0.5" y="3" width="7" height="2" fill="currentColor" />
        </svg>
      );
    case 'square':
      return (
        <svg {...common}>
          <rect x="0.5" y="0.5" width="7" height="7" fill="currentColor" />
        </svg>
      );
  }
}

export function StatusChip({ status, count }: { status: string; count?: number }) {
  const label = listingStatusLabel(status);
  const shape = SHAPE_BY_STATUS[status] ?? { shape: 'hollow' as const, className: 'text-faint' };

  return (
    <span className="inline-flex items-baseline gap-1.5" title={label.explanation}>
      <span className={`translate-y-[-1px] ${shape.className}`}>
        <Glyph shape={shape.shape} />
      </span>
      <span>{label.short}</span>
      {count !== undefined && <span className="numeric text-muted">{count}</span>}
    </span>
  );
}
