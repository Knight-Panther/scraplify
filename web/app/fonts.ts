import { Noto_Sans_Georgian, Space_Mono } from 'next/font/google';

/**
 * Two faces, with a hard split of responsibilities.
 *
 * The SynapseX reference sets Space Mono for everything, which cannot be used
 * for content here: Google's own metadata lists its subsets as latin,
 * latin-ext and menu — no Georgian. 388 of 410 titles in this corpus are
 * Georgian and 22 mix both scripts inside a single string, so Space Mono as the
 * text face would render those in two different typefaces mid-heading.
 *
 * Noto Sans Georgian covers Georgian and Latin from one family, so mixed
 * strings are consistent by construction rather than by inspection. Space Mono
 * survives for numerals, dates, scores and IDs, where the content is Latin and
 * digits and where monospace is independently the right call.
 *
 * next/font downloads these at build time and serves them from our own origin —
 * no runtime request to Google, and no layout shift.
 */
// No `weight`: Noto Sans Georgian is a VARIABLE font, so omitting it ships one
// file covering the whole weight axis. Naming discrete weights instead made
// next/font emit a preload per weight, and the browser then warned that three
// of them were never used — the design only reaches 400/500/600, and a
// preloaded-but-unused font is wasted bandwidth on every page load.
export const notoGeorgian = Noto_Sans_Georgian({
  subsets: ['georgian', 'latin'],
  variable: '--font-noto-georgian',
  display: 'swap',
});

// Space Mono has no variable cut, so weights are explicit — and only 400 is
// declared, because numerals are never bold in this design.
export const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-space-mono',
  display: 'swap',
});
