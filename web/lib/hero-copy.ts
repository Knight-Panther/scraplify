import { type Label, listingStatusLabel } from './labels.js';
import type { Locale } from './locale.js';

/**
 * Static UI copy for the landing hero (`app/page.tsx`), in both locales.
 *
 * Scope is deliberately narrow: brand and source names ("Xtelo", "jobs.ge",
 * "hr.ge") are never translated here — they're rendered from
 * `sourceLabel`/hardcoded strings elsewhere, not from this file — and the
 * "synced X ago" kicker fragment stays English in both locales, because it
 * runs through `relativeTime` (`lib/format.ts`), which is shared by every
 * other screen and hardcoded to `Intl.RelativeTimeFormat('en', ...)`.
 * Localizing that would ripple into screens this change doesn't touch.
 */
/** One visual line of the hero headline, as one or more coloured runs —
 * a line can straddle the plain/accent boundary (Georgian's does, see KA
 * below), so accent is tracked per run, not per line. */
export type HeadlineRun = { text: string; accent: boolean };

export interface HeroCopy {
  headline: ReadonlyArray<ReadonlyArray<HeadlineRun>>;
  subhead: string;
  browseOpenings: string;
  closingSoon: string;
  noAccountNeeded: string;
  statOpenVacancies: string;
  statBoardsMerged: string;
  statListingsTracked: string;
  newestListings: string;
  seeAllOpenings: (count: string) => string;
  emptyState: string;
  deadlinePassed: string;
  deadlinePassedExplanation: string;
  /**
   * The newest-listings panel's per-source pill falls back to this for
   * every non-"active but this member's own deadline passed" inactive
   * state — `closed`, `expired`, `missing_suspected`, `discovered` — which
   * a cross-posted pair genuinely can show even on this landing page (one
   * board eligible, the other not). A Codex review (2026-09-16) caught the
   * first cut of this file leaving those to English-only
   * `listingStatusLabel`, visible mid-Georgian-hero.
   */
  sourceStatusLabel: (status: string) => Label;
  pause: string;
  play: string;
}

const EN: HeroCopy = {
  headline: [
    [{ text: 'DO NOT MISS', accent: false }],
    [{ text: 'YOUR CHANCE,', accent: false }],
    [{ text: 'KEEP YOURSELF', accent: true }],
    [{ text: 'POSTED!', accent: true }],
  ],
  subhead:
    'Job vacancies from jobs.ge and hr.ge, deduplicated into one record — browse, filter and shortlist without checking two sites separately.',
  browseOpenings: 'Browse openings',
  closingSoon: 'Closing soon',
  noAccountNeeded: 'no account needed',
  statOpenVacancies: 'open vacancies',
  statBoardsMerged: 'boards merged',
  statListingsTracked: 'listings tracked',
  newestListings: 'Newest listings',
  seeAllOpenings: (count) => `See all ${count} openings →`,
  emptyState:
    'There are no opportunities yet. They appear once a crawl has run and listings have been grouped.',
  deadlinePassed: 'deadline passed',
  deadlinePassedExplanation:
    'This board still lists it as active, but its own stated deadline has already passed.',
  sourceStatusLabel: listingStatusLabel,
  pause: 'Pause',
  play: 'Play',
};

