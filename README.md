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

## Database

Start local PostgreSQL:

```powershell
docker compose up -d postgres
```

Create a `.env` file (gitignored) with:

```
DATABASE_URL=postgresql://scraplify:scraplify_dev@localhost:5432/scraplify
```

Then generate and apply migrations:

```powershell
npm run db:generate
npm run db:migrate
```

`docker-compose.yml`'s credentials are local-dev-only defaults, not secrets — the container is only ever exposed on `localhost`.

## Running the jobs.ge crawl

Build once, then run a single crawl:

```powershell
npm run build
npm run crawl:jobs-ge
```

This runs one full jobs.ge crawl against the live site (discovery, detail fetch, DB writes, reconciliation) and exits — it does not loop or schedule itself. A full run refetches every discovered listing's detail page (~5,647 at last count) at the site's declared 5s crawl delay, so it takes roughly 8-9 hours end to end — this is a complete-corpus reconciliation, not a quick poll. Requires `.env` (above) and the database migrated. Optional environment variables:

- `SCRAPLIFY_USER_AGENT` — overrides the default `User-Agent` sent to source sites (`src/net/user-agent.ts`).
- `LOG_LEVEL` — pino level, default `info`.

### Scheduling recurring runs (Windows Task Scheduler)

Per `docs/scraplify-concept.md` §19.1, local runs are driven by Windows Task Scheduler rather than an in-process scheduler. To register a recurring job (every 24 hours by default, matching the ~8-9 hour runtime above):

```powershell
npm run build
./scripts/register-jobs-ge-schedule.ps1
# or: ./scripts/register-jobs-ge-schedule.ps1 -IntervalMinutes 720   # every 12h, still >= the measured runtime
```

This is a deliberate, separate step from building the CLI — registering it starts real, unsupervised, recurring requests against the live jobs.ge site. The script checks `dist/` and `.env` exist first and refuses to register otherwise. It wraps each run in `scripts/run-jobs-ge-crawl.ps1`, which appends output to `logs/jobs-ge-crawl-<date>.log` (gitignored) and preserves the crawl's real exit code so Task Scheduler reports failures accurately. Remove the task with `Unregister-ScheduledTask -TaskName 'Scraplify - jobs.ge crawl' -Confirm:$false`.
