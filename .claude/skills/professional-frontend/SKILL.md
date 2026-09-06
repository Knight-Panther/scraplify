---
name: professional-frontend
description: Xtelo's own frontend rules — product context, Georgian-script typography, data-density patterns, and the browser QA gate. Use for any UI work in this repo, before writing components and again before calling frontend work done.
---

# Xtelo frontend

This skill carries the rules that are specific to **this** product. It is deliberately
not a general design manual — two installed skills already cover that ground, and
duplicating them here would just create two sources of truth that drift apart:

- **`frontend-design`** (Anthropic, global) — aesthetic direction, type scale,
  avoiding templated defaults. Use it to *generate* a visual direction.
- **`web-design-guidelines`** (Vercel, global) — accessibility and interface
  rules, fetched fresh at review time. Use it to *review* what was built.

Read this skill for what those two cannot know: what Xtelo is, who uses it, and
the constraints that come from its actual data.

## The one rule that matters most

**A passing build is not finished frontend work.** Neither is passing TypeScript,
nor a component that "looks right" in the code. Frontend work here is finished only
after it has been rendered in a real browser and inspected — see
`references/browser-qa.md` for the gate. Playwright MCP is already connected in
this environment, so there is no setup cost to doing it.

## Before writing any component

1. Read `references/product-context.md`. The screens are **already specified** by
   the existing CLI (`npm run browse` and `npm run rank`). Do not invent an
   information architecture — derive it from `src/browse/queries.ts`, the
   supported query layer. Note that layer is a starting point, **not a finished
   contract**: at least one screen needs its return type widened before it can be
   built correctly, and `product-context.md` names it.
2. Read `references/georgian-typography.md` **before choosing any font**. Most of
   this corpus is Georgian script. The wrong font stack is the single most likely
   way this UI will look broken, and it is invisible to anyone testing with Latin
   placeholder text.
3. Read `references/data-density.md`. This is a dense data tool, not a landing
   page. Its failure modes are not the usual ones.
4. Check `references/anti-patterns.md` — tuned to this product, not a generic list.

## During implementation

- Reuse `src/browse/queries.ts` rather than writing SQL in a component. Server
  components may import it directly for page rendering; Route Handlers serve as
  the concept's "small TypeScript HTTP layer" where a real HTTP surface is
  warranted. Widen a query's return type when a screen needs more, instead of
  querying around it.
- Semantic HTML first, then shadcn primitives, then custom. shadcn supplies
  accessible *behaviour* (dialog, combobox, table) — it is not the visual identity.
- Every value from a token. No arbitrary hex, spacing, radius or shadow.
- Never render a raw enum or ID to the user. `missing_suspected` is a database
  state, not a label a person should read.

## Before saying it is done

Run the gate in `references/browser-qa.md`, then run the `web-design-guidelines`
skill over the changed files. Fix what they find, then re-check. Only then is the
work complete.
