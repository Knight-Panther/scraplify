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
