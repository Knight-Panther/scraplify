# scraplify

Xtelo's TypeScript ingestion service for jobs.ge and hr.ge. See [the concept](docs/scraplify-concept.md) for product scope and [status](docs/STATUS.md) for implementation progress.

## Local setup

Requirements:

- Git
- OpenAI Codex CLI, authenticated and available on `PATH`
- PowerShell 5.1 or later
- Node.js 24 and npm (the Node major is pinned in `.node-version`)
- Docker Desktop running for local PostgreSQL

Install the locked dependencies with `npm ci`. TypeScript files use LF on every platform; `.gitattributes` pins this to match Biome and Linux CI.

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

Copy `.env.example` to `.env` once on a fresh clone. The example contains only the local Docker Compose development defaults:

```
DATABASE_URL=postgresql://scraplify:scraplify_dev@localhost:5432/scraplify
```

Then apply the committed migrations:

```powershell
npm run db:migrate
```

`docker-compose.yml`'s credentials are local-dev-only defaults, not secrets — the container is only ever exposed on `localhost`.

Tests, migrations, and crawl commands load `.env` if present. An existing process-level `DATABASE_URL` takes precedence, including in CI. Generate a new migration with `npm run db:generate` only after intentionally changing the schema; inspect its SQL before applying it. Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm run build` before committing.

## Running the hr.ge crawl

After `npm run build`, select a full reconciliation or bounded incremental poll:

```powershell
npm run crawl:hr-ge
npm run crawl:hr-ge -- --mode=incremental --pages=2
```

Both commands make live requests. Incremental mode walks at most the requested number of index pages (default 2, maximum 200), refreshes details in that window, skips the sitemap, and never advances missing-listing streaks or changes the full-crawl cursor. It does not yet skip unchanged detail pages within that window. Full mode validates coverage against source counts and history before reconciliation; sitemap-only candidates count toward coverage only after their details parse successfully.

Both adapters stop further requests on rate limits or explicit blocks. `Retry-After` and exhausted `RateLimit-*` windows are persisted in `crawl_cursors.next_fetch_at`; a new invocation during that cooldown records a partial run without making source requests. A valid 200 that exhausts the allowance is still parsed. Full crawls resume at the rejected or next unattempted detail, and clear that cursor only after a healthy sweep. An interrupted run exits nonzero so an external scheduler can report it.

HTTP responses support bounded gzip, Brotli, deflate, and zstd decoding. Both downloaded and expanded data are limited to 10 MB. No automatic browser fallback or challenge solving is enabled.

## Development dependency security

The scoped `@esbuild-kit/core-utils` override uses esbuild 0.25.12, matching the patched version already used by Drizzle Kit. This removes its older esbuild dependency affected by [GHSA-67mh-4wv8-2f99](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99). Recheck the override when upgrading Drizzle; validate schema generation, migrations, and tests rather than using an automatic major downgrade.

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
