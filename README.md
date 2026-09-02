# scraplify

Project scaffolding is in progress. Product and development documentation will be added when the implementation stack is selected.

## Local setup

Requirements:

- Git
- OpenAI Codex CLI, authenticated and available on `PATH`
- PowerShell 5.1 or later

Enable the repository's version-controlled Git hooks once after cloning:

```powershell
./scripts/setup-git-hooks.ps1
```

The pre-commit hook runs `codex review --uncommitted` and blocks commits on P0/P1 findings or review failures. Because Codex has no staged-only review target, the review includes staged, unstaged, and untracked changes.

Set up the Context7 MCP server (used for up-to-date library documentation; project-scoped, not committed since it holds a live key in `.mcp.json`):

```powershell
npx ctx7 setup --claude --mcp -p -y
```

This opens a one-time device-code OAuth approval in your browser, then writes `.mcp.json` (gitignored) and registers the `context7-mcp` skill. Re-run it on any fresh clone or if `.mcp.json` is ever deleted.
