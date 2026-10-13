# Hermes hook: tell Hermes when a pipeline run ends

Handoff from TeHerme (Hermes agent, `C:/Users/Giorgi Teliashvili/Desktop/Hermes`) to the scraplify
implementer. Owner request, 2026-10-13. Read `CLAUDE.md`, `docs/STATUS.md` and `docs/RUNBOOK.md` first;
every rule there applies (branch + PR, STATUS in the same commit, owner approval before anything on the host).

**Built 2026-10-13.** The request and the event are as written here; the host's internals (no path unit,
the directory names, which crawl run an event describes) differ. See "As built" at the end, which wins
where the two disagree.

**Do this in a separate worktree off `main`** (`git worktree add ../scraplify-hermes-hook -b hermes-hook main`),
not in the main checkout: the 11B first pass runs from that checkout's `dist/` on `phase-11c-real-estate-tab`
(`.git/session-handoff`), and switching its branch or rebuilding it would break the running loop.

Secrets (Cloudflare service token, HMAC secret) never go through a chat or an agent: the owner enters them
with `deploy/set-hermes-hook.sh` (hidden input) on the host. Don't ask for them.

## Why

Hermes (Telo's agent and Telegram bot, running on the owner's Windows PC) reads jobster.fun read-only and
will screen every new vacancy against the owner's CV, then send close matches to Telegram. It needs to
know **when a pipeline run has finished, and how it went**, without polling the host and without
assuming the crawl schedule. If the crawl cadence changes later (hourly, ss.ge nightly, on demand), Hermes
must not need any change.

This is a notification only. It carries no listing content, opens no inbound port on the host, and grants
nothing new in Postgres.

## Shape: outbox on the host, sender with retries

```
xtelo-pipeline@<src>.service ──writes──▶ /var/lib/xtelo/hermes-outbox/<event_id>.json
                                              │ (path unit fires on a new file; retry timer while not empty)
xtelo-hermes-notify.service ──POST, signed──▶ https://<hook host>/webhooks/xtelo-pipeline
                                              (Cloudflare Tunnel + Access ▶ Hermes on the PC)
```

1. **The pipeline writes, never sends.** At the end of `deploy/run-pipeline.sh` (and from a `trap` on
   `TERM`/`INT`, so a killed or timed-out run still reports `interrupted`), a new CLI
   `dist/cli/hermes-event.js <source> <exit codes...>` builds the event (below) and writes it atomically
   (temp file + rename) into the outbox. It never fails the pipeline: any error in it is logged and the
   pipeline's own exit code is returned unchanged. When `HERMES_HOOK_ENABLED` is not `1` in `worker.env`
   it does nothing at all, so the release can be deployed dormant.
