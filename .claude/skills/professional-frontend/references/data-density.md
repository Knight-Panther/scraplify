# Density and the three hard screens

Xtelo is a scanning tool. The user's core loop is *reject fast, open the few worth
reading*. Every layout decision serves that. Generous whitespace that fits eight
listings on a screen is a worse design here than a tighter one that fits thirty,
even though the airy version photographs better.

Three screens carry real design difficulty. The rest are ordinary.

## 1. The opportunities list (the main screen)

406 rows. The user scans it repeatedly.

- **A row must be scannable in one fixation.** Title, employer, source, status,
  deadline. Titles are short (median 22 chars) so the title column can be narrow —
  do not give a 22-character string a full-width display heading.
- **Show which source(s) back each opportunity.** Cross-posting is the product's
  whole premise; a canonical opportunity carrying both boards is more trustworthy
  and the user should see that without opening it.
- **Absent fields are normal, not errors.** jobs.ge has no location and no salary
  on any listing. A row must not show empty slots, dashes in a column of blanks,
  or a skeleton that never fills. Design the row so a missing field simply
  isn't there.
- **Status needs more than colour.** `active` vs `missing_suspected` differ in
  meaning the user acts on, and 96 of 406 are `missing_suspected`. Use a label or
  shape as well as hue — this is also a contrast/colour-blindness requirement.
- **Never show the raw enum.** `missing_suspected` is a database state. The user
  needs something like "may be gone" with the real meaning available on hover or
  in detail — the listing was not seen on the last crawl, which is a suspicion,
  not a fact.

## 2. The review queue (the hardest screen)

Two listings side by side; the user decides whether they are the same vacancy.
Only 11 pairs pending, so this is a focused task, not a feed.

- **The decision needs evidence, not a verdict.** Every candidate pair carries
  scored signals and reasons in its `evidence` column. The UI must surface *why*
  the pair was proposed — shared application link, matching employer, title
  similarity — or the user is rubber-stamping a black box. This is the single most
  important design problem in the app.
- **Make the differences visible.** Two nearly identical Georgian titles are hard
  to diff by eye. Align the two sides field-by-field so differing values sit
  adjacent, and consider marking what differs.
- **Decisions are reversible and must feel it.** `membership-review.ts` never
  deletes anything; a merge can be detached later. Don't design a scary
  irreversible confirmation for an action that is in fact undoable — but do make
  the undo path visible.
- **Keyboard first.** Adjudicating pairs is repetitive. Same / different / skip
  should all be reachable without the mouse, with visible focus.

## 3. The listing detail

Descriptions run to 3,235 characters at the 90th percentile and 6,657 at worst —
long, plain, unstructured Georgian text with no reliable internal headings.

- **Constrain the measure.** Long text at full container width is unreadable. Cap
  around 65–75 characters per line (see `georgian-typography.md` for leading).
- **Do not fabricate structure.** The text has no reliable sections; do not invent
  headings, split it into cards, or auto-bullet it. Present it as the prose it is.
- **A cross-posted opportunity has several descriptions.** Both boards' text is
  preserved deliberately, because each may carry facts the other lacks. Show them
  as distinct, attributed to their source — never silently concatenated, which is
  what the ranking layer does internally and must not leak into the UI.
- **Application route is the primary action.** It may be a mailto, an external
  ATS link, or absent. All three cases need a deliberate treatment, including the
  absent one.

## General

- Tables are the right primitive for tabular data. Do not turn rows into cards to
  look modern — cards cost vertical space and destroy column alignment, which is
  what makes scanning work.
- Loading, empty and error states are required for every screen that fetches.
  Empty here is real: a filter can legitimately match nothing.
- 406 rows do not need virtualization. Do not add it preemptively.
