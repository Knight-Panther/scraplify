/**
 * The filter bar's line icons, drawn on a 24-unit grid in the text's colour
 * (the approved mockup's set). Always decorative: the words beside them say
 * what they mean.
 */

const PATHS = {
  flat: 'M5 21V4h10v17M15 9h4v12M3 21h18M8 7h1M11 7h1M8 10h1M11 10h1M8 13h1M11 13h1M8 16h1M11 16h1',
  house: 'M3 11l9-7 9 7M5 10v11h14V10M10 21v-6h4v6',
  cottage: 'M2 12l10-8 10 8M5 10v11h14V10M9 21v-5h6v5M16 6V3h2v4.5',
  commercial:
    'M3 9l2-5h14l2 5M3 9h18v3a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0zM5 13v8h14v-8M10 21v-5h4v5',
  land: 'M3 20l6-8 4 5 3-4 5 7zM8 7a2 2 0 1 0 0 .01',
  hotel: 'M3 21V5h12v16M15 10h6v11M3 21h18M7 9h1M11 9h1M7 13h1M11 13h1M7 17h5',
  any: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  search: 'M20 20l-4-4M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0z',
  price:
    'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM9 7.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
  rooms: 'M3 20V8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12M3 14h18M7 14v-3h4v3M13 14v-3h4v3',
  metro: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM7.5 16V8l4.5 5 4.5-5v8',
  area: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  floor: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5',
  yard: 'M12 22v-6M8 16h8l-4-7-4 7zM7 12l5-9 5 9M4 22h16',
  space: 'M3 21V8l9-5 9 5v13M8 21v-7h8v7M3 21h18',
  plot: 'M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3V7zM9 4v13M15 7v13',
  pin: 'M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM14.5 9.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  building: 'M4 21V6l8-3 8 3v15M9 21v-4h6v4M8 9h1M12 9h1M15 9h1M8 13h1M12 13h1M15 13h1M3 21h18',
  sparkle: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18',
  tag: 'M4 6h16M4 12h10M4 18h7',
  layout: 'M4 4h16v16H4zM4 10h16M10 10v10',
  sliders:
    'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M18 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM12 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM20 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'size-4' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The down caret of a button that opens a panel; turned up while it is open. */
export function Caret({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`size-[7px] border-r-[1.5px] border-b-[1.5px] border-current opacity-70 transition-transform duration-150 motion-reduce:transition-none ${
        open ? 'translate-y-px rotate-[225deg]' : '-translate-y-0.5 rotate-45'
      }`}
    />
  );
}
