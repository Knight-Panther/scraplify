# hr.ge reconnaissance notes (Phase 1B, acquisition-decision spike)

Read-only reconnaissance against the live site, 2026-09-05. No sign-in, account creation, form submission, apply, favorite, or any other state-mutating action was performed — plain GETs plus DOM/network inspection only. Two Playwright page loads (`/search-posting`, one detail page) and 46 plain HTTP GETs, all paced by hand at ~4 s between requests to match `src/policies/hr-ge.ts`'s `maxConcurrency: 1` posture. No `POST` was ever sent to hr.ge or `api.p.hr.ge` (the one endpoint that would have required a POST was deliberately left unprobed — see "The JSON API" below).

This file is the durable record. Treat entries as "confirmed 2026-09-05" the same way `src/policies/hr-ge.ts`'s comments are dated. It is written against, and in several places **overturns**, the 2026-09-02 Phase 0 reconnaissance that `src/policies/hr-ge.ts` and concept §5.2 currently encode.

**Fixture integrity check (the mistake `src/adapters/jobs-ge/RECON_NOTES.md` records for 2026-09-04): verified.** All 8 files in `fixtures/` begin with `<` (raw HTML), not `"` or `{`, and each one's embedded `ng-state` JSON island was re-parsed successfully after being written to disk. No `JSON.stringify`-of-page-text corruption this time.

---

## Summary of what changed versus Phase 0

| Phase 0 finding (2026-09-02) | Status after this spike |
|---|---|
| "`/search-posting` found 100 unique announcement links and **no ordinary pagination links**" | **Overturned.** Ordinary `<a href>` pagination exists and is present in the raw SSR HTML: `?pg=N`, 33 pages, 3,265 announcements. Phase 0 saw only page 1. |
| "Playwright did not confirm a public listing/search JSON endpoint; observed client API calls were ancillary (favorites, banners)" | **Confirmed as to client XHR** (favorites + banners are still the only content-adjacent XHRs on load) — but **an endpoint was identified anyway**, from the SSR transfer-state, and then evaluated and rejected. See below. |
| "The public sitemap contains announcement URLs and is useful for reconciliation" | **Overturned, and this is the most important finding here.** The sitemap contains **only the 1,075 paid/priority announcements** — exactly 33% of the live corpus — and zero free ones. Using it as the reconciliation oracle would mass-close every free listing. |
| "Angular application with server-rendered listing content" | **Confirmed and strengthened.** `ng-server-context="ssr"`; the full listing payload is present in the raw response with no JS executed. |
| "AWS WAF challenge infrastructure is present" | **Confirmed present, never triggered** across 46 requests. Signature recorded below, including a trap. |
| "Detail HTML contains richer fields (specialty, industry, seniority, …)" | **Confirmed, all 12 concept-listed fields, as structured JSON** rather than as scraped label rows. |

---

## ACQUISITION DECISION

**Selected modes: `http` for everything. `browser` retained for canary/fallback only. `api` is NOT adopted.**

This matches the modes `src/policies/hr-ge.ts` already allows (`['http', 'browser']`) — the spike's outcome is that no change to `allowedAcquisitionModes` is warranted, which is a decision backed by evidence rather than the placeholder it was before.

| Purpose | Mode | Entry point |
|---|---|---|
| Frequent discovery | `http` | `GET https://www.hr.ge/search-posting?pg=1` (and the first few pages) |
| Full-corpus reconciliation | `http` | `GET https://www.hr.ge/search-posting?pg=N` walked to the 404 terminator (33 pages today) |
| Sitemap cross-check (paid listings only, **not** the reconciliation oracle) | `http` | `GET https://api.p.hr.ge/public-portal/tenant/1/api/v3/seo/sitemap` |
| Detail fetch | `http` | `GET https://www.hr.ge/announcement/<id>/<slug>` |
| Canary / anomaly investigation | `browser` | Playwright, compared against the HTTP-derived coverage (concept §24.3) |

### Evidence for `http`

Every page this adapter needs is fully server-rendered, and returns its content to a plain GET with **no JS execution, no cookies, no session, and no WAF token**:

- `/search-posting` raw response: `HTTP 200`, `ng-server-context="ssr"`, 1.67 MB, **101 `/announcement/<id>` links present in the raw bytes** (100 real listings + the `/announcement/favorites` nav link). Identical to the 100 unique listing IDs the rendered browser DOM shows. There is no shell-then-hydrate gap to work around.
- Detail pages likewise: all 5 sampled returned `HTTP 200` with the complete announcement payload in the raw body.
- 46 consecutive unauthenticated `curl` GETs (43 to `www.hr.ge`, 3 to `api.p.hr.ge`) — including a full 33-page index walk — returned the expected status on every single request. No challenge, no 403, no 429.

### Evidence for rejecting `api`

The SSR transfer-state (`<script id="ng-state">`) reveals the exact upstream calls the hr.ge server made while rendering, including their URLs. Two are content endpoints:

- `POST https://api.p.hr.ge/public-portal/tenant/1/api/v3/announcement-search` — the listing/search endpoint
- `GET  https://api.p.hr.ge/public-portal/tenant/1/api/v3/announcement/<id>` — the detail endpoint

Concept §10.2 permits adopting an API only if "endpoint, completeness, stability, and permitted use are verified." Measured against that bar:

