# What Xtelo is

A job aggregator for the Georgian market. It crawls jobs.ge and hr.ge, dedupes
listings across both, and ranks them against a candidate profile.

**Audience: one serious job seeker, not a marketplace of visitors.** There is no
signup funnel, no pricing page, no account system at all — every working screen
(browse, detail, review, ranked, shortlist, source health) is a tool for someone
who returns daily to triage new listings. Design those for repeat use and speed,
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
| `rank results` | Ranked opportunities for a profile, with component scores | `listRankedOpportunities` (in `src/ranking/run-ranking.ts`) |

## The query layer is not complete for the UI

Treat it as a strong starting point, not a finished contract. One gap is known
and blocking:

**`listReviewQueue` does not return the pair's evidence.** `ReviewQueueEntry`
exposes `candidateId`, `similarityScore`, `decision`, `a` and `b` — but not
`duplicateCandidates.evidence`, which holds the scored signals and reasons behind
the suggestion. The query already selects the full row; the mapped result drops
it. Since `data-density.md` makes showing that evidence the most important design
requirement of the review screen, and `AGENTS.md` classes an evidence-free review
UI as a P1 defect, **widening this return type is the first implementation task of
the review screen** — not something to work around in the component.

Check for similar gaps before building each screen rather than assuming the
function returns everything the design needs.

## Data access

Next.js server components may import these query functions directly for page
rendering — that is the point of having a typed query layer in the same
repository. Where a genuine HTTP surface is warranted, use Route Handlers, which
are the "comparably small TypeScript HTTP layer" the concept calls for in the
browse/search phase (§ stack table). Neither approach forbids the other; what is
forbidden is a component reaching past both into raw SQL.

## Corpus shape (measured, not guessed)

- **410 listings → 406 canonical opportunities.** Only 4 confirmed cross-source
  duplicates. The dedupe view is therefore *not* dramatically shorter than the raw
  list — do not design as if merging collapses the corpus.
- **11 pairs pending review.** The review queue is small and finite. It is a
  focused adjudication task, not an infinite feed.
- **Titles: median 22 characters, 90th percentile 42, longest 105.** Short. A
  title column can be narrow; a full-width heading for a 22-character title wastes
  the screen.
- **Descriptions: 90th percentile 3,235 characters, longest 6,657.** Long, plain
  text, no reliable internal structure. This is the hard layout problem — see
  `data-density.md`.
- **Statuses in use:** `active` (310), `missing_suspected` (96). Also possible:
  `closed`, `expired`, `discovered`, `quarantined`.
- **Field coverage is disjoint by source.** hr.ge has locations on every listing
  and salary on some; jobs.ge has neither on any. "One source has this field, the
  other does not" is the normal case, not an edge case. Never design a layout that
  looks broken when a field is absent.

## Design tokens

No stack is installed yet. When Next.js + Tailwind land, define the token set
first and commit it before building screens — colour, surface, text, border,
spacing scale, radius, type scale. Every subsequent value comes from those tokens.
Ad-hoc `text-blue-500` / `p-[13px]` is the failure this ordering prevents.

Semantic colour is doing real work here: `active` vs `missing_suspected` vs
`closed` must be distinguishable at a glance, and by more than hue alone.
