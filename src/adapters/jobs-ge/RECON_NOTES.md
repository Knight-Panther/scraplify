# jobs.ge reconnaissance notes (Phase 1A, M1)

Read-only reconnaissance against the live site via Playwright, 2026-09-03. No sign-in, upload, submit, or send performed — plain GETs and DOM/network inspection only, paced with delays between requests (site policy: `Crawl-delay: 5`, confirmed in `src/policies/jobs-ge.ts`). This file is the durable record; treat entries here as "confirmed 2026-09-03" the same way `src/policies/jobs-ge.ts`'s existing comments are dated.

Open items from this file still need to land in `src/policies/jobs-ge.ts` (URL authorization) and `docs/STATUS.md` (exit-gate checkboxes) — not done yet as of this writing.

**Correction (2026-09-04):** the 5 fixture files saved under `fixtures/` at capture time were accidentally written as JSON-escaped strings (literal `\"`, `\n`, `\t`, wrapped in an outer pair of `"` — consistent with `JSON.stringify(pageContent)`'s output being saved directly instead of the decoded page text) rather than raw HTML. This went undetected because nothing had actually run an HTML parser against them yet — string-search-based validation (e.g. counting `id=` occurrences) still worked by coincidence, since it doesn't care about real vs. escaped quote/whitespace characters. Caught when `src/adapters/jobs-ge/discovery.ts`'s cheerio selectors matched zero rows against the real files despite passing on equivalent synthetic HTML. All 5 files were re-decoded with `JSON.parse` and rewritten in place; the counts and structural findings recorded elsewhere in this document were unaffected (they were observed live, not derived from the corrupted files).

## URL space

- **Three locale-prefixed paths serve identical listing content for the same `id`**: bare `/`, `/ge/` (explicit Georgian), `/en/` (English translation of UI chrome + same listing, at least for the one sample checked — title translated, e.g. "მიმტანი" -> "Waiter"). No redirect occurs between them; each renders directly.
  - **Recommendation for the canonical crawl path: use `/ge/` explicitly**, not bare `/`. Bare `/` behaves identically today but its locale could plausibly depend on `Accept-Language`/cookies in ways `/ge/` doesn't — `/ge/` is the safer, explicit choice for a fetcher that needs deterministic output every time. This also matters for `resources.canonicalUrl` identity (§11): pick one locale path as canonical so the same real listing doesn't get stored 2-3 times under different resource rows.
  - `isJobsGeUrlAllowed` in `src/policies/jobs-ge.ts` **does not yet authorize `/ge/` or `/en/`** — as built in Phase 0 it only allows exact path `/`. This needs to be fixed before any real fetcher can request the canonical path. Not yet fixed as of this note.
- **The real browse/listing page is `/ge/ads/`**, not just the homepage (`/ge/` alone also happens to show the same first-page content, but `/ge/ads/` is the page with the actual search/filter form and is the one that responds to `?page=N`). Use `/ge/ads/` as the discovery entry point, not the bare homepage.
- **Employer/organization profile pages**: `?view=client&client=<slug>` — e.g. `/ge/?view=client&client=adjara-group-hospitality`. Roughly one per employer with active listings; maps to the `ORGANIZATION` resource role already in the schema (`src/db/schema/resources.ts`). Not yet fetched/inspected — flagged for later, not required for M1's job-listing vertical slice.
- Listing identity confirmed exactly as Phase 0 already encoded: `?view=jobs&id=<numeric>`.

## Pagination

- `/ge/ads/` has a real GET-based search form: `page` (hidden, drives pagination), `q` (free text), `cid` (category), `lid` (location), `jid` (announcement type), plus checkboxes `in_title`, `has_salary`, `is_ge`.
- `?page=N` works as a **plain GET** and returns full server-rendered HTML — confirmed by direct navigation to `page=1`, `page=2`, `page=20`, `page=50`, all returning real (differing, for 1/2/20) content.
- **Infinite scroll on the live page is the same underlying mechanism**, not a separate API: scrolling fires `POST /ge/ads/?page=2&q=&cid=0&lid=0&jid=0&in_title=0&has_salary=0&is_ge=0&for_scroll=yes` (confirmed via network inspection). Recommend the crawler use the simpler plain `GET /ge/ads/?page=N` form directly rather than replicating the scroll-triggered POST — both appear to return equivalent listing data, and GET is simpler and more clearly "just walking pages" for a source-compliant fetcher.
- **Pagination depth confirmed by bisection**: pages 1-18 each return a full, distinct 300-row page, monotonically decreasing by ID (page 8 top/bottom `747741`/`747375`, ... page 18 `743033`/`742435`). **Page 19 is the true last page** (247 rows) — pages 20, 21, and 50 all return byte-identical content to page 19 (site clamps out-of-range page numbers rather than erroring or going empty). Total currently-listed items: 18×300 + 247 = **5,647**.
  - **Anomaly, not fully explained**: page 19's 247 rows span from `742434` down to `679178` — a ~63,000-ID gap, wildly out of step with the roughly-7,500-IDs-per-month pace seen on pages 1-18. Either a small number of very long-lived ("evergreen") listings sit at the tail regardless of age, or the ordering isn't purely ID/date-descending at the boundary. **Not resolved — flag for whoever designs M5's incremental-overlap/high-water-mark logic**, since it means the "cleanly date-descending" observation above holds for the bulk of the range but not provably at the very tail.
  - Practical upshot for an initial backfill: this is a bounded ~5,600 items, not tens of thousands — a full backfill of current listings is feasible, not just an incremental go-forward crawl.
- Each standard page held ~300 unique listings (`#job_list_table`).

## VIP vs. standard partition

- Confirmed as a **clean, structurally disjoint split** on `/ge/ads/` (and the homepage, which shows the same thing): a `.vipEntries` div holds VIP listings, a separate `#job_list_table` holds standard listings. On the samples pulled, 10 VIP IDs and 300 standard IDs, **zero overlap** between the two sets.
- The standard `#job_list_table` section appears **cleanly ID/date-descending** across page boundaries (e.g. page 2 ran 749719, 749716, 749715, 749714, 749712 — tightly sequential) — this is good evidence for §27's open question: **a VIP-independent, date-ordered view does exist** (the standard section itself), so the incremental "rolling overlap window" walk (concept §10.1) can likely just walk `#job_list_table` across `?page=N` and treat `.vipEntries` as a separate, small, always-check-in-full partition each run (10 items — cheap to fully re-check every time rather than needing incremental logic for it at all).
- VIP entries are believed to rotate/be promotional (not confirmed whether they're time-limited or how); not yet compared across two points in time to confirm rotation behavior.

## Filters — resolves part of §27

- `cid` (15 categories: Administration/Management, Finance/Statistics, Sales, PR/Marketing, General Technical Staff, Logistics/Transport/Distribution, Construction/Repair, Cleaning, Security, IT/Programming, Media/Publishing, Education, Law, Medicine/Pharmacy) and `lid` (14 Georgian regions + Tbilisi + Foreign + Remote) both default to "all" (blank/`0`) on the unfiltered `/ge/ads/` page — **the default unfiltered walk already includes every category and every location**. No evidence category/location filters are needed for *discovery completeness*; they look like pure user-facing narrowing tools, redundant for a crawler that wants everything.
- `jid` (announcement type) is different and matters: options are "ყველა ვაკანსია" (all/blank — the unfiltered default), `1`=ვაკანსიები (**vacancies** — actual jobs), `2`=სტიპენდიები (scholarships), `3`=ტრენინგები (trainings), `4`=ტენდერები (tenders), `5`=სხვა (other). **The unfiltered default page mixes all five types together** — confirmed by the page's own title, "ვაკანსიები, კონკურსები, ტრენინგები - განცხადებები" (vacancies, competitions, trainings - announcements).
  - **Decided 2026-09-03 (user)**: scraplify aggregates **all announcement types**, not vacancies-only — matches the domain model's "Opportunity" naming and jobs.ge's own default unfiltered view. Practical effect: the crawler does **not** need to pass `jid` at all — the default unfiltered `/ge/ads/?page=N` walk is already the correct, complete discovery source. No `jid=1` restriction goes into `isJobsGeUrlAllowed`.

## Detail page structure — confirmed highly variable, per user's own observation

Sampled 18 real detail pages (`?view=jobs&id=...`) spanning both the newest page and ~7500 IDs older (roughly a month back based on date deltas). Findings:

- **No single fixed template.** Body length alone ranged 3267-7582 characters across samples. Confirms concept §24.2's expectation of fixture coverage for "changed layouts" / "missing optional fields" is a real, not theoretical, concern.
- **Application method varies per listing**, at least three distinct patterns observed:
  1. `mailto:` link with a real address (e.g. `mailto:vacancy@sharmtrading.ge?subject=`) — roughly half of the 18 samples.
  2. An external link embedded **inline in the description text itself** (not a separate structured field) instructing the reader to follow it, e.g. one listing's body literally contained "ვაკანსიის დეტალურად სანახავად და აპლიკაციის გამოსაგზავნად, მიჰყევით ბმულს: https://wrk.ge/..." ("to see the vacancy in detail and apply, follow this link"). In this pattern jobs.ge's own detail page is a thin stub and the *real* content/application lives off-site.
  3. Direct link to an employer's own ATS (`selfrecruit.ge`, `hel-ai.com/apply/...`) with no mailto at all.
  - **No PDF/DOC/attachment-based listing found in this sample of 18.** Either rare, or needs a larger/different sample to find — not confirmed absent, just not yet observed. Don't assume attachments don't happen; the domain schema already models an `ATTACHMENT` resource role for exactly this.
- **Parsing gotcha found, important for M3**: naively collecting "every external `<a href>` on the detail page" is wrong — most pages carry unrelated sidebar/footer/ad links (e.g. `https://www.tbilisiwalls.com/...`, `https://bit.ly/...`, news-site links) that have nothing to do with the listing's application method, and the same unrelated URLs repeat across *different* listings' pages. The real application-method signal is specifically: a `mailto:` link, or a URL that appears **inside the description's own text content**, not any link anywhere on the page.
- **Dates are consistently yearless** across every sample: e.g. "გამოქვეყნდა: 03 სექტემბერი / ბოლო ვადა: 03 ოქტომბერი" (published/deadline, day + month name, no year). Matches concept §24.1's explicit "Yearless dates across year boundaries" test requirement — confirmed as a real, pervasive parsing problem, not a hypothetical.
- **No salary mentioned** in any of the 18 samples — matches `salaryRaw` already being nullable in the domain schema.
- One employer (`ibis Styles Tbilisi Mziuri Park`) had 3 simultaneous listings sharing the same contact email — confirms employers commonly post multiple listings, consistent with the `ORGANIZATION`/client-view resource concept.

## Still open / not yet done

- Pin down exact pagination depth (bisect between page 2 and page 20).
- Find or rule out an attachment-based (PDF/DOC) listing example with a larger sample.
- Decide the `jid` announcement-type scope question (jobs only vs. full mixed stream) — needs a product decision, not just technical investigation.
- Capture actual fixture HTML files (this note is analysis, not the fixtures themselves — fixtures still need saving to `src/adapters/jobs-ge/fixtures/`).
- Update `src/policies/jobs-ge.ts` (`isJobsGeUrlAllowed`) to authorize `/ge/`, `/en/`, and `/ge/ads/?page=N` once the scope decision above is made.
- Update `docs/STATUS.md`'s Phase 1A exit gate with this evidence.
