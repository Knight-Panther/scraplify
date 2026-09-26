# scraplify — threat model and approval boundaries

Status: initial version, Phase 0. Written per the "threat model and approval boundaries" item in [`scraplify-concept.md`](./scraplify-concept.md) §25's Phase 0 exit gate. Consolidates and makes concrete what §18 (agent and approval boundaries), §23 (security, privacy, retention), and §16 (attachments) already establish as principles — this document is where those principles meet actual code, and gets updated as new threats are found or new phases add new capabilities.

## 1. Trust boundaries

Everything that originates from a source site is untrusted input, without exception:

- HTML, JSON, redirects, sitemaps.
- URLs found in that content — including their scheme, host, path, and query string.
- Filenames, MIME types, and byte content of any linked resource.
- Text content itself (titles, descriptions) — once an LLM reads scraped text (taxonomy classification, later CV matching), that text is a prompt-injection surface, not just display data.

Trust follows the value's origin, not its storage form or how many transformation steps it's been through. Normalizing a title (case-folding, whitespace trimming, slug generation) doesn't remove attacker control over its content — it only reformats it. So `SourceListingRevision.titleNormalized`, `Opportunity.canonicalTitle`, and any other field that traces back to source text remain untrusted for rendering and LLM-input purposes indefinitely, all the way through canonicalization and storage. The only values exempt from this are ones scraplify *synthesizes* itself and that carry no source-derived content at all: generated UUIDs, computed hashes, timestamps. Taxonomy classifications and CV-matching confidence scores are **not** exempt, even though scraplify computes them and controls their shape (an enum, a float): their *value* is a function of untrusted source text, so a manipulated listing description can manipulate the resulting classification or score just as it could manipulate rendered HTML. Treat model output as structurally safe (it's a constrained enum/number, not free text, so it can't itself carry a script tag) but not semantically trusted (its meaning can still be adversarially influenced) — don't let downstream ranking or automation treat it as ground truth. When in doubt about whether a stored value counts as untrusted, the test is "does this value's content depend on anything the source site chose to put there" — if yes, including through a model in the middle, it's still untrusted.

## 2. Threats in scope, and what actually mitigates them today

| Threat | Mitigation in place | Where |
|---|---|---|
| Fetching an unintended path on a source (scope creep beyond public listings) | Default-deny `allowedPathPatterns`, schema-enforced non-empty (`SourcePolicySchema`) | `src/domain/source.ts` |
| Path-matching bypass via ambiguous exact/prefix semantics | Explicit `PathMatchRule.match: 'exact' \| 'prefix'`, not bare strings | `src/domain/source.ts` |
| A prefix rule accidentally authorizing an excluded sibling path (e.g. `/announcement/favorites` under `/announcement/`) | Disallow always wins over allow (`isPathAllowed`); exceptions carved out explicitly per source policy | `src/policies/hr-ge.ts` |
| Percent-encoding bypass (`%66avorites` -> `favorites`) | Decode before matching, not after | `src/domain/source.ts` |
| Double-encoding bypass (`%2566` -> `%66` -> `f`) | Bounded decode loop (`MAX_DECODE_ROUNDS`), not a single pass | `src/domain/source.ts` |
| Decoding producing a dot-segment that didn't exist pre-decode (`%252e%252e` -> `..`) | Post-decode dot-segment check, independent of URL-parsing's own (single-layer) normalization | `src/domain/source.ts` |
| Malformed/undecodable input crashing or defaulting to allow | `decodePathSafely` returns `null` (fail-closed) on `URIError`, never throws past the caller | `src/domain/source.ts` |
| Non-http(s) URL schemes reaching fetch/browser code (`file:`, `javascript:`, `data:`) | `HttpUrl` restricts protocol only (not hostname shape, so `localhost`/IP/IDN hosts stay valid) | `src/domain/ids.ts` |
| A source-relative link masquerading as absolute, or vice versa | `originalUrl` preserved exactly as found (may be relative); `canonicalUrl`/`finalUrl` always resolved and http(s)-only | `src/domain/resource.ts` |
| Silent scope expansion into attachments/external pages before it's actually needed | `linkedResources` policy dimension defaults to fully disabled (empty allow-lists, zero depth/count, no external fetching, no retention) per source | `src/domain/source.ts`, both policy records |
| A single missed poll or partial/anomalous run mass-closing listings | `SourceListingStatus`/`CrawlRunStatus` include `quarantined`; closure logic (Phase 1A+) must never advance on a partial/failed/quarantined run | `src/domain/source-listing.ts`, `src/domain/run.ts` |
| SSRF via an absolute localhost/private-IP/link-local URL supplied or redirected to by a source page, on an *ordinary* index/detail fetch (not just attachments) | **Not yet mitigated.** `HttpUrl` only restricts scheme; nothing today performs destination-host or post-DNS-resolution checks, and no fetch layer exists yet to enforce them. §23.1 requires SSRF checks "after every redirect and DNS resolution" for all remote-content fetching, not only attachment processing. Required before Phase 1A's adapter makes its first real HTTP request. | *(none — Phase 1A requirement)* |

