# Visual direction

Xtelo's look derives from **SynapseX**, a cinematic single-page site the project
owner supplied as reference
(`~/Documents/Codex/2026-09-06/an/outputs/synapsex`). Decided 2026-09-06.

Read this as the settled brief. `frontend-design` says the brief's own words
always win where it pins a direction down — this file is that brief. Where it
leaves an axis free, apply that skill's judgement.

## What was taken, and why

SynapseX is a marketing site with video backgrounds and scroll-linked motion;
Xtelo is a dense triage tool. The **visual system** transfers; the **cinematics**
do not. Concretely:

### Palette: one set, two themes (Phase 16A, 2026-11-14)

The original SynapseX palette (pure black, a pink accent `#d88bd2`) is gone. Since
Phase 16 the whole site uses one colour set, the lime family the Browse and landing
screens already had, in two themes the visitor switches with the sun and moon in
the header: **light** (a first visit's theme, owner decision 2026-11-14) and
**dark** (the site as it was). `web/app/globals.css` is the source: dark values in
`@theme static`, light values under `:root[data-theme="light"]`, and the root
layout sets `data-theme` from the `xtelo-theme` cookie. A component names a role,
never a hex, and `web/lib/theme-cookie.test.ts` fails on a raw hex, a retired
token or a colour with no light value.

```
role                    dark       light
--color-background      #07090b    #f4f5f1   page ground
--color-surface         #0e1114    #ffffff   panels, popovers
--color-surface-raised  #141920    #eef0ea   one step up
--color-surface-active  #1c2228    #e4e9da   selected / active rows
--color-foreground      #f3f6f8    #12161a
--color-muted           #b7c2ca    #3c4750   secondary columns
--color-faint           #8b97a1    #59646e   tertiary, labels, counts
--color-nontext         #55616b    #8a948a   dividers, disabled: NOT text
--color-border          #1c2228    #e1e4dc   hairlines
--color-border-strong   #2a323a    #cbd2c6   control edges
--color-brand           #d6ff3f    #d6ff3f   lime FILL, with ink on it
--color-accent          #d6ff3f    #4a6400   lime TEXT (olive on light)
--color-accent-line     #d6ff3f    #7aa300   lime lines, dots, bars
--color-ink             #0b0d10    #0b0d10   text on lime and on the header
--color-header          #f2ee00    #f2ee00   the yellow header, both themes
--color-ring            #d6ff3f    #3f5800   focus
```

Plus status (open, unconfirmed, closed, held), warn, kind (job, tender, course)
and metro-line colours, each with both values in `globals.css`.

**The light rule that matters most:** lime is never text on white (about 1.1:1).
It fills buttons and selected options under ink; words in the brand colour use
`accent` (olive); decorative lines and dots use `accent-line`. Every text colour
measures 4.5:1 or better against all four surfaces of its theme; the plan's
first light status and kind colours (3.6 to 4.2 on the selected-row ground) were
darkened to get there.

The muted-text ladder is still the most useful thing here: a dense table needs
exactly that gradation for secondary and tertiary columns.

**Focus ring** — `outline: 2px solid var(--color-ring); outline-offset: 6px`, in
Tailwind's base layer so a component can replace it: the yellow header uses a 2px
ink ring, since lime on that yellow cannot be seen.

Near-black stays the dark ground for an ergonomic reason, not only an aesthetic
one: this is a tool someone stares at daily. Light exists because most visitors
arrive in daylight on a phone.

### Typefaces — changed, and this is the one real departure

**SynapseX sets `Space Mono` for everything. That cannot be used for content.**
Google's own font metadata lists Space Mono's subsets as `latin`, `latin-ext`,
`menu` — **no Georgian**. With about 95% of titles in Georgian and about 5% mixing both
scripts in a single string, adopting it would trigger exactly the two-typeface
failure `georgian-typography.md` exists to prevent, on nearly every row.

So:

| Role | Face |
|---|---|
| All content and UI text | **Noto Sans Georgian** (variable, self-hosted) |
| Numerics, dates, scores, IDs, counts | **Space Mono** |

Space Mono survives where its content is Latin and digits, and where monospace is
independently the right call — the interface checklist asks for tabular figures
in numeric columns anyway. That keeps the reference's character in the chrome
while losing nothing to font fallback.

No display serif. No third family. Anton SC (SynapseX's watermark face) is not
used — it has no Georgian either, and the watermark itself is out (below).

### Deliberately not taken

Each of these is either on `anti-patterns.md` or blocked by the corpus:

- **Video backgrounds and a hero, on every working screen** — browse, detail,
  review, ranked, CV Ranked, shortlist, source health. Decorative motion on a surface
  re-scanned several times a day. **Named exception: the root landing page
  (`/`)** carries a video-background hero by explicit project-owner decision
  (`docs/STATUS.md`, Phase 3D and Phase 3E) — it is the one screen a visitor
  is not yet re-scanning, so the "no persuasion surface" reasoning does not
  apply there. The mouse-scrubbed variant stays out everywhere, including `/`.
- **Glassmorphism** (`backdrop-filter: blur(16px)` on the nav).
- **Scrambled entrance and hover text.** Also incompatible with Georgian — it
  operates per character on a multi-byte script.
- **Lenis smooth-scroll and scroll-linked reveals.** A triager wants the list to
  stop where they put it.
- **ALL-CAPS tracked eyebrows** (`.eyebrow`). Georgian is unicase; the pattern is
  meaningless on any label that touches data, and `frontend-design` lists it as a
  generated-page tell regardless.
- **The 521px watermark**, on any screen, `/` included. `/`'s own hero type
  (`clamp(46px, 7.4vw, 104px)`, Bebas Neue) is the named exception above's
  headline, not this watermark treatment — the densest working screen is
  still the first *working* screen, `/opportunities`, not `/` itself.
- **Pill buttons** (`border-radius: 100px`) as the default control shape. Use the
  `0.75rem` radius consistently instead.

## Applying it

Density comes first: the palette serves a table that fits 20+ rows at 1280×800,
not a landing page. When the reference and `data-density.md` disagree, density
wins — the reference was chosen for its colour and restraint, not its layout.

Motion is limited to what answers a user action: a dialog opening, a decision
confirming, an undo landing. Respect `prefers-reduced-motion` throughout, which
SynapseX itself does.
