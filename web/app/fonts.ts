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
export const notoGeorgian = Noto_Sans_Georgian({
  subsets: ['georgian', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-noto-georgian',
  display: 'swap',
});

export const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-space-mono',
  display: 'swap',
});
