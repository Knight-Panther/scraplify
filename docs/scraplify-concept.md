# Scraplify / Xtelo — Product and Architecture Concept

**Status:** Confirmed final — approved 2026-09-02  
**Date:** 2026-09-02  
**Repository:** `scraplify`  
**Product/agent name:** Xtelo  
**Amended:** 2026-09-05 — Phase 1A's scope narrowed at merge (§25): incremental overlap deferred, and "schedule" reduced to the code-level capability rather than an actually-registered live schedule. See §25's Phase 1A entry for the reasoning.

## 1. Purpose of this document

This document is the proposed source of truth for Scraplify's product direction and system architecture. It combines:

- Live inspection of jobs.ge and hr.ge, including Playwright-rendered pages.
- The product and phase ideas in `PROJECT_PLAN.md`.
- The engineering and security guidance in `CRAWLING_ARCHITECTURE_2026.md`.
- Corrections identified during architecture review.

The earlier documents remain useful research and engineering references. If they conflict with this document, this document takes precedence after approval.

## 2. Executive decision

Build Scraplify as a TypeScript modular monolith whose user-facing agent is Xtelo.

Xtelo is not a universal AI scraper. It is a human-in-the-loop opportunity agent built on a deterministic ingestion and data-quality foundation:

```text
permitted feed/API -> direct HTTP/HTML -> Playwright fallback
```

The first sources are jobs.ge and hr.ge, but source-specific behavior stays behind adapters so the platform can later support employer career pages, scholarships, summer schools, grants, events, and other permitted opportunity sources.

The system will:

1. Discover public listings on a schedule.
2. Fetch and validate new or meaningfully changed listings.
3. Preserve source records, revisions, provenance, and crawl evidence.
4. Normalize source-specific data into a shared opportunity model.
5. Categorize listings across a versioned canonical taxonomy.
6. Link likely cross-site duplicates without destroying source data.
7. Later parse a user's CV into a private, versioned candidate profile.
8. Rank listings with explainable evidence and user-controlled preferences.
9. Later draft outreach, but never send or submit without explicit approval.

## 3. Product vision

Xtelo should become a trusted opportunity inbox rather than another job-board mirror.

Its value comes from:

- Coverage across multiple sources.
- Reliable identification of new, changed, closing, and removed listings.
- One canonical view when the same opportunity appears on several sites.
- Consistent professions, categories, organizations, skills, and locations.
- Explainable CV matching rather than opaque similarity scores.
- A safe workflow from discovery to shortlist to approved application assistance.

The crawler is infrastructure. The agent operates above the database through explicit tools and approval boundaries.

## 4. Scope

### 4.1 Initial scope

- Public, unauthenticated listings on jobs.ge and hr.ge.
- Index and detail discovery.
- Idempotent storage in PostgreSQL.
- Immutable source revisions and meaningful change detection.
- Conservative closure detection.
- Organization normalization.
- Cross-source duplicate candidates and clusters.
- Canonical taxonomy mapping for jobs.
- Source-health monitoring and reproducible parser fixtures.
- Local scheduled operation with a path to an always-on deployment.

### 4.2 Later scope

- Search and shortlist interface.
- CV upload and structured candidate profiles.
- Explainable ranking and preference learning from user feedback.
- Telegram or other channel adapters.
- Cover-letter and email drafting.
- Approval-controlled sending or application assistance.
- Additional opportunity types and sources.
- Supervised parser-repair proposals.

### 4.3 Explicit non-goals for the initial release

- Microservices.
- A universal AI-generated scraper.
- Autonomous applications or messages.
- CAPTCHA solving or access-control circumvention.
- Authenticated crawling unless separately reviewed and authorized.
- Proxy rotation without a legitimate, demonstrated requirement.
- Republish-and-compete job-board behavior.
- Browserless, Apify hosting, Redis, BullMQ, OCR, or multimodal embeddings without measured need.
- Automatic execution of downloaded files, macros, scripts, or webpage instructions.

## 5. Source study and confirmed behavior

The following observations were confirmed on 2026-09-02. They are implementation inputs, not permanent guarantees; each adapter must detect drift.

### 5.1 jobs.ge

Confirmed:

- The homepage and listing details are server-rendered HTML.
- Routine ingestion does not currently require browser rendering.
- A Playwright inspection found 310 unique job-detail links on the homepage at the time of inspection.
- Stable listing identity is carried in URLs such as `?view=jobs&id=<numeric-id>`.
- Homepage content separates VIP/promoted and standard announcements.
- Listing rows expose title, employer, publication date, deadline, and flags.
- Detail pages expose the full description and commonly expose application instructions or email addresses.
- Source filters include category, location, and opportunity type.
- The site advertises RSS URLs, but the tested jobs RSS URL returned ordinary HTML; it is not yet a verified feed.
- `robots.txt` currently disallows `/data/clients/` and declares `Crawl-delay: 5`.

Implications:

- Use `CheerioCrawler` or direct HTTP for normal collection.
- Treat VIP and standard sections as separate discovery partitions.
- Do not assume the mixed homepage is strictly newest-first.
- Verify whether category/type filters or a date-sorted view reveal listings omitted from the default homepage.
- Preserve the numeric listing ID regardless of slug or presentation changes.
- Enforce a source-specific request interval compatible with the declared crawl delay.

### 5.2 hr.ge

Confirmed:

- hr.ge is an Angular application with server-rendered listing content.
- A Playwright inspection of `/search-posting` found 100 unique announcement links and no ordinary pagination links at the time of inspection.
- Detail pages use stable URLs such as `/announcement/<numeric-id>/<slug>`.
- Detail HTML contains richer fields including specialty, industry, seniority, employment form, schedule, work mode, experience, education, languages, location, salary, and application method when present.
- `robots.txt` currently allows public paths and advertises a large public sitemap.
- The public sitemap contains announcement URLs and is useful for reconciliation.
- The frontend loads configuration from `api.p.hr.ge`, but Playwright did not confirm a public listing/search JSON endpoint. Observed client API calls were ancillary, such as favorites and banners.
- The site includes AWS WAF challenge infrastructure.