The path-matching row above is not hypothetical — it's the literal history of `src/domain/source.ts` across seven review round-trips on one commit sequence (2026-09-03): each fix closed one real, demonstrated bypass, verified empirically (Node's actual `URL`/`decodeURIComponent` behavior checked directly, not assumed) before being accepted as fixed, with a regression test proving it.

## 3. Known accepted limitations (not fixed, deliberately, for now)

- **Backslash-as-separator normalization.** Some origins (chiefly IIS-style Windows servers) treat a decoded `\` as a path separator, so `%5c..%5c` could resolve to a traversal sequence at such an origin even though this module only splits on `/`. Neither jobs.ge nor hr.ge are IIS-style servers (hr.ge sits behind AWS WAF; jobs.ge is a plain Linux-hosted site), so this is accepted as a documented gap rather than fixed now — revisit if a future source is added that could plausibly normalize this way.
- **Terms of service unreviewed for both sources.** `termsUrl` is `null` in both policy records; `display.mayRepublishFullContent` defaults to `false` until that changes. Not a code gap — an explicit "we don't know yet" state, per §6.2's correctness principle.
- **Raw HTML/attachment retention periods undecided.** `retention.rawHtmlRetentionDays` is `null` in both records (§27 open decision).
- **hr.ge's public sitemap lives on a different host** (`api.p.hr.ge`) than the policy's `allowedPathPatterns` cover (`www.hr.ge`). Host-level authorization for that endpoint is deferred to the Phase 1B adapter, not modeled in the policy schema yet.

## 4. Explicit non-goals (§4.3) — not weaknesses to fix, boundaries to hold

- No universal AI-generated scraper; every source gets a reviewed, source-specific adapter (§8.2).
- No CAPTCHA solving or access-control circumvention, ever — a CAPTCHA/WAF challenge is a typed failure to detect and report, not an obstacle to route around (§10.2, §21.3).
- No authenticated crawling unless separately reviewed and authorized — both current sources are public/unauthenticated (`authenticationScope: 'none'`), and that's a load-bearing assumption, not an incidental default.
- No proxy rotation without a demonstrated legitimate requirement.
- No automatic execution of downloaded files, macros, scripts, or webpage-embedded instructions — this is why scraped text is listed as a prompt-injection surface in §1, not just a data-quality concern.

## 5. Approval boundaries for later phases (§18) — declarative now, load-bearing when built

Not yet implemented (no agent, no CV upload, no outreach exists yet), but recorded now so later phases build to this from the start rather than retrofitting it:

- The future agent gets **explicit tools** (`search_opportunities`, `explain_match`, `save_opportunity`, `dismiss_opportunity`, `create_message_draft`, `list_pending_approvals`, `approve_draft`, `send_approved_message`) — never unrestricted database, browser, or messaging access.
- **Drafting never implies approval.** A draft is inert until a human approves it.
- **Approval is bound to exact content** — recipients, subject/body, attachments, the listing and its revision. Any edit after approval invalidates that approval; it doesn't carry forward to the edited version.
- **Sending or form submission — either one — requires its own current, explicit approval and is separately audited from that approval.** §4.3 rules out autonomous applications as firmly as it rules out autonomous messages; a future "apply via this site's form" feature is bound by exactly the same gate as sending an email, not a lighter one. Approving and the external action itself are two distinct, both-logged events, not one, regardless of which channel the action goes through.
- Channel adapters (email, Telegram, whatever comes later) are transport only — never a system of record or a workflow engine in their own right.

## 6. Candidate privacy (§23.2) — before CV upload is ever enabled

Also declarative for now (Phase 5 territory), recorded here so it isn't an afterthought when that phase starts:

- Raw CVs and sensitive profile data encrypted at rest where supported.
- Access restricted by role and user identity — a CV belongs to the one user who uploaded it, not to anyone else able to query the database. Encryption at rest doesn't substitute for this: it protects against stolen storage media, not against another authenticated user's queries.
- Never logged — CV content must not appear in application logs, error messages, or this kind of status output.
- Full deletion path required: raw CV, derived profile, embeddings, cached assessments — all of it, not just the upload record.
- Backup retention and deletion propagation defined — a user's deletion request must eventually clear backups too, on a stated timeline, not just the live database row.
- Explicit user consent recorded for what processing is permitted.
- No sending CV content through a third-party channel unless the user knowingly initiates that specific action.

## 7. Hosted public matching and admin control plane (Phase 8) — declarative now, load-bearing when built

Also declarative for now (Phase 8 territory — `docs/scraplify-concept.md` §30, amended 2026-09-23), recorded here so later phases build to this from the start rather than retrofitting it, same pattern as §5 and §6 above. **Nothing in this section describes anything implemented yet.** Replace it with concrete mitigation-in-place rows, in §2's table style, once Phase 8 code actually exists.

New untrusted-input and attack surfaces this phase introduces, beyond §1's existing scraped-content boundary:

- **A user-selected CV is untrusted input too, and now reaches a browser rather than only a server.** Malicious PDF/DOCX (zip bombs, decompression bombs, malformed structure, encrypted files, oversized page/character counts) must fail safely inside the dedicated Web Worker (concept §30.5) with bounded time/memory, never on the main thread, and never partially — a worker that outlives cancel/timeout/navigation is itself a resource-exhaustion bug, not just a UX one.
- **XSS as CV exfiltration is a distinct threat from XSS as vandalism.** Extracted CV content must never be rendered as HTML. A strict CSP on the CV surface (no third-party script, restrictive `worker-src`, same-origin-only `connect-src`) is the control that makes a successful injection unable to exfiltrate anything even if one is found — defense in depth, not a substitute for output escaping.
- **Model/WASM/tokenizer/PDF-worker integrity.** Every asset the browser worker loads (model weights, tokenizer, ONNX runtime WASM, the self-hosted PDF.js worker) is self-hosted with pinned revisions and manifest-recorded SHA-256 hashes; remote model downloads are disabled. A compromised or mismatched artifact is a supply-chain path directly into a process handling a user's CV — checksum verification at load time is the control, not merely at build time.
- **Matching-bundle/manifest poisoning or staleness.** The manifest endpoint and the versioned artifact store (concept §30.3) are the one path by which "what the browser matches against" is decided server-side. An attacker able to publish an unverified or partially-built bundle could serve wrong matches at scale; the atomic verify-then-activate/rollback design is the control. A bundle beyond its configured maximum age must stop matching rather than silently serve stale results forever — staleness past that bound is an availability failure of `/cv-ranked`, not a data-quality nuance.
- **Admin session theft, CSRF, and missing per-action authorization.** The admin control plane (concept §30.4) is a new privileged surface with real mutation power (manual crawl/dedupe/publish triggers, duplicate/taxonomy review actions). Every admin mutation needs its own authorization check at the Server Action/Route Handler level — never inherited from a layout or proxy check, which are UX-only per §30.2 — plus CSRF protection and audit logging (actor, action, outcome, no sensitive payload) on every mutation.
- **Public/admin query confusion and internal-detail leakage.** A public-surface query that accidentally reaches incident, review, quarantine, or candidate-adjacent data would leak operational or personal information to an anonymous visitor. Public queries must go through one shared eligibility policy rather than each maintaining its own lifecycle-status list, so there is one place this boundary can be gotten right or wrong, not several.
- **DoS against the database or artifact delivery.** The public process's `SELECT`-only, unprivileged database role (concept §30.2) bounds the blast radius of a query-based DoS; rate limiting and resource/time limits on the CV worker (above) bound a processing-based one. Versioned artifacts served with immutable long caching reduce repeated full-bundle fetches to a cache-miss cost, not a per-request one.
- **Credential separation is itself a mitigation, not just an architecture choice.** The public process holding no admin secret and no write-capable database credential (concept §30.2) means a public-surface compromise — the most exposed of the three runtime profiles, being unauthenticated and internet-facing by design — cannot pivot into crawl/dedupe/taxonomy/publication writes or admin data, even if application-level authorization has a bug elsewhere.
- **Source republishing rights and model redistribution license.** Two distinct permission questions, both gating public launch rather than technical readiness alone: whether each source's terms/robots posture (§5.3's per-source policy record, already required) actually permits the display Phase 8 gives it publicly, and whether the chosen embedding model's license permits self-hosted redistribution of its weights. Neither is satisfied by "it works" — `display.mayRepublishFullContent` (§3 above) and a recorded model license are both prerequisites, not implementation details.

Same rule as §2 and the sections above: this list is written from `change.md`'s security/privacy requirements before any Phase 8 code exists, and gets replaced row-by-row with real mitigation-in-place entries as Phase 8B–8E actually build them.

### 7.1 Browser CV Ranked — in place (Phase 8D)

The CV path that now exists (`web/lib/cv-ranked/`, `/cv-ranked`, the landing chooser). There is no model, tokenizer or WASM in it: Phase 8A approved none, so matching is lexical and the "model integrity" bullet above does not apply yet.

| Threat | Mitigation in place | Evidence |
| --- | --- | --- |
| CV leaves the browser (upload, URL, header, log, DB) | The file goes only to a dedicated worker by `postMessage`. No form, Server Action or request carries it. The worker's only network is `GET /api/matching/manifest` and the one listed bundle file, with `credentials: 'omit'` and `no-referrer`. | `e2e/privacy/cv-ranked-privacy.spec.ts` (`npm run test:e2e:privacy`) puts a canary in the CV text, the file name and a typed role. Against a real `public` server it asserts that every request from the page and the worker is a same-origin `GET` with no body to an allow-listed path, with no canary in any URL or header. It also checks that the canary is absent from cookies, Web Storage, IndexedDB, Cache Storage and the server's captured output, that no text/JSON column in any table holds it, and that the candidate/ranking tables are unchanged. A deliberate leak (`fetch('/cv-ranked?m=' + file.name)`) made it fail. |
| CV persists in the browser | State lives in React memory in a root-layout provider. It is ended by clear, cancel, replacement, `pagehide` and unmount, each of which terminates the worker. | The same spec asserts no IndexedDB database and no Cache Storage exist, and that neither storage area nor the cookies hold the canary. |
| Hostile PDF/DOCX | Extension and magic bytes must agree. Encrypted Office (OLE) and zip-encrypted entries are refused. Limits: 8 MiB. For DOCX, the central directory is walked before inflating: at most 60 MiB of declared uncompressed size and 2,000 entries, and ZIP64 is refused. PDFs are limited to 40 pages, extracted text to 200k characters, and a file below 40 letters counts as image-only. A 45 s wall clock terminates the whole worker. PDF.js runs in the worker's own thread with no cMap, font or wasm fetch. | `document-checks.test.ts` covers type mismatch, OLE, the size caps, a declared-size zip bomb, entry count, encrypted entries and truncation. The stub-PDF, renamed-file, empty-DOCX and `.txt` failures were each browser-checked. **Residual:** declared zip sizes can lie, so mammoth's real inflation is bounded only by the timeout and the character cap. |
| Parser error text echoing CV content | Only bounded `CvErrorCode`s cross to the UI. Raw exceptions are dropped, the worker error event's message is not forwarded, and nothing on the path calls `console`. | `protocol.ts` types; `rg console web/lib/cv-ranked` finds only a comment. |
| XSS via CV-derived text | Evidence snippets, terms and bundle fields render as React text only. Nothing on the path uses `dangerouslySetInnerHTML`. | `rg dangerouslySetInnerHTML` over the CV path finds nothing. Since Phase 8E, a nonce CSP also stops an injected script from running or sending anything off-origin (§7.2). |
| Poisoned, partial or stale bundle | The worker checks the manifest shape, schema range and feature contract. It verifies byte length and SHA-256 with SubtleCrypto, decodes UTF-8 strictly, validates the zod schema, and matches `bundleId`, `schemaVersion` and row count against the manifest. It refuses past `matchingAvailable: false` (72 h). | `bundle-client.ts`. The server side is covered by the Phase 8C bundle tests. |

### 7.2 Hosted surfaces — in place (Phase 8E)

Controls for the internet-facing processes. Deployment itself (the host, TLS certificates, real role passwords) is not done yet, so the hosted-evidence column is still owed. Everything below is proven locally against real production builds.

| Threat | Mitigation in place | Evidence |
| --- | --- | --- |
| XSS as CV exfiltration | A per-response nonce CSP from `web/proxy.ts`: `script-src 'self' 'nonce-…' 'strict-dynamic'`, no `unsafe-eval` in production, and `connect-src`, `worker-src` and `default-src` `'self'`. Also `frame-src`, `object-src` and `base-uri` `'none'`, and `form-action 'self'` (plus GitHub on `admin` for the OAuth redirect). An injected script without the nonce does not run, and one that did could reach only this origin. | `web/lib/security-headers.test.ts`; `e2e/csp.spec.ts` (six pages hydrate with no violation); the privacy suite runs the CV worker, PDF.js and mammoth under the production policy with zero violations. Setting `connect-src 'none'` made the privacy suite fail, which shows the policy governs the worker too. |
| Clickjacking, MIME sniffing, referrer and feature leakage | `frame-ancestors 'none'` plus `X-Frame-Options: DENY`, `nosniff`, `strict-origin-when-cross-origin`, a Permissions-Policy denying camera, microphone, geolocation and similar, COOP/CORP `same-origin`, and no `X-Powered-By`. HSTS is set by the TLS proxy (`deploy/Caddyfile`). | The privacy suite asserts the headers on a `public` production server. |
| DoS against DB-backed pages and the bundle | Per-client token buckets in `proxy.ts` (`web/lib/rate-limit.ts`): pages 240 burst at 4/s, manifest 60 at 1/s, bundle 20 at 1 per 30 s, admin sign-in 20 at 1 per 6 s. They key on the last `X-Forwarded-For` entry, which only the proxy sets, since the processes listen on loopback only. Memory is bounded. Probes are exempt, so a monitor sees the truth. Caddy caps request bodies (64 KB public, 1 MB admin). | `rate-limit.test.ts`; surfaces e2e: a real 429 with `Retry-After`, per-client isolation, no limit on probes or `local`. Load test: one `public` process serves about 22 req/s at 20 concurrency with no errors. **Residual:** the limiter is per process. A multi-instance deployment needs a shared store or limits at the proxy. |
| Public process holding power it should not | `instrumentation.ts` refuses to start `public` without `XTELO_MATCHING_ARTIFACT_DIR`, with any admin credential in its environment, or when its database role can `INSERT/UPDATE/DELETE/TRUNCATE` any relation (`web/lib/startup-checks.ts`). `admin` already refused to start without full, well-formed auth config. | `startup-checks.test.ts` runs the privilege query on the real database: the owner is refused, and `scraplify_public` (via `SET ROLE`) can write nothing. A real `next start` on the owner credential refused, naming 33 writable relations. **Residual:** `XTELO_E2E_ALLOW_WRITABLE_PUBLIC_ROLE=1` bypasses the role check for the e2e suites (CI has one credential). Deploy templates never set it. |
| Probe endpoints leaking internals | `/api/healthz` and `/api/readyz` return fixed state words only (`ready`, `down`, `stale`…), with no error text, host or query. | The surfaces e2e asserts the exact key set on all three surfaces. |
| A CV Ranked defect in production | `XTELO_CV_RANKED=off` removes the nav link and the landing chooser and pauses `/cv-ranked` without a deploy, leaving Browse up (change.md §15 rollback step 1). A mistyped value refuses startup rather than leaving CV entry on. | `availability.test.ts`; checked on a real `public` build (no CV link or file input anywhere; `/cv-ranked` shows the notice) and in the browser at 390 and 1280. |

## 8. How this document gets used

Not a one-time checklist — §2's table is expected to grow as new adapters and phases introduce new untrusted-input surfaces (attachment parsing in Phase 4 will need its own row: SSRF-after-redirect, decompression bombs, MIME confusion, path traversal in archive entries, per §16; §7 above is the Phase 8 equivalent, written in advance of the code). When a future review — Codex's or a human's — finds a new bypass class, the fix belongs in code *and* a new row here, the same way §2's rows were written after they were actually found and fixed, not predicted in advance.
