# Skill provenance

Vendored from external repositories on 2026-09-02. Not authored in this repo — update by re-fetching from source, not by hand-editing, unless noted.

| Skill | Source repo | Path | License |
|---|---|---|---|
| `playwright-explore-website` | [github/awesome-copilot](https://github.com/github/awesome-copilot) | `skills/playwright-explore-website/SKILL.md` | MIT |
| `playwright-generate-test` | [github/awesome-copilot](https://github.com/github/awesome-copilot) | `skills/playwright-generate-test/SKILL.md` | MIT |
| `webapp-testing` | [github/awesome-copilot](https://github.com/github/awesome-copilot) | `skills/webapp-testing/` (incl. `assets/test-helper.js`) | MIT |
| `postgresql-code-review` | [github/awesome-copilot](https://github.com/github/awesome-copilot) | `skills/postgresql-code-review/SKILL.md` | MIT |
| `postgresql-optimization` | [github/awesome-copilot](https://github.com/github/awesome-copilot) | `skills/postgresql-optimization/SKILL.md` | MIT |
| `context7-mcp` | [upstash/context7](https://github.com/upstash/context7) | `skills/context7-mcp/SKILL.md` | MIT |

## Considered, not installed

- `security-review` (awesome-copilot) — redundant with Claude Code's built-in `security-review` skill; installing a second one under the same intent risks ambiguity about which fires, and this repo's binding review gate is Codex (`codex review --uncommitted` on commit) regardless.
- `webapp-testing` (anthropics/skills) — functionally equivalent to the awesome-copilot version above but Python/`playwright`-native (bundled `scripts/with_server.py`, examples in Python). Skipped to avoid a second language toolchain for browser testing when the project stack is Node/TypeScript and Playwright MCP is already available directly.