Implications:

- Do not lock production ingestion to an undocumented JSON API.
- Begin with the public sitemap plus server-rendered index/detail HTML.
- Conduct a bounded API discovery experiment. Adopt a direct API only if its endpoint, completeness, stability, and permitted use are verified.
- Use smaller today/search views for frequent discovery and the large sitemap for less-frequent reconciliation.
- Detect WAF, challenge, login, consent, and access-denied responses as typed failures. Never bypass them.

### 5.3 Compliance interpretation

Robots rules guide crawler behavior but do not by themselves grant legal permission or redistribution rights.

Each source requires a versioned policy record containing:

- Allowed acquisition modes and paths.
- Disallowed paths and hosts.
- Authentication scope.
- Rate or crawl-delay rules.
- Terms and robots URLs.
- Raw-content retention and display rules.
- Review date, evidence, notes, and decision owner.

Where practical, request an official feed/API or written permission before sustained production use.

## 6. Requirements

### 6.1 Functional requirements

- Discover all publicly accessible listings exposed through known indexes, filters, pagination mechanisms, and sitemaps.
- Backfill current listings without duplicating records.
- Detect new, changed, expired, missing, reopened, and removed listings.
- Preserve original source values and normalized values.
- Retain immutable revisions and parser provenance.
- Normalize employers, titles, locations, dates, work modes, and job attributes.
- Categorize each job under a canonical, versioned taxonomy.
- Generate cross-source duplicate candidates and explain the evidence.
- Keep source records independently accessible after clustering.
- Expose crawl health and incomplete-run status.
- Later rank opportunities against a reviewed candidate profile.
- Later create drafts and require explicit approval for every external action.

### 6.2 Non-functional requirements

- **Correctness:** prefer an explicit unknown state over an unsupported conclusion.
- **Idempotency:** rerunning the same input must not create duplicate source records or revisions.
- **Politeness:** honor source policies, retry instructions, bounded concurrency, and crawl delays.
- **Auditability:** every normalized claim must be traceable to a source resource and parser version.
- **Recoverability:** preserve last-known-good state after partial or anomalous crawls.
- **Security:** treat every page, URL, redirect, and file as untrusted input.
- **Privacy:** keep CVs and personal preferences private, deletable, and absent from logs.
- **Maintainability:** isolate source selectors and quirks inside adapters.
- **Cost control:** keep browser and model use exceptional and measurable.
- **Portability:** run locally first without preventing later always-on deployment.

## 7. High-level architecture

```text
                              +----------------------+
                              | Source policy records|
                              +----------+-----------+
                                         |
                                         v
+-----------+    +------------------------------------------------+
| Scheduler | -> | Source adapters                                 |
+-----------+    | discover -> fetch -> extract -> normalize       |
                 +----------------------+-------------------------+
                                        |
                     +------------------+------------------+
                     |                                     |
                     v                                     v
             Direct HTTP/Cheerio                  Playwright fallback
                     |                                     |
                     +------------------+------------------+
                                        v
                         Validation and resource graph
                                        |
                         +--------------+--------------+
                         |                             |
                         v                             v
                 SourceListing + revisions       Source health/incidents
                         |
                         v
            Organization/location normalization
                         |
              +----------+-----------+
              |                      |
              v                      v
       Canonical taxonomy     Duplicate candidate scoring
              |                      |
              +----------+-----------+
                         v
                 Canonical Opportunity
                         |
              +----------+-----------+
              |                      |
              v                      v
        Search/shortlist       CV matching and ranking
                                     |
                                     v
                              Draft + approval gate
                                     |
                                     v
                           Explicit external action
```

The initial implementation is one deployable codebase with separate API, worker, and migration entry points. Module boundaries are logical rather than network boundaries.

## 8. Core architecture decisions

### 8.1 Modular monolith over microservices

**Decision:** Use one TypeScript repository and one PostgreSQL system of record.

Benefits:

- Faster development and simpler local operation.
- Transactional consistency across listings, revisions, duplicates, and events.
- Shared types and validation.
- Lower deployment and observability overhead.

Revisit only when a measured workload requires independent scaling or failure isolation.

### 8.2 Source adapters over a universal scraper

**Decision:** Every source owns discovery, parsing, source-specific policy, fixtures, and closure semantics behind one contract.

Benefits:

- A jobs.ge markup change cannot silently break hr.ge.
- Source policies and rate limits remain explicit.
- Tests can model the real quirks of each source.
- Additional opportunity sources can be added without changing the canonical domain.

### 8.3 HTTP first, browser by recorded escalation

**Decision:** Use direct HTTP/HTML unless a recorded condition requires Playwright.

Valid escalation reasons include:

- Expected content is absent in HTTP but present after rendering.
- A required interaction exists only in JavaScript.
- Infinite scroll, iframe state, browser-triggered download, or session behavior is essential and permitted.
- Network inspection is needed to identify a stable permitted endpoint.

Track browser requests as a percentage of total requests. A rising ratio is a source-health signal.

### 8.4 PostgreSQL as system of record

**Decision:** Store crawl metadata, source observations, revisions, normalized entities, clusters, classifications, rankings, and approvals in PostgreSQL.

Use `pg_trgm` for fuzzy candidate generation. Add `pgvector` only when semantic matching begins.

### 8.5 Durable jobs only when needed

