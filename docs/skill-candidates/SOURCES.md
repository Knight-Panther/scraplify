# Skill candidates — provenance

Vendored from external repositories on 2026-09-02, moved here from `.claude/skills/` on 2026-09-02 to comply with the "Skill adoption policy" in [`scraplify-concept.md`](../scraplify-concept.md#25-phased-implementation-plan): these are candidates for review and adaptation when their listed phase begins, not a package to enable wholesale. None of these are currently exposed to Claude or Codex — see the concept doc's per-phase adoption table before importing any of them into `.claude/skills/` or `.agents/skills/`.

Not authored in this repo — update by re-fetching from source, not by hand-editing, unless noted.

| Skill | Source repo | Path | License |
|---|---|---|---|
| `playwright-explore-website` | [github/awesome-copilot](https://github.com/github/awesome-copilot) | `skills/playwright-explore-website/SKILL.md` | MIT |
| `playwright-generate-test` | [github/awesome-copilot](https://github.com/github/awesome-copilot) | `skills/playwright-generate-test/SKILL.md` | MIT |
| `webapp-testing` | [github/awesome-copilot](https://github.com/github/awesome-copilot) | `skills/webapp-testing/` (incl. `assets/test-helper.js`) | MIT |
| `postgresql-code-review` | [github/awesome-copilot](https://github.com/github/awesome-copilot) | `skills/postgresql-code-review/SKILL.md` | MIT |
| `postgresql-optimization` | [github/awesome-copilot](https://github.com/github/awesome-copilot) | `skills/postgresql-optimization/SKILL.md` | MIT |

## Considered, not installed

- `security-review` (awesome-copilot) — redundant with Claude Code's built-in `security-review` skill; installing a second one under the same intent risks ambiguity about which fires, and this repo's binding review gate is Codex (`codex review --uncommitted` on commit) regardless.
- `webapp-testing` (anthropics/skills) — functionally equivalent to the awesome-copilot version above but Python/`playwright`-native (bundled `scripts/with_server.py`, examples in Python). Skipped to avoid a second language toolchain for browser testing when the project stack is Node/TypeScript and Playwright MCP is already available directly.
