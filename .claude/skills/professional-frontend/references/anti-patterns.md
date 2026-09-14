# Anti-patterns, tuned to Xtelo

Generic anti-slop lists spend most of their length on marketing-page failures —
fake testimonials, pricing cards, hero gradients, three-column feature grids.
**None of those can occur here**, because Xtelo has no marketing surface. Listing
them would be noise that dilutes the rules that do apply.

`frontend-design` already covers the general aesthetic tells (the cream/serif/
terracotta cluster, the SaaS-card kit, ALL-CAPS eyebrows, `→` on buttons). Do not
duplicate it. What follows is what goes wrong in **this** app specifically.

## Fabricated data — the worst failure here

Xtelo's entire value is that its data is real and traceable to a source. Inventing
any of it in the UI is not a cosmetic problem, it is a correctness problem.

- **Never invent listings, employers, salaries or logos** for a mockup or an empty
  state. Use real rows from the database — there are 410.
- **Never show a metric the backend does not compute.** No "new this week" counter,
  no match-percentage, no trend arrow, unless a real query returns it.
- **Never fabricate a company logo or avatar.** Employers are Georgian company
  names, mostly with no logo available. A letter-mark from a real name is
  acceptable; a stock image is not.
- **Never invent a confidence or score.** Ranking produces real component scores;
  show those, or show nothing.
- **Never round or soften a status.** If it is `missing_suspected`, do not display
  it as active because that looks tidier.

## Losing provenance

- Don't merge both sources' descriptions into one block. They are kept separate
  deliberately.
- Don't present a canonical opportunity without a route back to its source
  listings. Every merge must be inspectable and reversible.
- Don't hide the reasons behind a duplicate suggestion. See `data-density.md`.

## Density failures

- Turning table rows into cards. Costs vertical space, breaks column alignment,
  and makes 406 rows unscannable.
- Card-inside-card. Especially in the review queue, where the temptation is a card
  per side inside a card per pair.
- Full-width prose. Descriptions run to 6,657 characters; unconstrained line
  length makes them unreadable.
- Giant display type for a 22-character title.
- Whitespace so generous that fewer than ~15 rows fit on a laptop screen.

## Georgian-specific

- `text-transform: uppercase` anywhere Georgian can appear. See
  `georgian-typography.md` — Mkhedruli has no capitals.
- A font stack that lacks Georgian coverage. Produces two typefaces in one string
  for the 22 mixed-script titles in this corpus.
- Latin-tuned letter-spacing on Georgian.
- Truncating Georgian strings in JavaScript by character index.

## Animation libraries

None is installed, and that is deliberate. React Bits was evaluated as a
component source and rejected: it is an animation and effects library
(`Dither`, `BlurText`, `SplitText`, `ClickSpark`), and its components belong on
landing pages, which this product does not have.

If one is ever added, the boundary is: **never on the working surfaces.** The
opportunities list, the review queue and the listing detail are used repeatedly,
daily, at speed — entrance animations, scroll-triggered reveals and per-card
hover effects make a scanning tool slower and more tiring. Character-splitting
text effects are additionally unsafe here, since they operate per character on a
multi-byte script.

Motion that answers a user action is fine and needs no library: a dialog
opening, a decision confirming, an undo landing. Respect
`prefers-reduced-motion` for all of it, without exception.

## Interaction

- Decorative motion. A page that animates rows in on every load is actively
  hostile to a user scanning the same list several times a day.
- Hover-only affordances. The review queue must be fully keyboard-operable.
- Irreversible-feeling confirmations for reversible actions, and — worse — the
  opposite: a one-click destructive-looking action with no visible undo.
- Toasts as the only feedback for something the user must not miss.

## Vocabulary

- Raw enums or IDs in the interface: `missing_suspected`, `confirmed_same`,
  `quarantined`, UUIDs.
- Emoji as interface icons.
- Untranslated jargon from the codebase — "canonical opportunity", "membership",
  "revision" are internal terms, not user-facing ones.
