# scraplify

The code behind Xtelo, live at [jobster.fun](https://jobster.fun): one catalogue of the vacancies on jobs.ge and hr.ge, deduplicated across both boards, with CV matching that runs entirely in the visitor's browser (the CV never leaves the device).

This repository holds all of it, in TypeScript: the crawlers, normalization and dedupe, the Next.js web app with its three surfaces (`local` for the operator, `public`, `admin`), the matching bundle, and the deployment scripts. See [the concept](docs/scraplify-concept.md) for product scope, [status](docs/STATUS.md) for what is done, and [the runbook](docs/RUNBOOK.md) for production.

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

`npm run dev` starts Postgres if needed, applies migrations and serves the web app at http://127.0.0.1:3000, read-only against the `scraplify` database.

`docker-compose.yml`'s credentials are local-dev-only defaults, not secrets — the container is only ever exposed on `localhost`.

Tests, migrations, and crawl commands load `.env` if present. An existing process-level `DATABASE_URL` takes precedence, including in CI. Generate a new migration with `npm run db:generate` only after intentionally changing the schema; inspect its SQL before applying it. Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm run build` before committing.

## Running the hr.ge crawl

After `npm run build`, select a full reconciliation or bounded incremental poll:

```powershell
npm run crawl:hr-ge
npm run crawl:hr-ge -- --mode=incremental --pages=2
```

By default (`--refetch=changed`) a crawl skips the detail page of any listing whose list-page fingerprint has not changed, and re-fetches a small sample as a check. Pass `--refetch=all` to fetch every detail page, for example after a parser change. The same flag works for jobs.ge.

Both commands make live requests. Incremental mode walks at most the requested number of index pages (default 2, maximum 200), refreshes details in that window, skips the sitemap, and never advances missing-listing streaks or changes the full-crawl cursor. Full mode validates coverage against source counts and history before reconciliation; sitemap-only candidates count toward coverage only after their details parse successfully.

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

This runs one full jobs.ge crawl against the live site (discovery, detail fetch, DB writes, reconciliation) and exits — it does not loop or schedule itself. The first run on an empty database fetches every discovered listing's detail page (~5,750 at last count) at the policy's 2s spacing, so it takes hours. Later runs skip unchanged listings (see `--refetch` above) and take minutes. `--refetch=all` brings back the hours-long full fetch. Requires `.env` (above) and the database migrated. Optional environment variables:

- `SCRAPLIFY_USER_AGENT` — overrides the default `User-Agent` sent to source sites (`src/net/user-agent.ts`).
- `LOG_LEVEL` — pino level, default `info`.

### Scheduling recurring runs (Windows Task Scheduler)

Per `docs/scraplify-concept.md` §19.1, local runs are driven by Windows Task Scheduler rather than an in-process scheduler. Register one recurring job per source (every 24 hours by default for both; a first jobs.ge run takes hours, and `-IntervalMinutes` must stay above the measured runtime):

```powershell
npm run build
./scripts/register-crawl-schedule.ps1 -Source jobs-ge
./scripts/register-crawl-schedule.ps1 -Source hr-ge
# or: ./scripts/register-crawl-schedule.ps1 -Source hr-ge -IntervalMinutes 720   # every 12h
```

This is a deliberate, separate step from building the CLI — registering starts real, unsupervised, recurring requests against the live site. The script checks `dist/` and `.env` exist first and refuses to register otherwise. Each run goes through `scripts/run-crawl.ps1`, which runs the crawl and then **always** a `run-dedupe --auto-link` pass (so newly crawled listings become browsable opportunities without a manual step), a taxonomy backfill, a matching-bundle build and a retention pass (`--apply`; the last two only when their earlier steps succeeded), appends both outputs as UTF-8 to `logs/<source>-crawl-<date>.log` (gitignored), and exits non-zero if either step failed so Task Scheduler reports it. Dedupe passes from the two schedules never overlap: they are serialized by a Postgres advisory lock (`src/dedupe/dedupe-lock.ts`). Remove a task with `Unregister-ScheduledTask -TaskName 'Scraplify - jobs-ge crawl' -Confirm:$false` (or `hr-ge`).

### Health checks and held-back closures

```powershell
npm run health:check   # prints each source's alerts; exits 1 on any critical one
```

The same alerts appear on `/health` and in `npm run browse health`: a source not crawled in 48h, a failed or degraded last run, no full-coverage crawl in 7 days, unresolved parser incidents, and active listings that have gone more than 12h without reaching browse (dedupe not running).

A crawl records a parser incident when a finished full walk fails a whole-run guard (count collapse, quarantine or fetch-failure rate) or its count more than doubles. Reconciliation also refuses to close more than max(25, 10%) of a source's open listings in one pass: it records a critical `mass_closure_suspected` incident and leaves them `missing_suspected`. Once you have checked those listings really are gone, run that source's crawl once with the override, for example `npm run crawl:hr-ge -- --allow-mass-closure`, then mark the incident resolved.

## License

The original code and documentation in this repository are under the [MIT License](LICENSE). The licence does not cover material that belongs to others, which keeps its own terms:

- The saved pages and vacancy texts in the test fixtures (`src/adapters/*/fixtures/`, `src/matching/eval/fixtures/`) belong to jobs.ge, hr.ge and the employers who posted them. They are here only to test the parsers and the matching.
- The static similarity model in `matching-models/` is MIT under its author's copyright (provenance in `src/matching/models/static-e1.ts`).
- The site's video and images come from free sources under their own terms (`docs/RIGHTS.md`).
- The names Xtelo and jobster are not licensed.