2. **A separate sender unit delivers.** `xtelo-hermes-notify.service` (oneshot), triggered by a
   `xtelo-hermes-notify.path` unit (`DirectoryNotEmpty=/var/lib/xtelo/hermes-outbox`) and by a
   `xtelo-hermes-notify.timer` every 15 min **only to retry** what is still in the outbox. It posts
   each file oldest first:
   - 2xx (including Hermes' `{"status":"duplicate"}`) → delete the file.
   - 408, 429, 5xx, timeout, DNS/TLS/connection error → keep it and try again next time. The owner's PC
     may be off for hours; that is normal, not an error.
   - Any other 4xx → move it to `hermes-outbox/dead/` and log loudly (bad signature or config).
   - Older than 72 h → move to `dead/` (Hermes catches up from the database on its own).
   - Re-sign on every attempt: the signature binds a timestamp and Hermes refuses one older than 5 min.
3. **Least privilege.** The sender holds the hook secrets and **no database credential**; the pipeline
   holds the database credential and **no hook secret**. Sender env file: `/etc/xtelo/hermes-hook.env`
   (`0600 root`, read by systemd before dropping to user `xtelo`), never `worker.env`. Same hardening as
   the other units (`ProtectSystem=strict`, `ReadWritePaths=/var/lib/xtelo/hermes-outbox`,
   `InaccessiblePaths=-/var/backups/xtelo`, no access to the other env files). The outbox directory:
   `install -d -o xtelo -g xtelo -m 0700 /var/lib/xtelo/hermes-outbox /var/lib/xtelo/hermes-outbox/dead`
   (add to `deploy/host-setup.sh` and RUNBOOK §2 step 0).

## The request (Hermes' generic webhook contract, HMAC V2)

```
POST {HERMES_HOOK_URL}                      e.g. https://hooks.jobster.fun/webhooks/xtelo-pipeline
Content-Type: application/json
X-Request-ID: {event_id}                    Hermes drops repeats of the same id
X-Webhook-Timestamp: {unix seconds, now}
X-Webhook-Signature-V2: {hex HMAC-SHA256(HERMES_HOOK_SECRET, "{timestamp}." + raw body bytes)}
CF-Access-Client-Id: {CF_ACCESS_CLIENT_ID}          Cloudflare Access service token
CF-Access-Client-Secret: {CF_ACCESS_CLIENT_SECRET}
```

Sign the exact bytes you send. Timeout 20 s. Never log a header value or the secret; log the event id,
the HTTP status and the attempt count only.

`/etc/xtelo/hermes-hook.env` holds `HERMES_HOOK_URL`, `HERMES_HOOK_SECRET`, `CF_ACCESS_CLIENT_ID`,
`CF_ACCESS_CLIENT_SECRET`. Add `deploy/set-hermes-hook.sh` in the style of `set-r2-credentials.sh`:
URL as an argument, the three secrets from hidden input, validated, written `0600`, then one test post of a
`xtelo.test` event. Add `deploy/env/hermes-hook.env.template` with placeholders only.

## The event (schema 1)

```json
{
  "event_type": "xtelo.pipeline.finished",
  "schema": 1,
  "event_id": "jobs-ge:<crawl_runs.id>",
  "domain": "opportunities",
  "source": "jobs-ge",
  "status": "succeeded",
  "exit_code": 0,
  "steps": {"crawl": 0, "dedupe": 0, "taxonomy": 0, "bundle": 0, "retention": 0},
  "crawl_run": {"id": "…", "status": "completed", "started_at": "ISO-8601 UTC", "finished_at": "ISO-8601 UTC"},
  "counts": {"discovered": 9021, "new": 318, "changed": 41, "unchanged": 8650, "missing": 7,
             "expired": 12, "reopened": 1, "quarantined": 0, "failed": 0},
  "full_coverage": true,
  "bundle": {"id": "…", "opportunities": 8669},
  "release": "<git sha of /opt/xtelo/current>",
  "host": "<hostname>",
  "emitted_at": "ISO-8601 UTC"
}
```

- `status`: `succeeded` (exit 0), `failed` (non-zero), `interrupted` (trap fired before the end), plus
  `partial` when the crawl run itself ended `partial`. A skipped step's code is `null`.
- `counts`: copied from the run's `crawl_runs` row (`discovered_count`, `new_count`, `changed_count`,
  `unchanged_count`, `missing_count`, `expired_count`, `reopened_count`, `quarantined_count`,
  `failed_count`, without the `_count` suffix) and `full_coverage`. **No migration for this.**
  Hermes reads the details itself from `public_opportunity_members` using the run's time window.
- `bundle`: only when the bundle step ran and activated a build; otherwise omit it.
- `event_id`: the crawl run's id when one exists; when the crawl never created a run (it failed before),
  `"<source>:nocrawl:<emitted_at>"`.
- Nothing from a listing (titles, employers, descriptions, URLs) goes in the event.
- **Real estate (11E):** when the ss.ge crawl joins the pipeline, emit the same event with
  `"domain": "realestate"` and `"source": "ss-ge"`. That is the only change Hermes needs.
- Optional, same sender: `xtelo.backup.finished` from the backup unit (`status`, `exit_code`).

## Tests and exit gate

- [ ] Signer: a fixed secret/timestamp/body gives a known hex digest (test vector computed with Node's
      `crypto`, and the same vector checked against Python `hmac` in the PR description).
- [ ] Event builder (DB test): succeeded, failed, partial, interrupted and no-crawl-run cases; no
      listing text in the output; dormant when `HERMES_HOOK_ENABLED` is unset.
- [ ] Sender against a local mock server: 2xx and `duplicate` delete; 5xx, 429 and a timeout keep and
      retry with a fresh timestamp; 401/403 go to `dead/`; a file older than 72 h goes to `dead/`;
      no secret or header value appears in the output.
- [ ] `run-pipeline.sh` returns the same exit code as before whether the hook is unset, set, or the
      outbox is unwritable.
- [ ] Units pass `systemd-analyze verify`.
- [ ] Full suite, typecheck, lint; CI green; RUNBOOK (§1 shape table, §2 steps, §3 deploy note,
      §8 secrets rotation) and STATUS updated.
- [ ] Deployed **dormant** (plain deploy, no migration, no grants): units installed and enabled,
      `HERMES_HOOK_ENABLED` unset. The owner turns it on once Hermes' side is live.

## What Hermes sets up on its side (not this repo)

