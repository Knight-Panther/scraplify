# Phase 3B — UI: the stage plan

**Reconstructed 2026-09-07**, after the planning session that produced the original
eleven-stage breakdown was cleared. `docs/STATUS.md` referenced "the phase plan" for
several days while no such file existed — the list lived only in a conversation. This
file is that list, rebuilt from what STATUS.md, the concept's Phase 3, and the shipped
code actually record. Stages 1–4 are described by their commits, so those are recovered
rather than guessed; 5–11 are a reconstruction of scope and ordering, and where the
original ordering cannot be recovered the rationale below is the current one, not a
transcript of the old one.

The authority for *what* is in scope remains `docs/scraplify-concept.md` §Phase 3 and
the scope decision recorded in STATUS.md (2026-09-06). This file only sequences it.

## Why eleven stages and not one branch of work

Each stage is a commit that leaves the app runnable and browser-QA'd. The ordering is
driven by two constraints, not by screen importance:

1. **Every read-only screen ships before any writing screen.** The write gate
   (`XTELO_WRITES_ENABLED`) exists because this project has twice corrupted real data
   during QA. Stages 5–7 cannot write by construction, so they can be QA'd against the
   live corpus. Stage 8 is where that stops being true.
2. **Two screens have known backend blockers** (duplicate review, taxonomy review).
   They are scheduled after the screens that have none, so a blocker cannot stall the
   stages that are ready.

## Stages

### 1. Next.js integration — done (2026-09-07)

`web/` inside the same npm package, server components importing `src/browse/queries.js`
directly. See STATUS.md for the four unanticipated fixes and for the **owed Codex
review** of this commit, which was landed with `--no-verify`.

### 2. Design system — done (2026-09-07)

Tokens in `web/app/globals.css`, the Georgian/mono typeface split, `npm run dev`.
Four defects found only in a real browser; see STATUS.md.

### 3. Source health — done (2026-09-07)

`web/app/health/page.tsx` plus `web/lib/labels.ts`, the enum-to-English map. Needed no
backend change.

### 4. Query-layer widening — done (2026-09-07)

`searchOpportunities` gained text/status/source/cross-posted/deadline/first-seen filters,
three sort orders, real totals via `countOpportunities`, and a corrected default sort:
earliest live-member `firstSeenAt`, not `opportunities.updatedAt`, which a dedupe pass
restamps on every cluster it touches.

### 5. Opportunities list — the main screen

The deduplicated list, and the screen a person opens daily. Consumes
`searchOpportunities` + `countOpportunities`. Filters in the URL (so a view is
linkable and the back button works), server-rendered, no client state.

**Done when:** filters, sort and pagination all round-trip through the URL; a
cross-posted cluster renders as one row naming both sources; totals agree with the CLI;
Georgian search works in a real browser.

### 6. Opportunity detail

One cluster in full: canonical fields, every live member with its own source link and
lifecycle state, and the description. The first screen where `--measure` and the long-
description case matter. Needs a `getOpportunity(id)` query — `searchOpportunities`
returns list-shaped rows and should not grow a detail mode.

### 7. Listings — the raw per-source view

`searchListings`, undeduplicated, with the concept's named views: **new, closing,
missing, quarantined**, and **changed as content-changes only** (status history is not
reconstructable — `source_listings.status` is updated in place and no history table
exists). This is the view that answers "what did the source actually say", which the
canonical list deliberately hides.

### 8. Saved items and dismissals — the first writing screen

The shortlist half of "browse and shortlist". Needs a new table, and it is where
`.env.qa` and the disposable QA database arrive, because it is the first screen that can
write. Every earlier stage is read-only by construction; from here the write gate is
load-bearing rather than precautionary.

### 9. Duplicate review

**Blocked on two backend defects, both recorded in STATUS.md and neither trivial:**

- `duplicate_candidates` has **no `evidence` column at all**. `scorePair`'s signals and
  reasons are computed and discarded for `needs_review` pairs, so the pairs a human must
  judge are exactly the ones with nothing stored. Fixing it needs a migration, a write
  change at both `run-dedupe.ts` candidate-insert sites (in `values` **and**
  `onConflictDoUpdate.set`, since all 15 rows already exist), a dedupe re-run to
  backfill, and only then the query widening.
- The "accept" verb is a composite — `reassignListing` plus `resolveDuplicateCandidate`,
  each opening its own transaction — so a crash between them leaves a merged cluster
  with an unsettled candidate that the next dedupe pass re-queues. Needs a transactional
  wrapper before the screen is built.

### 10. Ranked results

`src/ranking/` already produces explainable, component-wise scores against a versioned
profile. The screen's job is to show *why* a score is what it is, not just the number —
a rank with no visible reasoning is the thing the deterministic scorer was chosen to
avoid. `listLiveMembersByOpportunity` exists so this screen attaches members without
repeating the join.

### 11. Taxonomy review — blocked, but in scope

`sourceCategories` is empty on both sources, but **hr.ge persists `specialty` and
`industry` in `structuredAttributes` for all 100 of its listings** — 90 distinct Georgian
specialty values (`src/adapters/hr-ge/detail.ts:234-236`). So one source has real input
and jobs.ge has none. What is missing is the schema: no `taxonomy_terms`,
`source_taxonomy_mappings` or `listing_classifications` table exists in any migration,
though §12.6 specifies all three.

The concept is authoritative and requires Phase 3 to expose taxonomy review, so this
stays a deliverable in **blocked** state rather than being dropped. **Phase 3B cannot be
declared complete while it is unbuilt** — closing it needs either those tables plus a
jobs.ge category-capture change, or an explicit amendment to the concept.

## Before this branch merges

- The **owed Codex review of the Stage 1 commit** must run. It was bypassed when Codex
  ran out of credits mid-review, having already found one P1.
- `/codex:adversarial-review --base main` over the whole branch, per `CLAUDE.md` — the
  per-commit gate only ever sees one commit's diff, so cross-stage issues are invisible
  to it.
- Phase 3B's exit-gate checklist in `docs/STATUS.md` checked off honestly, in the same PR.
