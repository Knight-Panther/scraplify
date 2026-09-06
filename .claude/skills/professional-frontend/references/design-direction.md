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

### Palette — take it

```
--color-background      #000000     pure black ground
--color-surface         #121014     raised panels, popovers
--color-surface-raised  #1c191e     one step further up
--color-accent-surface  #29232e     selected / active rows
--color-foreground      #ffffff
--color-muted-fg        #ffffff99   secondary columns
--color-faint-fg        #ffffff66   tertiary, labels, counts
--color-disabled-fg     #ffffff40
--color-border          #ffffff26   hairline table rules
--color-accent          #d88bd2     the single accent
--color-accent-strong   #b841ad     selection background
--color-ring            #f0a9ea     focus
--radius                0.75rem
```

The three-step muted-text ladder (`99` → `66` → `40`) is the most useful thing
here: a dense table needs exactly that gradation for secondary and tertiary
columns, and it arrives already tuned.

**Focus ring, taken verbatim** — `outline: 2px solid #f0a9ea; outline-offset: 6px`.
Stronger and more visible than most defaults, and it satisfies the focus rules in
the interface checklist without further thought.

Near-black is an ergonomic choice here, not only an aesthetic one: this is a tool
someone stares at daily.

### Typefaces — changed, and this is the one real departure

**SynapseX sets `Space Mono` for everything. That cannot be used for content.**
Google's own font metadata lists Space Mono's subsets as `latin`, `latin-ext`,
`menu` — **no Georgian**. With 388 of 410 titles in Georgian and 22 mixing both
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

- **Video backgrounds** and the mouse-scrubbed hero. Decorative motion on a
  surface re-scanned several times a day.
- **Glassmorphism** (`backdrop-filter: blur(16px)` on the nav).
- **Scrambled entrance and hover text.** Also incompatible with Georgian — it
  operates per character on a multi-byte script.
- **Lenis smooth-scroll and scroll-linked reveals.** A triager wants the list to
  stop where they put it.
- **ALL-CAPS tracked eyebrows** (`.eyebrow`). Georgian is unicase; the pattern is
  meaningless on any label that touches data, and `frontend-design` lists it as a
  generated-page tell regardless.
- **The 521px watermark** and `clamp(40px, 10vw, 100px)` hero type. There is no
  hero; the densest screen is the first screen.
- **Pill buttons** (`border-radius: 100px`) as the default control shape. Use the
  `0.75rem` radius consistently instead.

## Applying it

Density comes first: the palette serves a table that fits 20+ rows at 1280×800,
not a landing page. When the reference and `data-density.md` disagree, density
wins — the reference was chosen for its colour and restraint, not its layout.

Motion is limited to what answers a user action: a dialog opening, a decision
confirming, an undo landing. Respect `prefers-reduced-motion` throughout, which
SynapseX itself does.