Crawlee's request queue is sufficient for a single crawl run. Add `pg-boss` when document processing, ranking, notifications, or independently recoverable jobs require durable orchestration. Do not add Redis and BullMQ without a measured reason.

## 9. Source adapter contract

Conceptual contract:

```ts
interface SourceAdapter {
  readonly id: string;
  readonly policyVersion: string;
  readonly capabilities: {
    acquisitionModes: Array<'feed' | 'api' | 'http' | 'browser'>;
    requiresAuthentication: boolean;
    supportsIncrementalDiscovery: boolean;
    pollingIntervalMinutes: number;
  };

  discover(context: DiscoverContext): AsyncIterable<DiscoveredResource>;
  fetch(resource: DiscoveredResource, context: FetchContext): Promise<FetchedResource>;
  extract(resource: FetchedResource, context: ExtractContext): Promise<ExtractedSourceListing>;
  normalize(extracted: ExtractedSourceListing): Promise<NormalizedSourceListing>;
  checkpoint(result: CheckpointInput): Promise<void>;
}
```

Every adapter must define:

- Stable source identity.
- Discovery entry points and partitions.
- Pagination or cursor semantics.
- Incremental overlap and full-reconciliation rules.
- Required and optional fields.
- Date locale, timezone, and year inference.
- Rate limits, timeouts, concurrency, and retries.
- Closure and reopening semantics.
- Allowed acquisition modes.
- Parser version and fixtures.
- Browser escalation conditions.

An adapter may request an approved fallback. It must not silently promote every request to a browser request.

## 10. Source-specific acquisition strategy

### 10.1 jobs.ge strategy

#### Initial backfill

1. Fetch the default announcements page.
2. Parse VIP and standard sections independently.
3. Enumerate category, location, and opportunity-type views needed for completeness.
4. Deduplicate discovered URLs by the stable numeric source ID.
5. Fetch each unique detail page at a source-compliant rate.
6. Record index metadata, detail content, provenance, and extraction version.
7. Produce a coverage report showing overlap between discovery partitions.

#### jobs.ge incremental discovery

- Poll lightweight index views on a configurable schedule.
- Do not stop at the first known ID.
- Continue through a rolling overlap window until several consecutive sections/pages contain only known, unchanged records older than the high-water mark.
- Treat promoted, pinned, and republished items separately from chronological evidence.
- Run a periodic complete reconciliation.

### 10.2 hr.ge strategy

#### Acquisition decision spike

Before locking the adapter:

1. Compare public sitemap, today/search HTML, and detail HTML coverage.
2. Inspect browser traffic for a public listing/detail API.
3. If an API is found, verify unauthenticated access, field completeness, pagination, rate behavior, stability, and permitted use.
4. Record the selected modes in the source policy.

Current default if no suitable API is verified:

- Frequent discovery: public today/search HTML.
- Reconciliation: public sitemap.
- Details: server-rendered announcement HTML.
- Browser: canary and fallback only.

#### hr.ge incremental discovery

- Poll the smaller current-listing entry point frequently.
- Fetch new details immediately.
- Revisit known active details periodically even if the visible deadline is unchanged.
- Download the large sitemap less frequently and compare its IDs with current state.
- Never infer mass closure from a single reduced or failed result set.

## 11. Resource and request identity

Store three URL forms:

- `original_url`: exactly what the parent resource contained.
- `canonical_url`: normalized identity URL.
- `final_url`: destination after bounded redirects.

Canonicalization must preserve meaningful identifiers and remove tracking parameters only through reviewed, host-specific rules.

Every queued request receives a typed role such as:

- `INDEX`
- `OPPORTUNITY`
- `ORGANIZATION`
- `APPLICATION`
- `ATTACHMENT`

Its identity includes canonical URL, role, and any relevant processing version. Request deduplication prevents duplicate fetch work; it is separate from cross-source opportunity deduplication.

## 12. Domain model: canonical opportunity versus source observation

This distinction is mandatory.

### 12.1 `SourceListing`

Represents what one source says.

```text
id
source_id
source_record_id
canonical_source_url
current_revision_id
first_seen_at
last_seen_at
status
missing_streak
source_published_at
source_deadline_at
```

Uniqueness: `(source_id, source_record_id)` when a stable external ID exists.

### 12.2 `SourceListingRevision`

An immutable normalized snapshot of one source listing:

```text
source_listing_id
parser_version
extraction_method
raw_resource_hash
meaningful_content_hash
title_raw / title_normalized
organization_raw
description
locations
salary
dates
application_method
source_categories
structured_attributes
created_at
provenance
```

A revision is created only when meaningful normalized content changes.

### 12.3 `Opportunity`

Represents the probable real-world opportunity independently of any source:

```text
id
type
canonical_title
organization_id
canonical_status
current_canonical_revision_id
created_at
updated_at
```

Initial opportunity types:

- `job`
- `summer_school`
- `scholarship`
- `grant`
- `event`

Type-specific attributes belong in `job_details`, `program_details`, or equivalent records rather than a single nullable table.

### 12.4 `OpportunityRevision`

Represents the immutable resolved view of a canonical opportunity at a point in time:

```text
opportunity_id
canonical_title
canonical_status
organization_id
resolved_fields
source_membership_versions
resolution_ruleset_version
meaningful_content_hash
created_at
```

Canonical revisions preserve disagreements and field-level provenance. They are recomputed only when source membership, a contributing source revision, or the resolution ruleset changes meaningfully.

### 12.5 `OpportunitySourceMembership`

Links a source listing to a canonical opportunity:

```text
opportunity_id
source_listing_id
decision
confidence
evidence
decided_by
decided_at
dedupe_model_or_ruleset_version
```

Moving a source listing between clusters must be reversible and audited.

### 12.6 Supporting entities