1. **Permitted use: fails.** A plain `GET` to `announcement-search` returns `HTTP 405 Method Not Allowed` (`application/problem+json`, `Server: Kestrel`) — it is POST-only with an undocumented request-body schema. Its CORS headers are `Access-Control-Allow-Origin: https://www.hr.ge` with `Access-Control-Allow-Credentials: true` — a single-origin, credentialed allow-list. That is a first-party SPA backend, not a public API, and nothing published by hr.ge documents or offers it. **Probing stopped at this point**; no POST was sent, since guessing a request body against an undocumented endpoint is neither read-only in spirit nor within a bounded spike.
2. **Stability: fails.** `api.p.hr.ge` is multi-tenant infrastructure shared with cv.ge, doctor.ge, chefs.ge, auto.ge and home.ge (tenant IDs 1/2/4/… in the app's own `assets/conf/api.json`), versioned only by a `v3` path segment with no public contract or deprecation policy. The app config also pins `appVersion: v4.0.2217`, i.e. the contract moves with frontend releases.
3. **It buys nothing.** This is the decisive practical point: **the API's own JSON response bodies are already embedded verbatim in the SSR HTML** that a plain, robots-allowed GET returns. The index page carries the full `announcement-search` response (`{ announcements: { items: [100 …], totalCount } }`) and each detail page carries the full `announcement/<id>` response (a 150-field object). The adapter gets identical structured data through the public, permitted, documented-by-robots.txt path. Adopting `api` mode would trade a supported access path for an unsupported one and gain zero fields.

Concept §5.2's instruction — "Do not lock production ingestion to an undocumented JSON API" — therefore stands unchanged, now for measured reasons rather than because the endpoint had not been found.

### Evidence for keeping `browser` as canary/fallback only

Nothing in the corpus required a browser. The two Playwright loads produced no listing data that the raw HTTP response did not already contain. `browser` stays authorized purely for concept §24.3's "Playwright-versus-HTTP coverage comparison" and for investigating anomalies (e.g. if the WAF ever does start challenging the HTTP fetcher).

---

## Hosts, robots, and rate limits

- **`https://www.hr.ge/robots.txt`** (fetched 2026-09-05, `HTTP 200`): `User-Agent: *` / `Allow: /`, no `Disallow`, **no `Crawl-delay`**, and one `Sitemap:` line pointing at `https://api.p.hr.ge/public-portal/tenant/1/api/v3/seo/sitemap`. Unchanged from Phase 0.
- **`https://api.p.hr.ge/robots.txt`**: **`HTTP 404`, zero-byte body** (`X-Cache: FunctionGeneratedResponse from cloudfront`). The sitemap host publishes no robots rules of its own. Under RFC 9309 an unavailable (4xx) robots.txt means no crawl restrictions, so nothing prohibits fetching the sitemap there — and `www.hr.ge`'s own robots.txt is what advertises that cross-host URL in the first place, which is the standard sitemap-protocol pattern.
- **An explicit rate limit is advertised in response headers** — this is new information Phase 0 did not have, and it is stronger than "no crawl-delay declared." `https://www.hr.ge/robots.txt` returned:

  ```
  Ratelimit-Limit: 20
  Ratelimit-Policy: 20;w=60
  Ratelimit-Remaining: 19
  Ratelimit-Reset: 60
  ```

  20 requests per 60-second window, i.e. **one request every 3 seconds**. The headers appeared on the `robots.txt` response (served by the Express edge layer) and not on the SSR page responses, so it is not certain the same bucket governs page fetches — but it is the only quantitative limit hr.ge publishes anywhere, and treating it as binding is the conservative reading. `src/policies/hr-ge.ts` now records `crawlDelaySeconds: 3` on that basis.

  **Resolved 2026-09-06 (measured, not inferred): the bucket does NOT govern SSR page responses.** A single `GET https://www.hr.ge/search-posting` with this project's own User-Agent returned `HTTP 200` carrying `Cache-Control: maxage=300, stale-while-revalidate=60, stale-if-error=300`, `Content-Encoding: br` and `X-Cache: Miss from cloudfront` — and **no `Ratelimit-*` header of any kind**. The first live bounded crawl the same day corroborated it: 101 sequential requests (1 index + 100 details) at the 3s delay, zero `429`s and zero failures. So `Ratelimit-Remaining: 0` cannot appear on a page response, and any design reasoning that assumed a 20-request budget against a ~33-page index does not hold in practice — see `docs/STATUS.md`'s live-run entry for what that resolved. Two caveats worth keeping: this is one probe from one IP at one moment, and the page path is CloudFront-cached (`maxage=300`), so a cache miss under different conditions may not behave identically. **`crawlDelaySeconds: 3` is deliberately left unchanged** — the measurement removes a constraint we assumed, it does not license going faster, and no evidence has been gathered about what rate this source actually tolerates.
- Serving stack, for context when reading failures: `www.hr.ge` is Express behind CloudFront (`X-Powered-By: Express`, `Via: … cloudfront.net`); `api.p.hr.ge` is Kestrel (ASP.NET Core) behind CloudFront.
- A `culture=ka` cookie is set on every page response. Not required for the response to be correct — all 43 cookieless GETs returned Georgian content — but worth sending explicitly if the adapter ever wants locale determinism (the same reasoning `src/adapters/jobs-ge/RECON_NOTES.md` applied to choosing `/ge/` over bare `/`).

---

## The sitemap — what it actually is

`GET https://api.p.hr.ge/public-portal/tenant/1/api/v3/seo/sitemap` → `HTTP 200`, `Content-Type: text/xml`, `Content-Encoding: zstd`, **5.38 MB decompressed**.

- **Format: a single flat `<urlset>`, not a sitemap index.** There are no child sitemaps to follow. One request gets the whole thing.
- **39,268 `<url>` entries total.**
- **No `<lastmod>` on any entry — zero occurrences in the whole document.** Only `<priority>` (39,268) and `<changefreq>` (39,256). So the sitemap offers **no incremental-change signal at all**; it is a pure membership list. Any "what changed since last time" logic has to come from elsewhere.
- Composition by first path segment: `customer/` 36,600 · `jobs/` 1,505 · **`announcement/` 1,075** · `jobs-in/` 77 · `search-posting` 4 · other 5. So ~93% of it is employer profile pages, and announcements are a small minority of the file.
- One entry points at a third host, `https://customer.hr.ge/customer/register`. Every other entry is `www.hr.ge`.
- Announcement entries look like:
  ```xml
  <url>
    <loc>https://www.hr.ge/announcement/491744/inglisurenovani-gayidvebis-agenti</loc>
    <priority>0.8</priority>
    <changefreq>weekly</changefreq>
  </url>
  ```
  The 1,075 announcement entries are exactly the 1,075 `changefreq=weekly` entries; everything else is `monthly`. Announcement IDs in the file span 487,920–492,400.

### The sitemap is a paid-listings feed, not a corpus index

Cross-referencing the sitemap's 1,075 announcement IDs against the 3,263 IDs recovered from the full 33-page index walk:

| | count |
|---|---:|
| Announcements in the index walk | 3,263 |
| Announcements in the sitemap | 1,075 |
| Index listings with `isPriority: true` | 1,073 |
| **`isPriority: true` ∧ in sitemap** | **1,073** |
| `isPriority: true` ∧ *not* in sitemap | **0** |
| `isPriority: false` ∧ in sitemap | **0** |
| In sitemap, not seen in the walk | 2 |

The correlation is exact, in both directions: **the sitemap contains every paid/priority announcement and no free one.** (The 2 unmatched sitemap IDs are the two the walk itself missed — see the pagination-shift race below — not counter-examples.)

**Consequence, and the single most important output of this spike:** concept §5.2's "the public sitemap … is useful for reconciliation" and §10.2's "Reconciliation: public sitemap" are **wrong for hr.ge as built today**. Reconciling against the sitemap would mean 2,190 free listings — 67% of the live corpus — appear absent on every single run, and concept §13's missing-streak logic would close all of them within `missingStreakThreshold` runs. This is precisely the mass-closure failure §10.2's own "Never infer mass closure from a single reduced or failed result set" exists to prevent, and it would be caused not by a failed fetch but by a perfectly healthy one.

The sitemap keeps a narrower, still-useful role: a cheap (one request) cross-check that can only ever *add* candidate IDs, never remove them, and a way to spot paid listings the index walk raced past.

---

## Discovery: `/search-posting?pg=N`

- Pagination is real, ordinary `<a href>` markup, and **present in the raw SSR HTML** (Phase 0's "no ordinary pagination links" appears to have been a search for `page=`/`?p=` — hr.ge's parameter is `pg=`):
  ```html
  <a class="item ng-star-inserted"
     href="https://www.hr.ge/search-posting?os=false&amp;w=false&amp;ef=null&amp;et=null&amp;we=false&amp;ee=false&amp;pg=2"> 2 </a>
  ```
- **`?pg=N` alone is sufficient.** The other six parameters are the filter form's defaults; `GET /search-posting?pg=2` bare returns the same full page. Recommend the crawler use the bare `?pg=N` form and never replicate the filter parameters — same reasoning as jobs.ge's "use the plain GET, not the scroll POST."
- **100 listings per page.** Page 1 and page 2 shared zero announcement IDs.
- **Terminal page is 33** (65 listings) → 32 × 100 + 65 = **3,265**, matching the payload's own `totalCount: 3265` exactly. Two independent measures agree.
- **Out-of-range pages return a real `HTTP 404`** — `?pg=34` returned status 404. This is much better than jobs.ge's clamp-to-last-page behavior and needs none of the confirmation-probe machinery `src/adapters/jobs-ge/crawl.ts` had to grow. **But the 404 body is a soft-404**: it is a fully-rendered search page, `ng-server-context="ssr"`, with intact chrome, a valid `ng-state`, and the correct total count — just zero listing rows. Never judge the terminator by body shape alone; the status code is the signal, and "zero rows on a 200" is a separate anomaly, not a terminator.
- **`totalCount` is a free completeness oracle.** Every index page's `ng-state` carries `announcements.totalCount` for the whole corpus, and the rendered page prints it too ("ნაპოვნია 3265 განცხადება" — "3265 announcements found"). A run can compare what it actually collected against what the source itself claims exists, on the same response — a much stronger health check than jobs.ge's fixed floor and historical-ratio guards.
- **Ordering** is by `renewalDate ?? publishDate`, descending. Across the walk that key ran from `2026-09-05T12:29` down to `2026-08-07T09:43`. Note it is the *renewal* date that sorts, not the publish date — a renewed listing jumps back to the top.
- **Discovery is complete via the index.** The 33-page walk recovered 3,263 of the 3,265 announcements the source itself claims. No "load more" button, no infinite-scroll XHR, no hidden page-size parameter is needed.

### Pagination-shift race — real, observed, must be designed around

The walk found 3,265 rows but only **3,263 unique** IDs. IDs `489296` and `489401` appeared on **both page 19 and page 20**.

This is offset pagination over a live, mutating, date-ordered list: during the ~2.5 minutes the walk took, two listings above that boundary were renewed or withdrawn, shifting everything below them down by two — so two items were served twice, and by the same mechanism **two other items were pushed up across a boundary the walk had already passed and were never seen at all.** That is exactly the 2-item gap against `totalCount`, and the 2 sitemap IDs the walk "missed."

For the implementation pass this means: a single index walk is **not** a reliable membership snapshot, and closure logic must never treat one walk's absence as evidence a listing is gone. Concept §13's missing-streak requirement already handles this correctly provided the threshold stays ≥ 2 — but it is now a measured property of this source, not a theoretical concern. The `totalCount`-versus-collected comparison should tolerate a small delta (a handful of items) rather than demanding exact equality.

---

## Server-rendered HTML versus browser-required

**Fully server-rendered. No browser needed anywhere.** Verified by comparing the raw HTTP body against the live DOM for `/search-posting`:

| | raw HTTP GET (no JS) | rendered browser DOM |
|---|---:|---:|
| Unique `/announcement/<id>` links | 100 | 100 |
| Pagination links (`?pg=`) | present | present |
| `totalCount` available | yes (`ng-state`) | yes |

The browser adds only third-party chrome — Google Tag Manager / Analytics / DoubleClick, the AWS WAF SDK, and two ancillary `api.p.hr.ge` XHRs (`refresh-favorites`, `get-banners`). **Neither ancillary XHR carries listing content**, which independently re-confirms Phase 0's observation on that specific point.

### The `ng-state` JSON island — the recommended parse target

Every page (index, detail, and even the 404) embeds:

```html
<script id="ng-state" type="application/json"> … </script>
```

This is Angular's `TransferState`. It holds the verbatim JSON bodies of the HTTP calls the SSR server made, keyed by a request hash, each entry shaped `{ b: body, h: headers, s: status, st: statusText, u: url, rt: responseType }`. The `u` field is how the API endpoints above were identified without ever calling them.

**Parse it with plain `JSON.parse`. Do not pre-decode HTML entities.** Verified against all 8 fixtures: the island's text parses directly, with zero preprocessing.

> **Correction (recorded 2026-09-05, same day):** an earlier revision of this document claimed the island was escaped with a non-standard abbreviated entity set (`&q;` `&a;` `&l;` `&g;` `&b;` `&n;` `&f;`) that had to be decoded before `JSON.parse`. **That was wrong** — an assumption carried over from how Angular's transfer-state serializer behaves in other setups, never actually tested. It went unnoticed because the extraction script used during this spike applied that decode chain *and* the chain was a silent no-op: those sequences occur exactly **0** times in all 8 fixtures, so removing every replacement changes nothing. Caught when the pre-commit Codex gate ran its own probe over the fixtures and reported `directRawJson: true, entities: 0`, then confirmed independently. Same class of mistake as the one `src/adapters/jobs-ge/RECON_NOTES.md` records for 2026-09-04: a validation step that passed for the wrong reason. None of the field findings in this document were affected — they were all read from successfully-parsed JSON.

What the escaping actually is:

- `<` is escaped as a `\u` sequence with **uppercase** hex digits — `backslash-u-0-0-3-C` (uppercase `C`, not `c`) — which is an ordinary JSON string escape that `JSON.parse` handles natively. Worth spelling out because a grep for the lowercase form finds nothing and can be misread as "no escaping at all"; that is exactly the wrong turn taken above.
- `>` and `&` are left literal.
- Sequences like `&#4322;`, `&nbsp;`, `&quot;` and `&ldquo;` do appear, but they belong to the `description` field's **own HTML content** and are part of the value, not part of the transport encoding. They must be decoded at the point the description is rendered or text-extracted — **never before `JSON.parse`**. Running an entity decoder over the island first would corrupt exactly these, which is why the mistaken instruction above was worse than merely redundant.

A defensive parser should still treat a `JSON.parse` failure as typed structural drift and quarantine rather than continue — Angular's serializer escapes more aggressively when a payload contains sequences that would break out of the `<script>` tag, and no sample here happened to contain one.

Locating the right entry must be done **by the `u` field**, never by the numeric key — the keys are content hashes and differ per page (e.g. the detail payload is under `1783228479` on announcement 492368 but `3130852348` on 491887). Match `u` against `/api/v3/announcement-search` for index pages and `/api/v3/announcement/<digits>$` for detail pages.

Recommendation: **parse the JSON island as the primary source and treat the DOM as the fallback/cross-check**, not the other way round. It yields typed values (real ISO timestamps, numeric salaries, enum codes, arrays) where the DOM yields Georgian label text that would have to be reverse-mapped. The DOM is still worth a structural assertion or two so that a silent island removal is caught rather than producing an empty parse.

---

## Detail pages

URL shape is `/announcement/<numeric-id>/<slug>` exactly as Phase 0 recorded. 5 pages sampled, chosen for structural distinctness (all 5 are in `fixtures/`).

Every one of the twelve concept-listed fields is present, as structured JSON:

| Concept field | JSON path | Example value observed |
|---|---|---|
| specialty | `announcementRequirements.specializationList[]` (nested `children[]`, each with `specializationId` + numeric `code` + `name`) | `ბუღალტერია / ფინანსები` → `ბიუჯეტირება და პროგნოზირება`, `ფინანსური ანალიზი` |
| industry | `announcementRequirements.industryList[]` (same nested shape, `advancedIndustryId`) | `მშენებლობა` → `მშენებლობა` |
| seniority | `announcementRequirements.seniorityLevels[]` | `საწყისი რგოლი` / `საშუალო რგოლი` / `უფროსი რგოლი` |
| employment form | `announcementRequirements.employmentTypeName` | `ვადიანი კონტრაქტი` |
| schedule | `announcementRequirements.workScheduleName` | `სრული განაკვეთი`, `სმენური გრაფიკი – დღის ცვლა` |
| work mode | `employmentFormTypeName`, plus boolean `isWorkFromHome` | `ოფისიდან/სამუშაო ადგილიდან` |
| experience | `workExperienceType` (enum), `workExperienceFrom` / `workExperienceTo` (years) | `1` + `from: 3` → "3 years and up"; `3` appears to mean "not required" |
| education | `employerRequirements.educationLevels[]`, `employerRequirements.educationPrograms` | `["ბაკალავრი","მაგისტრი","დოქტორი"]` |
| languages | `languages[]` | `["ინგლისური","რუსული"]` |
| location | `addresses[]` (city strings) and `extendedLocations[]` (structured, multi-level, with `isWithHiddenLocation` / `isWithInCompleteLocation`) | `["თბილისი"]` + street-level parts |
| salary | `salaryFrom` / `salaryTo`, plus `bonusFrom` / `bonusTo`, `isWithBonus`, `hideSalary`, `showSalary` | `960`–`1900`; `800` with bonus `400`; or `null`/`null` |
| application method | `applicationMethod` (enum) + `applicationDetails{ email, phoneNumber, websiteUrl, applicationUrl, applicationAddress, recipient, forwardApplicationsToEmail }` | see below |

Also present and directly relevant to other parts of the concept: `benefits[]` (§15 taxonomy input), `hasAttachment` / `attachmentUrl` (§16 — the field exists, though all 5 samples had `hasAttachment: false`), `drivingLicenses[]`, `isSuitableForStudent`, `similarAnnouncements[]`, `expired`, `publishStatus`, and `description` (an HTML string, entity-encoded, 2.3 KB–24 KB across the sample).

### `applicationMethod` is a clean 3-value enum — confirmed against all 5 samples

| value | meaning | how to read it | corpus share (3,265) |
|---:|---|---|---:|
| `1` | apply by email | `applicationDetails.email` populated | 2,198 (67%) |
| `2` | apply on hr.ge itself (internal "send CV") | `applicationDetails` entirely null — the method *is* the absence | 60 (2%) |
| `3` | apply at an external URL | `applicationDetails.applicationUrl` populated | 1,007 (31%) |

Observed `applicationUrl` values were third-party ATSes: `https://careers.evolution.com/georgia/turkish-speaking-gp/`, `https://cleverstaff.net/i/vacancy-CCWXHQ`.

This is far cleaner than jobs.ge, where application method had to be inferred from links inside free text and where unrelated sidebar/ad links were an active trap (`src/adapters/jobs-ge/RECON_NOTES.md`). Here it is an explicit field. **Do not go looking for `<a href>`s on hr.ge detail pages** — the enum plus `applicationDetails` is the whole answer, and scraping links would reintroduce jobs.ge's problem for no gain.

### Dates: hr.ge has NO yearless-date problem

This is the other clear improvement over jobs.ge. Both forms are present on every detail page:

- `dates: "04 სექ - 20 სექ"` — the yearless Georgian display string, same shape as jobs.ge's.
- `publishDate: "2026-09-04T17:10:06.807"` and `deadlineDate: "2026-09-20T23:59:00"` — full ISO-8601 timestamps **with the year**.

**Use the ISO fields.** `src/adapters/jobs-ge/dates.ts`'s `parseYearlessGeorgianDate` and its whole year-inference heuristic are unnecessary here and must not be reused — inferring a year when the source states it outright would be strictly worse. Timestamps are local Georgian time (the app config declares `timeZone: "GMT+4"`, i.e. Asia/Tbilisi) and carry no offset suffix, so they must be interpreted as Asia/Tbilisi, not UTC.

**Gotcha:** the display string's start date is **not** the publish date when a listing has been renewed. Announcement 490978 shows `dates: "05 სექ - 25 სექ"` with `publishDate: 2026-08-27` and `renewalDate: 2026-09-05` — the rendered string uses the renewal date. Another reason to take the ISO fields and ignore the display string entirely.

### Privacy: hidden contact fields leak into the JSON island

All 5 samples had `hideContactPerson: true`, and correspondingly the recruiter's name, personal email, and personal mobile number are **not rendered anywhere in the visible page** — but they *are* present in the `ng-state` island. Verified directly on announcement 492368: `contactName`, `contactEmail` and `contactMobilePhoneNumber` appear only inside the island, while `applicationDetails.email` (the address the listing genuinely publishes for applying) appears in both the island and the rendered body.

**Requirement for the implementation pass:** the parser must honor `hideContactPerson` and the `show*` flags (`showSalary`, `showEducation`, `showLanguages`, `showWorkExperience`, `showDrivingLicenses`, `showTargetAudience`, `showDuration`) and must not persist a field the source has flagged as suppressed. Ingesting personal contact details that hr.ge deliberately withholds from its own users would be a privacy regression the source itself did not consent to, and would put personal data into `source_listing_revisions` where §23.3's retention rules have not even been set yet (`retention.rawHtmlRetentionDays` is still `null`).

Note the flags are *not* redundant with emptiness: announcement 491887 has `salaryFrom: 800` with `showSalary: true`, while 492350 has `salaryFrom: null` with `showSalary: false` — but nothing guarantees a populated-but-hidden combination cannot occur, and the flag is the source's stated intent.

**The committed fixtures are redacted accordingly**: the five hidden `contactName` / `contactEmail` / `contactPhoneNumber` / `contactMobilePhoneNumber` values were replaced with same-shape placeholders (`REDACTED CONTACT NAME`, `redacted.contact@example.invalid`, `+995500000001`…). Every JSON path, selector and field-presence assertion stays valid; only the personal values differ from the live bytes. Public application addresses (`applicationDetails.email`, `applicationDetails.applicationUrl`) were **not** redacted — the parser must extract those, and they are published by the source for exactly that purpose. This is a deliberate, documented divergence from live bytes, unlike the accidental corruption jobs-ge recorded.

### `listingSection` and `isPriority`

`listingSection` is a 5-value display-tier enum across the corpus: `4` (1,347), `7` (1,187), `5` (358), `1` (343), `-1` (30). On detail pages, `1` renders the badge `ვიპ` ("VIP") and `-1` renders `ვიპ CV` ("VIP CV"). Tier `7` is exclusively non-priority.

It is **not** a VIP/standard partition in jobs.ge's sense — there is no separate DOM container, and every tier appears interleaved in the same ordered list. `isPriority` (1,075 true / 2,190 false) is the meaningful boolean, and it is the flag that exactly determines sitemap membership. The precise product meaning of each `listingSection` value is **still open** and was not worth more browser budget; it is display metadata, not something the domain model needs today.

---

## WAF / challenge signature

**No challenge, interstitial, CAPTCHA, login wall, or block was encountered at any point** across 46 requests. Nothing was bypassed because nothing had to be. What follows is the infrastructure signature, recorded so a later typed-failure detector has something concrete to key on — not a description of an observed failure.

Confirmed present:

- The app's own config declares `wafConfig: { isEnabled: true }` (in the `assets/conf/api.json` payload carried in `ng-state`).
- AWS WAF's browser SDK is integrated at `https://18ec8539714f.edge.sdk.awswaf.com/18ec8539714f/724bf2edfe2e/`, with endpoints `challenge.js`, `inputs`, `mp_verify`, and `telemetry`. In the browser these fire on every load and all returned `200`.
- The browser session acquired an `aws-waf-token` cookie. **Plain HTTP GETs never needed one** — all 43 cookieless `curl` requests to `www.hr.ge` succeeded.

**Trap for whoever writes the detector — do not key on the string `awswaf`.** The `challenge.js` script tag from `edge.sdk.awswaf.com` is embedded in **every healthy 200 page**, including all 8 committed fixtures. A naive "body mentions awswaf ⇒ challenged" check would flag 100% of normal responses. A real AWS WAF challenge/CAPTCHA response is distinguished by status (`202`, `403`, or `405` with `x-amzn-waf-action`), by the absence of `ng-server-context="ssr"`, and by the absence of an `ng-state` island — not by the SDK's mere presence.

Because no genuine challenge body was captured, `fixtures/` contains **no** blocked/CAPTCHA fixture. Concept §24.2 asks for one; it remains **outstanding** and cannot be honestly produced without either provoking a block (out of scope, and explicitly not to be attempted) or hand-authoring a synthetic one. Recommend hand-authoring a synthetic AWS-WAF-shaped fixture in the implementation pass and labelling it clearly as synthetic.

The genuinely-captured negative-path fixture that *does* exist is `search-posting-pg34-out-of-range-404.html` — a real `HTTP 404` whose body is a complete, healthy-looking SSR page with zero listing rows. That is the more realistic and more dangerous case anyway: a 200-shaped body behind a non-200 status.

---

## Fixtures

`fixtures/`, 8 files, ~8.3 MB raw (≈1 MB packed — they share large identical boilerplate and delta-compress well). All captured 2026-09-05 via plain HTTP GET. All verified raw HTML (`<`-leading) with a re-parseable `ng-state` island.

| File | HTTP status | Why this one |
|---|---:|---|
| `search-posting-pg1.html` | 200 | Index page 1 — 100 listings, pagination markup, full `announcement-search` payload, `totalCount` |
| `search-posting-pg33-last.html` | 200 | Terminal page — partial (65 listings), the "last real page" case |
| `search-posting-pg34-out-of-range-404.html` | **404** | Out-of-range page — real 404 status, healthy-looking soft-404 body, zero rows |
| `detail-492368-email-application.html` | 200 | `applicationMethod: 1` (email), no salary, benefits present, `listingSection: 1` |
| `detail-491887-onsite-application-salary-bonus.html` | 200 | `applicationMethod: 2` (apply on-site, `applicationDetails` all null), salary 800 + bonus 400, `showSalary: true`, `listingSection: -1`, longest description (24 KB) |
| `detail-490978-external-ats-renewed.html` | 200 | `applicationMethod: 3` (external ATS), **`renewalDate` set** so the display string disagrees with `publishDate`, salary range 960–1900, shift-work schedule |
| `detail-490225-anonymous-employer.html` | 200 | **`isAnonymous: true`** employer, `applicationMethod: 2`, salary floor only |
| `detail-492350-external-ats-experience-required.html` | 200 | `applicationMethod: 3`, **experience required** (`workExperienceType: 1`, `workExperienceFrom: 3`), multi-address location, richest `benefits[]`, seniority `უფროსი რგოლი` |

Not captured, and needed later: a blocked/CAPTCHA response (see above), an announcement with `hasAttachment: true` (none in the sample of 5 — the field exists but no example was found), and a listing in the `en` locale.

### Line-ending hazard found while committing these — fixed for hr-ge, still open for jobs-ge

This repo's `.gitattributes` opens with `* text=auto`, and the developer machine has `core.autocrlf=true`. Under those two rules together a captured HTML fixture is stored LF-only in the repo but **checked out CRLF on Windows and LF on Linux CI** — so the same fixture file is a different sequence of bytes in the two places.

That is harmless for a whitespace-tolerant DOM parse, which is why `src/adapters/jobs-ge/fixtures/` has lived with it unnoticed (its committed blobs are LF-only; the working-tree copies on Windows are CRLF, with CR counts exactly matching LF counts). It is **not** harmless here: this project hashes fixture-derived content into `meaningfulContentHash` and pins golden parser output per §24.2, so a CRLF/LF split would make identical fixtures hash differently locally versus on CI.

Fixed for this adapter by adding `src/adapters/hr-ge/fixtures/** -text` to `.gitattributes`, which disables line-ending translation entirely for these files. Verified: every committed blob is byte-for-byte identical to the file on disk.

**Recommended, not done:** the same rule for `src/adapters/jobs-ge/fixtures/`. Deliberately left alone — applying it would rewrite those files' working-tree bytes and revalidating jobs-ge's golden assertions is outside Phase 1B's scope. Worth doing in a small dedicated change.

---

## Implementation plan for adapter code

Written as a handoff, not as code. Reuse the source-agnostic write path exactly as jobs.ge does — **`src/db/ingest.ts` and `src/db/write-source-listing-revision.ts` must not be duplicated, forked, or hr.ge-specialized.** They already take domain-shaped input; hr.ge is a second caller, not a second implementation. `expireOverdueListings` / `closeMissingListings` / `closeMissingListingsInTransaction` in `src/db/reconcile-source-listings.ts`, and the `startCrawlRun` exclusivity lock, likewise apply unchanged.

### `ng-state.ts` — shared JSON-island extractor

Factor this out first; all three of discovery, detail, and the health check need it.

- Extract `<script id="ng-state" type="application/json">…</script>` and `JSON.parse` its text **directly** — no entity pre-decoding, which would corrupt the `description` field's own `&#NNN;` / `&nbsp;` / `&quot;` content (see the correction above; this is the one instruction in this document that was wrong in an earlier revision).
- Expose a lookup **by the entry's `u` (URL) field**, never by numeric key.
- Throw a typed structural error when the island is absent or unparseable — that is real drift and must quarantine, not silently yield an empty result. This is the same lesson as jobs-ge's ninth review pass (a parser that degrades quietly promotes a bad revision).

### `discovery.ts`

- Parse one `/search-posting?pg=N` page: pull the `announcement-search` entry's `announcements.items[]` and `announcements.totalCount`.
- Per item, return `announcementId`, title, `renewalDate ?? publishDate`, `deadlineDate`, `isPriority`, `listingSection`, and the policy-checked detail URL. The slug is not needed for identity (see identity note below) but is available from the sitemap and from the DOM anchors.
- **Stop condition: `HTTP 404`.** No clamp-confirmation probe is needed (unlike jobs.ge) — but keep a `MAX_DISCOVERY_PAGES` safety cap regardless, and treat "200 with zero rows" as an anomaly that leaves the walk incomplete, never as a terminator.
- Cross-check collected unique IDs against `totalCount` from the same responses. Allow a small tolerance (the observed pagination-shift race cost 2 of 3,265); a large shortfall means `complete: false`.
- A DOM-level assertion that pagination anchors (`a[href*="pg="]`) exist is a cheap guard against the island being served without the rest of the page.

### `sitemap.ts`

- One GET, `text/xml`, zstd-encoded — make sure the HTTP fetcher negotiates and decodes `zstd` (`src/net/http-fetcher.ts` uses undici; confirm it advertises zstd, and fall back to `gzip`/`br` if not, rather than silently receiving compressed bytes).
- Stream/parse the flat `<urlset>`; filter `<loc>` to `/announcement/<id>/` and extract the numeric ID. Ignore `customer/`, `jobs/`, `jobs-in/`.
- There is no `<lastmod>` — do not build anything that expects one.
- **Wire it as an additive cross-check only.** It must be able to *introduce* candidate IDs the index walk missed; it must never contribute to absence, missing streaks, or closure. Given the 33%/paid-only bias measured above, wiring it as a reconciliation oracle is the one design mistake that would do real damage. Suggest encoding that in the function's own contract (return "candidate IDs", never "the current membership set") so a future caller cannot misuse it the way `closeMissingListings` was hardened against caller-supplied claims in Phase 1A.
- Cadence: infrequent (concept §19.2's 6–24 h row), and skippable — it is 5.4 MB for ~2 extra listings on a healthy day.

### `detail.ts`

- Locate the `/api/v3/announcement/<id>` island entry by `u`, read `data.announcement`.
- Map the field table above. Take **ISO** `publishDate` / `deadlineDate` / `renewalDate`, interpreted as Asia/Tbilisi; ignore the `dates` display string. Do **not** reuse `src/adapters/jobs-ge/dates.ts`.
- Application method from the `applicationMethod` enum + `applicationDetails`; do not scan `<a href>`s.
- **Honor `hideContactPerson` and every `show*` flag** — suppressed fields are stored as unknown, not as their leaked values (see the privacy section; this is the one non-negotiable in this plan).
- Structural throws (quarantine-worthy), following jobs-ge's precedent of throwing on *absent structure*, never on an empty value: island missing, `data.announcement` missing, `announcementId` missing or not matching the requested ID. Everything else — `salaryFrom: null`, `education: null`, empty `benefits[]` — is a legitimate unknown per §6.2 and must not throw. All five sampled pages had `education`, `experience`, `categories`, `targetAudience` and `duration` as bare `null` at the top level while the real values lived under `employerRequirements` / `announcementRequirements`; a parser that required the top-level ones would quarantine the entire corpus.
- Pin a `HR_GE_DETAIL_PARSER_VERSION` and assert golden values against all 5 fixtures, per §24.2.
- The `description` field is entity-encoded HTML from an untrusted source (§23.1) — sanitize or store raw-but-never-rendered; do not interpolate it anywhere.

### `challenge.ts` — typed failure detection

- Classify a response as challenged on: status `202`/`403`, an `x-amzn-waf-action` header, or `Server`/body markers inconsistent with the normal Express+CloudFront SSR shape.
- Positive health markers to require on a supposedly-good page: `ng-server-context="ssr"` present **and** a parseable `ng-state` island.
- **Never key on the presence of `awswaf` / `challenge.js`** — present on every healthy page (see the trap above).
- On classification: back off, record a typed fetch attempt, never retry aggressively, never attempt to solve. Feed it into the existing `recordParserIncident` / `quarantineSourceListing` machinery rather than inventing a parallel path.
- Treat `429` and `Ratelimit-Remaining: 0` as first-class backoff signals given the published `20;w=60` policy.

### `crawl.ts`

Mirror `src/adapters/jobs-ge/crawl.ts`'s structure and reuse its hard-won guards; the source-specific differences are small:

- Seed `sources`/`source_policies` rows idempotently (jobs-ge's `ensureJobsGeSourceSeeded` equivalent).
- `startCrawlRun` → walk `?pg=N` to the 404 → fetch each detail page → `writeSourceListingRevision` → settle inside one transaction, exactly as jobs-ge does post-review.
- Health gates: keep the quarantine-rate and fetch-failure-rate guards, and **add a `totalCount`-versus-collected gate**, which is stronger than jobs-ge's fixed floor / historical-ratio pair because the source states the expected number on the same response. Consider retiring the fixed floor for hr.ge in favour of it, but keep the relative-coverage-against-history guard as defense-in-depth against `totalCount` itself collapsing.
- Drop the per-partition VIP/standard collapse guard — hr.ge has no such partition. If an equivalent is wanted, `isPriority` true/false counts are the natural analogue and are already known per item.
- Cadence per §19.2: frequent discovery can poll only the first page or two (ordering is `renewalDate ?? publishDate` descending, so new and renewed listings surface at the top); full 33-page reconciliation nightly. At the published 3 s/request, a full walk is 33 index + ~3,265 detail fetches ≈ **2.8 hours** — comfortably nightly, and the same "don't schedule it hourly" lesson jobs-ge learned applies.

### Identity and policy notes

- Canonical URL: `/announcement/<id>/<slug>`. **The slug is decorative** — it is derived from the title and would change if a title were edited, so `announcementId` alone is the identity key. Store the full slugged URL as `originalUrl`/`canonicalUrl` per §11, but never key identity on the slug.
- `isHrGeUrlAllowed`-style enforcement is needed, mirroring `isJobsGeUrlAllowed`: `isPathAllowed` alone cannot express the `?pg=<digits>`-only query shape for `/search-posting`, nor reject a same-path URL on another origin. Authorize `/search-posting` with no query or exactly `?pg=<positive digits>`, and `/announcement/<digits>/<slug>` — and keep the existing `/announcement/favorites` disallow, which is what stops the nav link the index page carries from ever being fetched.
- **Recommended schema change, NOT made here.** `SourcePolicySchema` (`src/domain/source.ts`) models exactly one host implicitly, via `Source.baseUrl`, and offers only path allow-lists plus a `disallowedHosts` deny-list. It has **no positive host allow-list**, so `api.p.hr.ge` (the sitemap host) cannot be authorized in the record at all — `allowedPathPatterns` would authorize the sitemap's *path* while the origin check in any `isHrGeUrlAllowed` would have to hard-code the second host outside the policy. That is the gap `src/policies/hr-ge.ts`'s notes already flagged as "not yet modeled," and it is now concrete rather than hypothetical. Suggested fix, for the implementation pass to make deliberately: add an `allowedHosts: z.array(z.string()).min(1)` field to `SourcePolicySchema`, defaulting to the `baseUrl` host for existing records, and have the per-source URL guards check membership. Deliberately **not** done in this spike — a schema change touches jobs.ge's already-merged, already-reviewed policy record and belongs with the code that consumes it, not with reconnaissance notes.

---

## Still open

- No genuine WAF/challenge response body captured (never provoked one). §24.2's blocked/CAPTCHA fixture is outstanding — recommend a clearly-labelled synthetic one.
- No `hasAttachment: true` example found in the 5-page sample. The field exists; §16's attachment handling has no real specimen yet.
- Exact product semantics of `listingSection`'s five values (1, 4, 5, 7, -1) — display metadata, not needed today.
- `workExperienceType` enum: `1` = "from N years" and `3` = "not required" are inferred from two data points, not confirmed against a documented mapping.
- ~~Whether the `Ratelimit-Policy: 20;w=60` bucket observed on `robots.txt` also governs SSR page responses.~~ **Answered 2026-09-06: it does not** — page responses carry no `Ratelimit-*` headers, confirmed by direct probe and by a 101-request live crawl with zero `429`s. See "Hosts, robots, and rate limits" above. The policy keeps `crawlDelaySeconds: 3` regardless, since nothing was learned about what rate the source tolerates.
- The `en` locale (`/en/…`, `alternativeLanguage: "en"` in the site config) was not inspected at all. Georgian is the default and is what this adapter will crawl; noted only so it is a known omission rather than an oversight.
- Terms of service still unreviewed (`termsUrl` remains `null` in the policy), so §23.3's link-don't-republish default still stands.