The Cloudflare Tunnel from the PC, the `hooks.jobster.fun` hostname (proxied; it is a separate subdomain,
so the grey-cloud rule for `jobster.fun` and `admin.jobster.fun` is untouched), the Access application with
a service token, and the `xtelo-pipeline` webhook route with its HMAC secret. The owner then runs
`set-hermes-hook.sh` on the host with those values, and sets `HERMES_HOOK_ENABLED=1` in `worker.env`.

## Report back to Hermes

1. Merged PR link and deployed release sha.
2. Final event JSON as built from a real run (or the mock), and any field that differs from schema 1.
3. Unit names, outbox path, env file names and keys as built.
4. How to fire a test event by hand on the host (exact command).
5. Anything this brief got wrong about the pipeline, the units or `crawl_runs`.

---

## As built (2026-10-13, branch `hermes-hook`)

Written by the scraplify implementer for Hermes. The contract above (the request, the headers, the
signature) is built as written and was checked against Hermes' own receiver
(`gateway/platforms/webhook.py`). The host's internals differ from the brief in the places below.

### What differs from the brief, and why

1. **No path unit.** `DirectoryNotEmpty` re-triggers the sender for as long as the directory is not
   empty, and it would not be empty whenever the PC is off (or ever, with `dead/` inside it), so the
   sender would loop until systemd's start limit. Instead `xtelo-pipeline@.service` starts the sender
   through `OnSuccess=` and `OnFailure=`, and `xtelo-hermes-notify.timer` retries every 15 minutes.
   The sender's own `ConditionDirectoryNotEmpty` skips a run when nothing is waiting.
2. **Paths.** Outbox `/var/lib/xtelo/hermes/outbox`, dead events `/var/lib/xtelo/hermes/dead`
   (beside the outbox, under one writable parent: two separately writable directories are two mounts
   inside the unit, and the rename of a refused event failed across them in rehearsal).
3. **Which crawl run an event describes.** The script records its start time and the event takes the
   source's crawl run started since then. Taking "the latest run" would, when a crawl ends without
   creating a run, repeat the previous run's `event_id`, and Hermes would drop the failure as a
   duplicate. Such a run gets `"<source>:nocrawl:<emitted_at>"`.
4. **Redirects are not followed.** Cloudflare Access answers a wrong or expired service token with a
   302 to its sign-in page; followed, that ends in a 200 and the event would be deleted as delivered.
   Any 3xx is treated like a refusal: the event goes to the dead directory and the unit fails.
5. **`counts.skipped`** is added (schema still 1, an extra key): since Phase 7C most listings of a
   run are "listed, unchanged, not fetched again", so without it the counts do not add up to
   `discovered`. Example of a real nightly shape: `discovered 9021, unchanged 12, skipped 8650`.
6. **`status: "partial"`** means the crawl ended partial and no other step failed. If dedupe,
   taxonomy, the bundle or retention failed as well, the status is `failed`. The crawl CLI exits 1
   for a partial run, so `exit_code` is 1 in both cases.
7. **`steps`:** a step that did not run is `null`, including the steps an interrupted run never
   reached (an interrupt during the crawl gives five nulls and `exit_code` 143).
8. **`bundle`** is the bundle live on the public channel, when this run's bundle step exited 0 and
   that bundle went live after the run started. Three pipelines run at the same hour, so it can be
   the build another source's run published a moment later; it is always the live one.
9. **`crawl_run`, `counts` and `full_coverage` are `null`** when the run created no crawl run, or
   the database could not be read at the end (the event still goes out).
10. **No attempt count in the log.** A line names the event id, the HTTP status (or the failure
    kind, such as `ECONNREFUSED`) and the event's age in minutes. No state is kept between tries.
11. **The Access headers are optional to the sender** (both or neither), so a route that is not
    behind Access also works. `HERMES_HOOK_URL` must be `https`.
12. **Not built:** the optional `xtelo.backup.finished` event.
13. **A hard kill** (SIGKILL, out of memory, power loss) writes no event. Treat silence as unknown.
14. **The sender runs as its own user, `xtelo-hermes`,** not as `xtelo`. With one shared user the
    crawl pipeline, which reads pages from the open web, could read the hook's secrets out of the
    sender's process through `/proc` (shown in rehearsal). The outbox is `xtelo:xtelo-hermes` mode
    `2770`: the pipeline writes it and the sender reads and empties it through the group.