- `sources`
- `source_policies`
- `source_checkpoints`
- `resources`
- `resource_links`
- `source_listing_revisions`
- `opportunity_revisions`
- `opportunity_source_memberships`
- `organizations`
- `organization_aliases`
- `locations`
- `taxonomy_terms`
- `source_taxonomy_mappings`
- `listing_classifications`
- `duplicate_candidates`
- `crawl_runs`
- `fetch_attempts`
- `parser_incidents`
- `internal_events`
- `candidate_profiles`
- `rankings`
- `drafts`
- `approvals`
- `audit_events`

## 13. Listing lifecycle and change detection

Suggested source-listing states:

```text
discovered -> active -> missing_suspected -> closed
                    \-> expired
closed/expired -> active (reopened or republished)
any state -> quarantined when evidence is unreliable
```

Rules:

- New source ID: fetch detail and create the initial revision.
- Changed index metadata: refetch detail promptly.
- Unchanged active listing: refetch on a slower periodic schedule.
- Near-deadline listing: refetch more frequently.
- Missing once: set `missing_suspected`; do not close.
- Missing across the configured number of complete successful reconciliations: close with evidence.
- Passed deadline: mark expired according to source-specific timezone/date rules.
- Reappearance: reopen and record an event.
- Partial, blocked, or anomalous crawl: do not advance missing streaks.

Hash both raw bytes and normalized meaningful content. Raw HTML alone is too noisy because advertisements, timestamps, and tracking markup change independently of the vacancy.

## 14. Cross-source deduplication

Deduplication links records; it does not erase them.

### 14.1 Stages

1. **Exact source identity**
   - Same source and stable external ID means the same `SourceListing`.

2. **Strong deterministic matches**
   - Matching employer-controlled application URL.
   - Matching contact email/phone plus compatible title and dates.
   - Explicit cross-posting reference.

3. **Candidate generation**
   - Use normalized organization, title/profession, location, and a bounded publication/deadline window.
   - Use PostgreSQL `pg_trgm` or equivalent indexes to avoid all-pairs comparison.

4. **Weighted evidence scoring**
   - Organization identity and aliases.
   - Canonical profession and title similarity.
   - Location compatibility.
   - Publication and deadline proximity.
   - Description and requirements similarity.
   - Salary and schedule compatibility.
   - Contact and application-method overlap.

5. **Decision**
   - `confirmed_same`
   - `probable_same`
   - `needs_review`
   - `distinct`

### 14.2 Safety rules

- Do not establish production thresholds without a labeled Georgian test set.
- Auto-link only high-confidence candidates with multiple independent signals.
- Never auto-link solely because title, employer, and location match.
- Preserve every source description and deadline.
- Surface disagreements in the canonical view rather than silently choosing one value.
- Prefer the freshest supported value while displaying provenance.
- Record ruleset/model versions so decisions can be recomputed.

### 14.3 Evaluation

Maintain golden pairs containing confirmed duplicates and hard negatives, including:

- Same employer hiring several people for the same title.
- Different branches or locations.
- Reposted jobs with new deadlines.
- Staffing agencies posting for unnamed clients.
- Georgian and English versions of the same role.
- Slightly different titles with identical application details.

Measure precision before recall; false merges are more damaging than missed merges.

## 15. Canonical taxonomy and categorization

Do not collapse category, profession, and industry into one label.

### 15.1 Taxonomy axes

- Opportunity type.
- Profession/occupation.
- Functional area.
- Employer industry.
- Seniority or experience level.
- Employment type.
- Schedule.
- Work mode: on-site, hybrid, remote, field-based.
- Skills and tools.
- Languages.
- Education or certification requirements.
- Geographic location.

### 15.2 Mapping workflow

1. Preserve source category IDs and labels exactly.
2. Normalize text and known Georgian/English aliases.
3. Apply versioned deterministic mappings and keyword rules.
4. Use structured source fields where available.
5. Generate an ambiguous classification candidate when confidence is insufficient.
6. Optionally use a constrained LLM classification schema later.
7. Store taxonomy version, method, confidence, and evidence.
8. Queue low-confidence or conflicting results for review.

An external taxonomy such as ESCO may be mapped later, but the first release should use a practical controlled taxonomy sized for the observed Georgian listings.

### 15.3 Organization normalization

Organizations require their own identity process:

- Preserve raw displayed names.
- Normalize legal prefixes, whitespace, punctuation, case, and known transliterations.
- Store aliases rather than rewriting historical values.
- Use official domains, employer pages, contact domains, and reviewed aliases as evidence.
- Keep staffing agency and represented employer identities separate when distinguishable.

## 16. Attachments and linked resources

Phase 1 records attachment and external-application metadata. Full recursive processing is enabled only after observed examples justify it.

Each source policy defines:

- Allowed destination hosts.
- Allowed relationship types.
- Maximum traversal depth.
- Maximum resources per opportunity.
- Whether external application pages may be fetched.
- Whether metadata or full content may be retained.

When document processing is enabled:

1. Resolve URLs against the final parent URL.
2. Follow redirects manually and within a fixed limit.
3. Reapply SSRF and policy checks after every redirect and DNS resolution.
4. Classify from headers, disposition, extension, and magic bytes.
5. Stream to quarantine storage with byte and time limits.
6. Calculate SHA-256 while streaming.
7. Dispatch only allowlisted MIME types.
8. Persist success, partial extraction, or typed failure.

Mandatory controls include limits for compressed bytes, expanded bytes, file count, recursion depth, compression ratio, and processing time. Reject path traversal, absolute paths, drive paths, symlinks, private-network destinations, metadata-service destinations, executable content, macros, and unknown archive behavior.

## 17. CV matching and ranking

This begins only after the listing corpus is trustworthy.

### 17.1 Candidate profile

Parse a CV once into a reviewed, versioned `CandidateProfile` containing:

- Roles and experience periods.
- Skills and supporting evidence.
- Education and certifications.
- Languages.
- Location and work-mode preferences.
- Salary and schedule constraints when supplied.
- Preferred and excluded professions or industries.

Every extracted claim retains a pointer to supporting CV content. Users can correct the profile before ranking.

### 17.2 Ranking funnel

```text
hard eligibility and user constraints
        -> deterministic skill/title/experience scoring
        -> embedding similarity when enabled
        -> small-model structured assessment
        -> premium reasoning only for top or ambiguous candidates
```

The result must explain:

- Match score and component scores.
- Strong matching evidence.
- Missing or uncertain requirements.
- Hard-filter reasons.
- Listing revision and candidate-profile version.
- Ruleset, embedding model, prompt, and model versions when applicable.

Cache results by opportunity revision, candidate-profile version, and evaluation version. Never overwrite prior assessments when an input or model changes.

Embeddings improve candidate retrieval; they are not the sole ranking truth. Add `pgvector` only during this phase and use exact search until scale measurements justify an approximate index.

## 18. Agent and approval boundaries

Expose explicit tools instead of giving a model unrestricted database, browser, or messaging access.

Examples:

- `search_opportunities`
- `explain_match`
- `save_opportunity`
- `dismiss_opportunity`
- `create_message_draft`
- `list_pending_approvals`
- `approve_draft`
- `send_approved_message`

Requirements:

- Drafting does not imply approval.
- Approval is tied to exact recipients, subject/body, attachments, listing, and version.
- Any change after approval invalidates approval.
- Sending or form submission is separately audited.
- Telegram, email, and web are channel adapters, not workflow engines or systems of record.

## 19. Scheduling and deployment cadence

### 19.1 Initial local topology

- Node.js worker runs source jobs directly.
- PostgreSQL runs locally or in Docker Compose.
- Windows Task Scheduler starts the worker; it does not blindly start a one-shot container.
- Every run begins with configuration, source-policy, database, and lock preflight checks.
- Every run records a `crawl_run`, including incomplete and failed runs.
- Overlapping runs for the same source are prevented with an advisory lock or equivalent lease.

If Docker hosts PostgreSQL, the task must detect that Docker/PostgreSQL is unavailable and surface a clear failure. It must not silently skip a run.

### 19.2 Initial cadence

Cadence is configuration, not a hard-coded product assumption.

| Work | Starting cadence | Notes |
|---|---:|---|
| jobs.ge lightweight discovery | 30–60 minutes | Enforce per-request crawl delay and bounded concurrency. |
| hr.ge today/search discovery | 30–60 minutes | Tune after observing change rate and response size. |
| New detail fetch | Immediately after discovery | Queue at source-compliant rate. |
| Active detail refresh | Every 24–72 hours | Faster near deadline or after index changes. |
| hr.ge full sitemap reconciliation | Every 6–24 hours | Avoid downloading the large sitemap on every small poll. |
| Complete source reconciliation | Nightly or weekly | Source-specific and tuned from evidence. |
| Playwright canary | Daily or after anomalies | Compare rendered and HTTP-derived coverage. |

The scheduler may slow down based on `Retry-After`, 429s, latency, or source-health signals.

### 19.3 Later deployment

Move to an always-on backend when continuous reliability matters more than local simplicity:

- Application/API process.
- Worker process, initially from the same codebase.
- Managed or backed-up PostgreSQL.
- Object storage when raw documents require it.
- `pg-boss` for durable heterogeneous work.
- Web or phone interface for review and approvals.

Consider Apify or Browserless only after measured operations show that hosted crawler execution or browser pooling would materially help.

## 20. Technology stack

| Layer | Decision | Timing |
|---|---|---|
| Runtime | Node.js 24 LTS, pinned by major | Foundation |
| Language | TypeScript, strict ESM | Foundation |
| Package manager | npm with committed lockfile | Foundation |
| Crawl orchestration | Crawlee | First adapter |
| HTTP HTML extraction | CheerioCrawler | First adapter |
| API/probes/downloads | Native Node `fetch`, with bounded/manual redirect handling where security requires | As needed |
| Browser fallback | PlaywrightCrawler with Chromium | Only when escalation criteria are met |
| Validation | Zod | Foundation |
| Database | PostgreSQL | Foundation |
| Database access | Drizzle ORM and `pg` | Foundation |
| Fuzzy matching | PostgreSQL `pg_trgm` | Deduplication phase |
| Vector matching | `pgvector` | CV-matching phase |
| Durable work queue | `pg-boss` | When heterogeneous durable jobs appear |
| API | Fastify or a comparably small TypeScript HTTP layer | Browse/search phase |
| Web UI | Small TypeScript web application | Browse/search phase |
| Logging | Pino with redaction | Foundation |
| Testing | Vitest and fixture-driven parsers | Foundation |
| Formatting/linting | Biome plus TypeScript compiler | Foundation |
| Containers | Docker Compose, PostgreSQL first | Foundation/local deployment |
| Telemetry | OpenTelemetry/Sentry | After structured logs and real operational need |

Do not install later-phase dependencies during foundation work.

## 21. Observability and source health

### 21.1 Structured logs

Use contextual fields such as:

```text
runId, sourceId, requestId, resourceId, sourceListingId,
opportunityId, urlHost, route, crawlerType, attempt,
parserVersion, statusCode, durationMs, bytes, contentHash, errorKind
```

Redact authorization headers, cookies, tokens, CV contents, personal information, and sensitive query parameters.

### 21.2 Metrics

