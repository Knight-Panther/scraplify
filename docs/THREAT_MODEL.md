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

## 7. How this document gets used

Not a one-time checklist — §2's table is expected to grow as new adapters and phases introduce new untrusted-input surfaces (attachment parsing in Phase 4 will need its own row: SSRF-after-redirect, decompression bombs, MIME confusion, path traversal in archive entries, per §16). When a future review — Codex's or a human's — finds a new bypass class, the fix belongs in code *and* a new row here, the same way §2's rows were written after they were actually found and fixed, not predicted in advance.
