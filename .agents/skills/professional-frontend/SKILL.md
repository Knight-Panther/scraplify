---
name: professional-frontend
description: Xtelo's frontend review rules — Georgian-script typography, data-density patterns, fabricated-data checks, and the browser QA gate. Use when reviewing any UI code in this repo.
---

# Xtelo frontend (review side)

Codex is the reviewer in this repo, not the implementer (see `AGENTS.md`). This
skill is the frontend counterpart of that role.

**The rules themselves live in one place** and are deliberately not duplicated
here, so the two agents cannot drift apart:

- `.claude/skills/professional-frontend/references/product-context.md` — what the
  product is, who uses it, the measured shape of the corpus
- `.claude/skills/professional-frontend/references/design-direction.md` — the
  settled palette, contrast floors and typeface split. The visual direction is
  decided; a review finding that proposes a different one is out of scope
- `.claude/skills/professional-frontend/references/georgian-typography.md`
- `.claude/skills/professional-frontend/references/data-density.md`
- `.claude/skills/professional-frontend/references/anti-patterns.md`
- `.claude/skills/professional-frontend/references/browser-qa.md`

Read the relevant ones before reviewing UI code.

## What to weight most heavily in review

1. **Fabricated data.** The highest-severity frontend defect in this codebase.
   Any invented listing, employer, logo, metric, score or status shown to the user
   is a correctness bug, not a cosmetic one — Xtelo's whole value is that its data
   is real and traceable. Flag it at P1.

2. **Lost provenance.** A canonical opportunity with no route back to its source
   listings; both sources' descriptions merged into one block; a duplicate
   suggestion shown without the evidence behind it. These defeat the purpose of
   the dedupe layer.

3. **Georgian script handling.** A font stack without Georgian coverage,
   `text-transform: uppercase` reaching Georgian text, or JavaScript string
   truncation by index. 388 of 410 titles are Georgian and 22 mix scripts, so
   these are certain to bite, not hypothetical.

4. **Raw internals leaking to the user.** Enum values (`missing_suspected`,
   `confirmed_same`), UUIDs, or codebase jargon rendered as interface copy.

5. **Claimed completion without browser verification.** A change described as
   done with no evidence it was rendered and inspected has not met the gate in
   `browser-qa.md`. A green build is not the gate.

## Accessibility and interface quality

Claude reviews against Vercel's Web Interface Guidelines through a global skill
that fetches them at review time. **You cannot load that skill** — skill
discovery is separate for each agent — so a condensed, static snapshot lives
beside this file: `web-interface-checklist.md`.

Read it for the ordinary interface rules. It also records the three places where
those guidelines **conflict** with Xtelo's own rules (case transforms,
virtualization, and confirmation dialogs for reversible actions); Xtelo's rules
win there, so flagging code for following them is a false positive.