- Run duration and completion status by source.
- Requests, retries, response classes, bytes, and latency.
- Queue depth and oldest work age when durable queues exist.
- HTTP-to-browser ratio.
- Discovered, new, changed, unchanged, missing, expired, reopened, and quarantined listings.
- Required-field completeness.
- Parse failures and duplicate-ID rates.
- Duplicate-candidate decisions and review backlog.
- Classification confidence and unmapped taxonomy rate.
- Attachment types and processor results.
- Ranking/model latency, tokens, cache hits, and estimated cost.

### 21.3 Semantic failure detection

HTTP 200 is not sufficient evidence of success. Detect:

- Sudden listing-count collapse or unexplained surge.
- Required fields disappearing.
- Cookie, navigation, login, CAPTCHA, or access-denied text replacing content.
- Repeated pagination content.
- Date, salary, location, or encoding failures.
- Unexpected MIME types.
- Browser fallback increasing sharply.
- Duplicate spikes.
- Mass apparent closures.

An anomalous run is quarantined and does not advance closure state.

## 22. Supervised parser repair

```text
health anomaly
  -> capture sanitized evidence and failing fixture
  -> compare with last-known-good fixture and parser
  -> produce a candidate patch in a restricted environment
  -> run source and global regression/data-quality suites
  -> present diff, evidence, and risk summary
  -> human approval
  -> deploy
  -> canary and rollback if quality falls
```

Safe automatic recovery may retry, honor `Retry-After`, switch between already-approved acquisition modes, rediscover pagination, or quarantine results.

It must not:

- Bypass CAPTCHA or access controls.
- Expand authentication scope.
- Ignore robots or source policy.
- Execute webpage-provided instructions.
- Access production secrets from the repair sandbox.
- Deploy unreviewed generated code.

## 23. Security, privacy, and retention

### 23.1 Remote-content security

- Treat HTML, JSON, redirects, documents, filenames, and extracted text as untrusted.
- Restrict URL schemes and destination hosts by request role.
- Perform SSRF checks after every redirect and DNS resolution.
- Bound redirects, response bytes, processing time, concurrency, and recursion.
- Store downloaded content outside the source tree using generated identifiers.
- Never expose production credentials to parsers or AI tools.

### 23.2 Candidate privacy

Before CV upload is enabled:

- Encrypt raw CVs and sensitive profile data at rest where supported.
- Restrict access by role and user identity.
- Never log CV content.
- Provide deletion of raw CV, derived profile, embeddings, and cached assessments.
- Define backup retention and deletion propagation.
- Record user consent and permitted processing purposes.
- Avoid sending CV content through third-party channels unless the user knowingly requests it.

### 23.3 Content retention

Define separate retention for:

- Raw HTML.
- Sanitized parser fixtures.
- Downloaded attachments.
- Extracted text.
- Normalized facts and revisions.
- Operational logs.

Prefer short-lived raw storage and long-lived normalized provenance unless a source policy or debugging requirement justifies otherwise. The user-facing product should link to the original listing and avoid unnecessary republication of full source content.

## 24. Testing strategy

### 24.1 Unit tests

- URL resolution and source-specific canonicalization.
- Date parsing in Asia/Tbilisi and source locale.
- Yearless dates across year boundaries.
- Georgian Unicode normalization.
- Zod schemas and deterministic normalizers.
- Meaningful hashing and stable ordering.
- Deduplication features and rules.
- Taxonomy mappings.
- Closure-state transitions.
- MIME and SSRF policy checks when attachments are enabled.

### 24.2 Fixture tests

Each source requires legally permissible, sanitized fixtures for:

- Index sections and detail pages.
- VIP/pinned and ordinary listings.
- Missing optional fields.
- Empty, malformed, blocked, login, or CAPTCHA responses.
- Changed layouts.
- Duplicate/repeated pages.
- Georgian and mixed-language text.
- Yearless dates.
- Attachments or redirects when observed.

Pin expected output to a parser version. Live sites must not be the only CI oracle.

### 24.3 Integration and live canaries

- PostgreSQL migrations and idempotent upserts.
- Concurrent-run locking.
- Retry, rate-limit, conditional-request, and partial-run behavior.
- Revision creation only on meaningful change.
- Closure prevention after incomplete runs.
- Duplicate and taxonomy golden sets.
- Small, read-only live canaries run separately from deterministic CI.
- Playwright-versus-HTTP coverage comparison for selected entry points.

## 25. Phased implementation plan

Each phase has an exit gate. Do not begin a broad later phase merely because its dependencies are convenient to install.

### Skill adoption policy

Skills are optional implementation aids, not product dependencies or substitutes for tests, review, or source policy. The presence of a downloaded skill under `.claude/skills` means it is available to Claude Code; it does not mean the skill is approved for the project or visible to Codex.

Do not import or expose additional skills merely during concept work. When a phase begins:

1. Confirm that the workflow repeats often enough to justify a skill.
2. Review the exact `SKILL.md`, supporting files, scripts, license, source repository, and pinned revision.
3. Remove instructions that conflict with this document, repository policy, or approval boundaries.
4. Prefer a narrow project-specific variant over several overlapping generic skills.
5. Test the skill against representative tasks and compare its behavior with the no-skill baseline.
6. Adopt and version only the approved skill directory.

Candidate skills by phase:

