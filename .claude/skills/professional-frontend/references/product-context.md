# What Xtelo is

A job aggregator for the Georgian market, live at `jobster.fun`. It crawls jobs.ge
and hr.ge, dedupes listings across both, and ranks them against a candidate
profile. Three runtime surfaces share this code (`XTELO_SURFACE`: `local`, `public`,
`admin`); the public site is the catalogue plus browser-side CV matching
(`/cv-ranked`, where the CV never leaves the browser).

**Audience: job seekers who come back to triage, not a marketplace of visitors.**
There is no signup funnel, no pricing page and no visitor account system (the
only login is the owner's admin surface) — every working screen (browse, detail,
review, ranked, CV Ranked, shortlist, source health) is a tool for someone who
returns to triage new listings. Design those for repeat use and speed,
not for first impressions, and none of them carries a hero.

That single fact invalidates most generic "web design" advice for the working
screens. Nobody scanning `/opportunities` needs to be persuaded to scroll.

**One deliberate, named exception: the root landing page (`/`).** It is the one
entry point anyone actually lands on before reaching the working screens — there
being no accounts means every visit starts here, whether it is someone's first
time or their hundredth — and it carries a hero — full-bleed video background, a
motion-led headline, live proof (open-vacancy count, newest listings, a ticker) —
by explicit project-owner decision (`docs/STATUS.md`, Phase 3D and the Phase 3E
landing-hero redesign). This does not reopen the rule for any other screen: a
triager who has already clicked past `/` into `/opportunities` still wants the
list to stop where they put it, with no persuasion surface
anywhere in the working tool.

## The screens already exist

Do not invent an information architecture. The CLI defines it, and
`src/browse/queries.ts` already returns exactly what each screen needs — it was
built headless specifically so a UI would consume it rather than write its own SQL:

| CLI command | Screen | Query function |
|---|---|---|
| `browse listings` | Raw per-source listings, searchable, filter by source/status/deadline/first-seen | `searchListings` |
| `browse opportunities` | The deduplicated canonical view — what the user actually browses | `searchOpportunities` |
| `browse review` | Duplicate review queue: two listings side by side, decide same/different | `listReviewQueue` |
| `browse health` | Per-source crawl health and coverage | `getSourceHealth` |
| `rank results` | Ranked opportunities for a stored profile, with component scores (local surface) | `listRankedOpportunities` (in `src/ranking/run-ranking.ts`) |

The public `/cv-ranked` screen is not a CLI-derived screen: matching runs in the
browser against a published bundle (`src/matching/`, `/api/matching/*`), and the
public catalogue reads through `src/browse/public-queries.ts`, never the queries
above. Admin screens live under `web/app/(admin)/admin/`.

## The query layer is not always complete for the UI

Treat it as a strong starting point, not a finished contract. The known gap has
been closed: `ReviewQueueEntry` now carries `evidence` (the scored signals and
reasons behind a duplicate suggestion), and `AGENTS.md` still classes an
evidence-free review UI as a P1 defect. The lesson stands: when a screen needs a
field the mapped result drops, widen the return type rather than working around
it in the component, and check for such gaps before building each screen.

## Data access

Next.js server components may import these query functions directly for page
rendering — that is the point of having a typed query layer in the same
repository. Where a genuine HTTP surface is warranted, use Route Handlers, which
are the "comparably small TypeScript HTTP layer" the concept calls for in the
browse/search phase (§ stack table). Neither approach forbids the other; what is
forbidden is a component reaching past both into raw SQL.

## Corpus shape (measured, not guessed)

The figures below were measured on an early-September sample and are shape
guidance, not current counts. The corpus has since grown to thousands of
listings and open vacancies, with a review backlog in the thousands; get live
counts with `npm run browse -- health` or a read-only query rather than quoting
them here.

- **Cross-source duplicates are a minority.** The dedupe view is therefore *not*
  dramatically shorter than the raw list — do not design as if merging collapses
  the corpus.
- **The review queue is a backlog, not a feed.** Design it as a focused
  adjudication task with progress and filtering, and do not assume it is small.
- **Titles: median 22 characters, 90th percentile 42, longest 105.** Short. A
  title column can be narrow; a full-width heading for a 22-character title wastes
  the screen.
- **Descriptions: 90th percentile 3,235 characters, longest 6,657.** Long, plain
  text, no reliable internal structure. This is the hard layout problem — see
  `data-density.md`.
- **Listing statuses:** `discovered`, `active`, `missing_suspected`, `closed`,
  `expired`, `quarantined` (`source_listing_status` enum). `active` and
  `missing_suspected` are the common ones.
- **Field coverage is disjoint by source.** hr.ge has locations on every listing
  and salary on some; jobs.ge has neither on any. "One source has this field, the
  other does not" is the normal case, not an edge case. Never design a layout that
  looks broken when a field is absent.

## Design tokens

The stack is Next.js 16 + Tailwind 4 in `web/`, and the token set lives in the
`@theme` block of `web/app/globals.css` (colour, surface, text, border, radius,
type). Every value comes from those tokens. Ad-hoc `text-blue-500` / `p-[13px]`
is the failure this prevents.

Semantic colour is doing real work here: `active` vs `missing_suspected` vs
`closed` must be distinguishable at a glance, and by more than hue alone.
