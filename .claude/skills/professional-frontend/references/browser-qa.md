# The browser QA gate

Frontend work in this repo is not complete until it has been rendered and
inspected. A successful `next build`, a passing typecheck and a green test run are
all necessary and none of them is sufficient — they say the code runs, not that
the interface works.

**Playwright MCP is already connected in this environment.** Use it directly.
Do not install the Python `webapp-testing` skill: it would add a Python
dependency to duplicate a browser you already have, and `docs/scraplify-concept.md`
§25 explicitly warns against stacking overlapping `webapp-testing` variants.

## The gate

Run the dev server, then walk this. Anything found is fixed and the gate re-run —
not noted as a follow-up.

### 1. Real data — but read-only against the live corpus

QA must run against real Georgian content. **Never QA against invented placeholder
text**: Latin filler hides the Georgian rendering problems that are the most
likely defects here, and it hides the real distribution of title and description
lengths.

But split the two kinds of checking, because they are not equally safe:

- **Read-only inspection** (layout, typography, viewports, states, keyboard
  traversal) runs against the live database — 410 listings, 406 opportunities,
  11 pending review pairs.
- **Anything that writes** runs against a **disposable database seeded with a
  copy of that data**, never the live one.

The distinction is not fussiness. Exercising the review screen calls
`resolveDuplicateCandidate`, which permanently marks a candidate as adjudicated
by a human, and the merge/detach paths append membership rows and stamp
`supersededAt` tombstones. There are only 11 real pending pairs, and clicking
through them during QA consumes them and writes a false human decision into an
audit trail that exists precisely to record genuine ones. Undo does not help —
the reversal is itself recorded.

This repo has corrupted its own live data twice already through exactly this kind
of "it's only a test" write. The real-data guard covers the test suite; it does
not cover a browser session, so this separation is the only thing standing in
for it here.

### 2. Viewports

Check at minimum:

| | width |
|---|---|
| mobile | 390 |
| tablet | 768 |
| desktop | 1280 |
| large | 1920 |

At each: no horizontal overflow on `<body>`, no clipped text, no unexpected
scrollbars, no layout that only works at the width you developed at.

Mobile deserves real thought, not stacking. A 406-row table on a 390px screen
needs a decided answer — which columns survive, what becomes secondary, what
collapses. Decide it rather than letting it reflow.

### 3. Georgian rendering

Specifically confirm, with real listing titles on screen:

- Mixed Georgian/Latin titles render in **one** typeface. Test with a known mixed
  row, e.g. `უფროსი Android დეველოპერი`.
- No uppercase transform is hitting Georgian anywhere.
- Descenders are not clipped at the chosen line-height.
- Long Georgian titles truncate cleanly, mid-grapheme artefacts absent.

### 4. States

For every screen that fetches: loading, empty, error. Empty is reachable for real
— apply a filter that matches nothing. For every interactive control: default,
hover, focus-visible, active, disabled, and where relevant loading and selected.

Do not design only the default state.

### 5. Keyboard

Tab through each screen. Focus order sensible, focus always visible, no traps.
The review queue must be operable end-to-end without a mouse — it is a repetitive
adjudication task and that is where keyboard support pays for itself.

Dialogs: focus moves in, is trapped, `Escape` closes, focus returns to the trigger.

### 6. Interactions

Navigation, filters, search (with **Georgian** input), sorting, pagination if
present, dialogs, and each review-queue decision path including the undo.

**Point the app at the disposable database before this step** — every
review-queue decision path writes. See step 1.

### 7. Design review

Run the `web-design-guidelines` skill over the changed files. It fetches Vercel's
current rules at review time, so it stays fresh.

Then re-read `anti-patterns.md` against what you actually built — particularly the
fabricated-data section, which is the failure with real consequences here.

### 8. Fix and repeat

Re-run the gate after fixing. Only then is the work complete.

## What this gate is not

It is not a substitute for automated tests, and it is not a one-time ritual at the
end of a phase. Run it per meaningful UI change. It is cheap — the browser is
already connected.