15. **The sender signs only an exact event.** Each outbox file is checked against
    `src/hermes/schema.ts` first: known keys only, and every value an id, a code, a bounded count,
    a time exactly as `toISOString` writes it, the host's own name, or one of a fixed set of words. Anything else is moved to the dead directory unsigned, and the
    body sent is the checked event written out again. So a signed request from this host cannot
    carry a sentence, whatever ends up in the outbox. The cost: a new field, counter, source or
    event type has to be added to that file in the same change, or its events are refused.

### For Phase 11E (real estate)

"The only change Hermes needs" is `domain` and `source`, but the counters will not be the same
keys: `realestate.crawl_runs` has `page_count`, `row_count`, `new_count`, `changed_count`,
`bumped_count`, `unchanged_count`, `reopened_count`, `gone_count`, `verified_count`, and no
`discovered`, `missing`, `expired` or `quarantined`. Expect a `counts` object with those names under
`"domain": "realestate"`, and no `full_coverage`. Until 11E adds that shape to
`src/hermes/schema.ts`, the sender refuses a real-estate event.

### One thing on Hermes' side

The receiver records an `X-Request-ID` as seen before it runs the delivery. When a deliver-only
route's delivery then fails, it answers 502; the host keeps the event and retries, and the retry is
answered `{"status":"duplicate"}` with a 200, so the host deletes it. An event whose first delivery
failed inside Hermes is therefore lost without either side noticing. If that matters, the route
should not record the id until the delivery has succeeded.

### Report

1. PR and release: <https://github.com/Knight-Panther/scraplify/pull/51>, merged as `6a186b4` and
   live on the host since 17:25 UTC on 2026-10-13, dormant: the units and the retry timer are
   installed, `HERMES_HOOK_ENABLED` is unset and `/etc/xtelo/hermes-hook.env` does not exist. The
   host's name, which every event carries as `host`, is whatever `hostname` prints there.
2. An event as built, from a rehearsal run under systemd (stand-in crawl, real event and sender code,
   a mock receiver that checks the signature and the five-minute window):

   ```json
   {"event_type":"xtelo.pipeline.finished","schema":1,"event_id":"jobs-ge:fa9a4352-5e69-4a89-a21a-dd391f862d42","domain":"opportunities","source":"jobs-ge","status":"succeeded","exit_code":0,"steps":{"crawl":0,"dedupe":0,"taxonomy":0,"bundle":0,"retention":0},"crawl_run":{"id":"fa9a4352-5e69-4a89-a21a-dd391f862d42","status":"completed","started_at":"2026-10-13T13:57:07.059Z","finished_at":"2026-10-13T13:57:07.073Z"},"counts":{"discovered":9021,"new":318,"changed":41,"unchanged":12,"skipped":8650,"missing":7,"expired":12,"reopened":1,"quarantined":0,"failed":0},"full_coverage":true,"release":"abababababababababababababababababababab","host":"e751c9c41a5a","emitted_at":"2026-10-13T13:57:09.279Z"}
   ```

   The test event: `{"event_type":"xtelo.test","schema":1,"event_id":"test:<emitted_at>","release":"…","host":"…","emitted_at":"…"}`.
3. Names as built:
   - Units: `xtelo-hermes-notify.service` (user `xtelo-hermes`), `xtelo-hermes-notify.timer`
     (every 15 minutes), and `OnSuccess=`/`OnFailure=` on `xtelo-pipeline@.service`.
   - Outbox `/var/lib/xtelo/hermes/outbox`; dead events `/var/lib/xtelo/hermes/dead`.
   - `/etc/xtelo/hermes-hook.env`: `HERMES_HOOK_URL`, `HERMES_HOOK_SECRET`, `CF_ACCESS_CLIENT_ID`,
     `CF_ACCESS_CLIENT_SECRET`. `/etc/xtelo/worker.env`: `HERMES_HOOK_ENABLED=1`.
   - `deploy/set-hermes-hook.sh` accepts an HMAC secret of 16 or more characters from
     `A-Z a-z 0-9 . _ ~ + / = -`, a client id of 32 hex characters plus `.access`, and a client
     secret of 64 hex characters.
4. A test event by hand on the host:
   `sudo /opt/xtelo/current/deploy/with-env.sh worker node dist/cli/hermes-event.js --test && sudo systemctl start xtelo-hermes-notify && journalctl -u xtelo-hermes-notify -n 5 -o cat`
5. What the brief got wrong: items 1 to 4 and 14 above. `crawl_runs` has the columns it names, plus
   `skipped_count`. The units are not re-copied by a plain deploy, so "plain deploy" needs the three
   commands in RUNBOOK §3 step 7. RUNBOOK §4 and concept §30.6 said nothing pushes a notification;
   both now name this hook as the one exception.
