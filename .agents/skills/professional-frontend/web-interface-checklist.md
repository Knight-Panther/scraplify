# Web interface checklist (Codex-readable snapshot)

Claude reviews UI against Vercel's Web Interface Guidelines through the global
`web-design-guidelines` skill, which fetches them fresh at review time. **Codex
cannot load that skill** — Claude and Codex skill discovery are separate — so this
is a static snapshot of the same rules, condensed to what applies to Xtelo.

Source of truth, fetch it if you can:
`https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md`
Snapshot taken 2026-09-06. If it is much older than the code you are reviewing,
say so rather than trusting it.

## Where these rules and Xtelo's rules disagree

Three genuine conflicts. **Xtelo's own rules win**, and flagging code for
following them would be a false positive:

1. **"Title Case for headings and buttons"** — a Latin-only rule. Georgian
   Mkhedruli is unicase, and `anti-patterns.md` bans case transforms on anything
   that can carry Georgian. English chrome may use sentence case; do not flag it.
2. **"Large lists (>50 items): virtualize"** — `data-density.md` explicitly says
   406 rows do not need virtualization and that adding it preemptively is wrong.
   Do not flag its absence.
3. **"Destructive actions need a confirmation modal or undo window"** — Xtelo's
   review and shortlist actions are genuinely reversible, and `data-density.md`
   forbids a scary confirm for a reversible action. A **visible undo** satisfies
   this; a missing undo does not.

## Accessibility

- Icon-only buttons need `aria-label`; decorative icons need `aria-hidden="true"`
- Form controls need a real `<label>` (clickable, via `htmlFor` or wrapping)
- `<button>` for actions, `<a>`/`<Link>` for navigation — never `<div onClick>`
- Images need `alt` (or `alt=""` when decorative) and explicit width/height
- Async updates (toasts, validation) need `aria-live="polite"`
- Semantic HTML before ARIA; headings hierarchical; skip link to main content

## Focus

- Visible focus on every interactive element; `:focus-visible`, not `:focus`
- Never `outline: none` without a replacement
- Sticky headers must not cover the focused element
- Dialogs trap focus, close on `Escape`, return focus to the trigger

## Forms

- Correct `type` and `inputmode`; meaningful `name`; `autocomplete` considered
- **Never block paste.** Georgian is frequently pasted rather than typed here
- `spellCheck={false}` on codes and identifiers
- Submit stays enabled until the request starts, then shows progress
- Errors inline beside the field; focus the first error on submit

## Animation

- Honor `prefers-reduced-motion` — no exceptions
- Animate `transform`/`opacity` only; never `transition: all`
- Animations interruptible

## Typography

- `…` not `...`; curly quotes; non-breaking spaces in things like `10&nbsp;MB`
- `font-variant-numeric: tabular-nums` on numeric columns
- `text-wrap: balance`/`pretty` on headings
- Xtelo adds: no case transforms, no content letter-spacing, CSS truncation only

## Content handling

- Long content handled with `truncate` / `line-clamp-*` / `break-words`
- Flex children need `min-w-0` or truncation silently fails
- Empty states handled — never render broken UI for an empty array
- Anticipate short, average and very long values. Here that is real: titles run
  22 to 105 characters, descriptions to 6,657

## Navigation and state

- **URL reflects state** — filters, tabs, pagination in query params
- Real links so Cmd/Ctrl-click and middle-click work

## Performance

- No layout reads during render
- Preload critical fonts with `font-display: swap`

## Locale

- `Intl.DateTimeFormat` / `Intl.NumberFormat` — never hardcoded formats
- `translate="no"` on identifiers and brand names

## Hydration

- An input with `value` needs `onChange`, or use `defaultValue`
- Guard date/time rendering against server/client mismatch

## Anti-patterns to flag

`user-scalable=no` or `maximum-scale=1`; `onPaste` + `preventDefault`;
`transition: all`; `outline-none` with no replacement; click handlers on
`<div>`/`<span>`; images without dimensions; inputs without labels; icon buttons
without `aria-label`; hardcoded date/number formats; `autoFocus` without
justification; gesture-only actions with no keyboard alternative.

## Reporting

This file supplies interface **rules only**. Report whatever you find here in
the format the invoking review command asks for — the pre-commit workflow
consumes a machine-readable findings schema, and a competing output format from
a loaded skill produces unusable results.