// Headline text supplied directly by the project owner — not a Claude
// translation. Same words as given ("არ გამოტოვო ვაკანსია, მოძებნე
// მარტივად!"), reflowed into three lines at the project owner's request:
// the comma doesn't end a line (its word stays joined with what follows
// rather than the next word starting fresh after it), and the bottom line
// is a single word. An earlier four-line cut (one clause per line) had
// separately been needed to fix a real overflow bug — at the full hero
// size the two-full-clause version measured 1274px/1066px against a 750px
// column, silently clipped by the line wrapper's `overflow-hidden` rather
// than wrapped, since each line is `whitespace-nowrap` for the
// line-by-line entrance animation — so this reflow keeps that fix's
// per-line width budget in mind rather than reverting to full clauses.
//
// Accent follows the English original's own split exactly: its first
// clause ("DO NOT MISS YOUR CHANCE,") is plain and its second ("KEEP
// YOURSELF POSTED!") is accent. Georgian's clause boundary is the comma
// after "ვაკანსია," — mid-line-2 once reflowed above — so "მოძებნე" is an
// accent run on an otherwise-plain line, not a whole accent line; this is
// why headline lines are coloured per run rather than per line.
const KA: HeroCopy = {
  headline: [
    [{ text: 'არ გამოტოვო', accent: false }],
    [
      { text: 'ვაკანსია, ', accent: false },
      { text: 'მოძებნე', accent: true },
    ],
    [{ text: 'მარტივად!', accent: true }],
  ],
  subhead:
    'ვაკანსიები jobs.ge-დან და hr.ge-დან, გაერთიანებული ერთ ჩანაწერად — დაათვალიერე, გაფილტრე და შეინახე, ორი საიტის ცალ-ცალკე შემოწმების გარეშე.',
  browseOpenings: 'ვაკანსიების დათვალიერება',
  closingSoon: 'მალე იხურება',
  noAccountNeeded: 'რეგისტრაციის გარეშე',
  statOpenVacancies: 'ღია ვაკანსია',
  statBoardsMerged: 'გაერთიანებული საიტი',
  statListingsTracked: 'აღრიცხული განცხადება',
  newestListings: 'უახლესი განცხადებები',
  seeAllOpenings: (count) => `ყველა ${count} ვაკანსიის ნახვა →`,
  emptyState:
    'ჯერჯერობით ვაკანსიები არ არის. ისინი გამოჩნდება საიტების შემოწმებისა და განცხადებების დაჯგუფების შემდეგ.',
  deadlinePassed: 'ვადა გავიდა',
  deadlinePassedExplanation:
    'ეს საიტი ამ განცხადებას მაინც აქტიურად აჩვენებს, თუმცა მისი ვადა უკვე გავიდა.',
  sourceStatusLabel: kaSourceStatusLabel,
  pause: 'პაუზა',
  play: 'დაკვრა',
};

// Mirrors `listingStatusLabels` in `labels.ts` (same five
// `SourceListingStatus` values — kept as string keys here rather than
// importing that internal, unexported type) so a source pill on this
// localized page never falls back to English. `discovered` is included
// for completeness even though it's very unlikely to reach this
// already-eligible-opportunity panel.
const KA_SOURCE_STATUS_LABELS: Record<string, Label> = {
  discovered: {
    short: 'ჯერ არ არის შემოწმებული',
    explanation: 'იპოვეს განცხადებების სიაში, მაგრამ დეტალური გვერდი ჯერ არ არის შემოწმებული.',
  },
  active: {
    short: 'ღია',
    explanation: 'გამოჩნდა ამ საიტის ბოლო შემოწმებისას.',
  },
  missing_suspected: {
    short: 'შესაძლოა აღარ არის',
    explanation:
      'ბოლო შემოწმებისას ვერ მოიძებნა. ეს ვარაუდია და არა ფაქტი — საიტმა შესაძლოა უბრალოდ შეცვალა განცხადებების ჩვენების წესი. დახურულად ითვლება მხოლოდ რამდენიმე ზედიზედ გამოტოვების შემდეგ.',
  },
  closed: {
    short: 'დახურული',
    explanation: 'არ გამოჩნდა რამდენიმე ზედიზედ სრულ შემოწმებაზე, ამიტომ ითვლება მოხსნილად.',
  },
  expired: {
    short: 'ვადაგასული',
    explanation: 'საიტმა მიუთითა განაცხადის ვადა და ის უკვე გავიდა.',
  },
};

function kaSourceStatusLabel(status: string): Label {
  return (
    KA_SOURCE_STATUS_LABELS[status] ?? {
      short: 'უცნობი მდგომარეობა',
      explanation: `ამ მდგომარეობისთვის ("${status}") ტექსტი არ არსებობს.`,
    }
  );
}

export function heroCopy(locale: Locale): HeroCopy {
  return locale === 'ka' ? KA : EN;
}