| Phase | Skills to consider importing or creating | Adoption note |
|---|---|---|
| Phase 0 | `security-review`; project-specific `database-migrations-review` adapted from `postgresql-code-review` | Keep review-only. Require actual dependency, secret, migration, and static checks; do not treat an AI checklist as proof of security. |
| Phase 1A | Project-specific `source-adapter`, `parser-fixtures`, and `source-reconnaissance` adapted from `playwright-explore-website` | Reconnaissance must be read-only on third-party sites. It may inspect pages and network behavior but must not sign in, upload, submit, or send. |
| Phase 1B | Reuse the approved `source-adapter`, `parser-fixtures`, and `source-reconnaissance`; consider `crawl-diagnostics` | Do not create an hr.ge-only generic framework. Keep API-versus-HTML decisions and browser escalation in the adapter policy. |
| Phase 1C | `crawl-diagnostics` and a project-specific completeness/canary workflow | Keep live Playwright checks separate from deterministic fixture tests. |
| Phase 2 | Project-specific `dedupe-evaluation` and `taxonomy-mapping`; reuse `database-migrations-review` | Require labeled Georgian golden sets, evidence, versioning, and reversible duplicate decisions. |
| Phase 3 | `playwright-generate-test` and at most one reviewed `webapp-testing` variant | Use only for Scraplify's own local UI. Do not install both same-named `webapp-testing` variants or make live job boards the test oracle. |
| Phase 4 | Project-specific `attachment-safety`; reuse `security-review` | Cover SSRF, redirects, MIME confusion, path traversal, decompression bombs, quarantine, and processing budgets. |
| Phase 5 | Project-specific `ranking-evaluation` and `candidate-privacy-review` | Test explainability, evidence links, reproducibility, deletion, model/version drift, and sensitive-data handling. |
| Phase 6 | Project-specific `approval-workflow-review`; reuse `security-review` | Verify exact-content approval, invalidation after edits, recipient/attachment binding, and audit events before any send integration. |
| Phase 7 | `postgresql-optimization`, `crawl-diagnostics`, and project-specific `observability-review` and `parser-repair` | Import optimization guidance only after real schemas, data volumes, query plans, and operational metrics exist. Repair remains proposal-only and approval-gated. |

The downloaded third-party skills are therefore candidates, not a package to enable wholesale. In particular:

- Adapt `playwright-explore-website` into a read-only `source-reconnaissance` skill.
- Defer `playwright-generate-test` until Scraplify has its own web UI.
- Select at most one `webapp-testing` implementation and tailor it to the TypeScript stack.
- Adapt `postgresql-code-review` to Scraplify's actual schema and migration rules.
- Defer `postgresql-optimization` until measurements justify it.
- Import `security-review` only after its referenced files and scripts are reviewed and pinned.

### Cross-agent skill exposure

When a skill is approved, keep one canonical reviewed copy and expose it to both agents rather than maintaining drifting duplicates:

```text
.agent-skills/<skill>/      # canonical reviewed directory
.claude/skills/<skill>      # symlink to the canonical directory
.agents/skills/<skill>      # symlink to the canonical directory for Codex
```

If an existing reviewed `.claude/skills/<skill>` directory temporarily remains canonical, create the corresponding `.agents/skills/<skill>` symlink when adopting it for Codex. Create symlinks per approved skill; do not expose the entire third-party download directory automatically.

Codex and Claude skill discovery are separate. A Claude project skill is not automatically available to Codex, and a skill that mentions an MCP server does not install or register that server. MCP servers, plugins, credentials, and permissions must be configured and verified independently for each runtime.

Before committing symlinks on Windows, verify filesystem permissions and Git symlink behavior. If portable symlinks are unreliable, use generated copies from the canonical directory plus a validation check that fails when copies drift.

### Phase 0 — policy and domain foundation

- Confirm Node/npm in a fresh non-interactive PowerShell.
- Initialize strict TypeScript, validation, formatting, tests, and CI.
- Write source-policy records for jobs.ge and hr.ge.
- Define `Opportunity`, `SourceListing`, revision, organization, resource, taxonomy, duplicate, run, and incident contracts.
- Write the threat model and approval boundaries.
- Create database migrations and local PostgreSQL configuration.

**Exit gate:** clean install, format, lint, typecheck, tests, and build pass; no live crawler is required.

### Phase 1A — jobs.ge vertical slice

- Capture sanitized index and detail fixtures.
- Implement VIP and standard discovery partitions.
- Investigate filters/date ordering and define completeness.
- Implement source-compliant HTTP fetching.
- Store source listings, revisions, resources, attempts, and crawl runs.
- Implement conservative closure logic. Incremental overlap (a rolling discovery window that stops early once several consecutive pages contain only known, unchanged records) is deferred past this phase — see §28 — since jobs.ge's corpus is small and bounded enough (~19 pages, ~5,647 listings at time of writing) that a full discovery walk every run is fast and simpler than an overlap window, with no correctness cost: conservative closure alone already satisfies this phase's exit gate below.
- Implement the code-level capability to run local read-only crawls on a schedule (a CLI entry point, real fetcher/rate-limiter wiring, and a Windows Task Scheduler registration script per §19.1). Actually registering a live recurring schedule is an operator action taken deliberately, separately, whenever ready — not a code deliverable this phase's exit gate depends on.

**Exit gate:** jobs.ge reruns idempotently; new, changed, unchanged, missing, expired, and failed states are correct; incomplete runs cannot mass-close records.

### Phase 1B — hr.ge acquisition decision and adapter

- Complete the bounded API-versus-HTML acquisition experiment.
- Capture sitemap, index/search, and detail fixtures.
- Implement sitemap reconciliation and frequent small-index discovery.
- Parse rich structured fields.
- Add WAF/challenge detection and source-specific health checks.

**Exit gate:** the selected method is evidence-backed and policy-recorded; hr.ge ingestion is idempotent and independently healthy.

### Phase 1C — cross-source reconciliation

- Produce coverage and overlap reports.
- Validate full-reconciliation behavior.
- Confirm that a failing source cannot affect the other source's state.
- Add browser-versus-HTTP canaries where useful.

**Exit gate:** completeness is measured and failures are isolated by source.

### Phase 2 — normalization, taxonomy, and deduplication

- Normalize organizations, locations, professions, job attributes, and aliases.
- Map source taxonomies to the canonical taxonomy.
- Build duplicate candidate generation and evidence scoring.
- Create human review states and reversible cluster membership.
- Build labeled Georgian duplicate and taxonomy test sets.

**Exit gate:** classifications are versioned and explainable; duplicate precision meets an agreed target before automatic linking is enabled.

### Phase 3 — browse and shortlist

- Build search/filter APIs and a small review interface.
- Expose new, changed, closing, missing, and quarantined listings.
- Expose source health, duplicate review, taxonomy review, saved items, and dismissals.

**Exit gate:** the stored corpus can be inspected and corrected without direct database access.

### Phase 4 — attachments and resource expansion

- Analyze observed attachment formats and frequency.
- Implement only required processors with bounded quarantine handling.
- Add resource-graph traversal under source-specific host/depth policies.
- Add adversarial fixtures before accepting archives or documents.

**Exit gate:** supported resources preserve provenance and malicious or oversized inputs fail safely.

This phase may move earlier only if an initial source places essential listing content in attachments.

### Phase 5 — CV matching

- Add private CV upload and deletion.
- Build a reviewed, versioned candidate profile.
- Implement deterministic filters and explainable scoring.
- Add embeddings and `pgvector` only after a retrieval evaluation set exists.
- Add constrained model assessment only where it improves measured ranking quality.

**Exit gate:** rankings are reproducible, evidence-backed, private, and versioned.

### Phase 6 — outreach assistance

- Generate cover-letter and email drafts.
- Add exact-content approval records.
- Integrate one messaging channel at a time.
- Audit every approval, mutation, send, and failure.

**Exit gate:** no external action is possible without current explicit approval.

### Phase 7 — operations and supervised repair

- Add durable heterogeneous work with `pg-boss` if required.
- Add operational telemetry and alerts.
- Establish source-health baselines and incident workflows.
- Add sandboxed repair proposals, review, canaries, and rollback.
- Reassess hosting, object storage, browser infrastructure, and scaling from measured evidence.

**Exit gate:** failures are observable, repairs are tested and auditable, and restoration/rollback is practiced.

## 26. First implementation milestone

The first coding milestone is deliberately narrow:

> One complete jobs.ge HTTP ingestion path into PostgreSQL with fixtures, revisions, provenance, health reporting, and safe incremental behavior.

Acceptance criteria:

- Re-running identical input creates no duplicate source records or revisions.
- Stable source IDs and source URLs are preserved.
- New and meaningfully changed detail pages create correct immutable revisions.
- Index disappearance does not immediately close a listing.
- A failed or incomplete run cannot advance mass closure.
- VIP and standard sections are measured separately.
- Georgian Unicode and yearless dates have deterministic tests.
- Rate limiting complies with the recorded jobs.ge source policy.
- Parse failures are typed and quarantined.
- Run reports show discovered, new, changed, unchanged, suspected missing, expired, reopened, quarantined, and failed counts.
- No LLM or production browser dependency is required.

## 27. Open decisions before implementation

- Whether jobs.ge has a complete date-sorted view independent of VIP promotion.
- Which jobs.ge filters are required for complete job-only discovery.
- Whether hr.ge exposes a stable, complete, permitted listing/detail API.
- Exact raw HTML and attachment retention periods.
- Initial normalized Georgian profession taxonomy and review process.
- Local-only versus always-on deployment target after the first vertical slice.
- Desired notification channel and acceptable notification delay.
- Whether observed attachments contain essential listing content.
- Initial labeled duplicate set and the precision required for automatic linking.

## 28. Decisions to revisit with evidence

- Implement §10.1's incremental discovery overlap window for jobs.ge once its corpus grows enough that a full discovery walk every run becomes slow — deferred from Phase 1A (2026-09-05); currently ~19 pages / ~5,647 listings, well within a fast full walk.
- Add `pg-boss` when durable heterogeneous jobs appear.
- Add Playwright to the application when a source or automated canary requires it.
- Add `pgvector` when semantic retrieval is being implemented.
- Add object storage when retained resources outgrow simple controlled local storage.
- Add OCR, XLSX, or archive processors only after representative samples exist.
- Consider Apify for hosted crawling operations.
- Consider Browserless for measured browser pooling or isolation needs.
- Split processes or services only for demonstrated scale or failure-isolation reasons.

## 29. References

### Project research

- [`PROJECT_PLAN.md`](./PROJECT_PLAN.md)
- [`CRAWLING_ARCHITECTURE_2026.md`](./CRAWLING_ARCHITECTURE_2026.md)

### Source sites

- [jobs.ge](https://www.jobs.ge/)
- [jobs.ge robots.txt](https://www.jobs.ge/robots.txt)
- [hr.ge](https://www.hr.ge/)
- [hr.ge robots.txt](https://www.hr.ge/robots.txt)
- [hr.ge public sitemap](https://api.p.hr.ge/public-portal/tenant/1/api/v3/seo/sitemap)

### Technical references

- [Node.js releases](https://nodejs.org/en/about/previous-releases)
- [Crawlee quick start and crawler selection](https://crawlee.dev/js/docs/quick-start)
- [Crawlee RequestQueue](https://crawlee.dev/js/api/core/class/RequestQueue)
- [Crawlee RobotsTxtFile](https://crawlee.dev/js/api/utils/class/RobotsTxtFile)
- [Playwright browser installation](https://playwright.dev/docs/browsers)
- [Playwright Docker guidance](https://playwright.dev/docs/docker)
- [Drizzle PostgreSQL documentation](https://orm.drizzle.team/docs/get-started-postgresql)
- [pgvector](https://github.com/pgvector/pgvector)
- [OpenTelemetry JavaScript status](https://opentelemetry.io/docs/languages/js/)
- [Vitest](https://vitest.dev/guide/)
- [Biome](https://biomejs.dev/guides/getting-started/)
