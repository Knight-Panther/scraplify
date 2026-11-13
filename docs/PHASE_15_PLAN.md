# Phase 15 plan: programmes for students and youth

Two new sources, three new kinds and one new bilingual tab. Kept as a tracker once building starts.

- **Status: under way since 2026-11-13, on the owner's go.** 15A first, on branch `phase-15a-summer-schools`. The owner worked through the plan in plan mode on 2026-11-09 and made the eight decisions below, then set it aside to finish Phase 14 first.
- **The original** is at `~/.claude/plans/first-analyze-our-xtelo-jaunty-gray.md` on the owner's PC. This copy is the one kept current.
- **All open work, every phase:** the Board at the top of `docs/STATUS.md`.
- **Keeping it current:** CLAUDE.md, "Tracking". Once a sub-phase starts, each item below gets its mark (✅ done · ⏳ under way · ❌ not started) and a "Changed:" note wherever building changed the plan.

## Context

Browse's Kind filter offers job, tender, summer school, scholarship, grant and event. Production holds 24,015 jobs and 385 tenders and nothing else, and no code can assign the other four kinds: `opportunityTypeForListing` (`src/dedupe/tender-post.ts:184`) returns `tender` or `job` only. The owner wants the site to draw Georgian students and youth. This phase adds two sources that fill those kinds, the kinds that were missing, and a tab built for choosing a programme.

- **summerschoolsineurope.eu**: a directory of short academic courses (summer, winter, spring) across Europe.
- **programmes.eurodesk.eu**: Eurodesk's curated list of EU youth programmes, with an eligible-country filter.

Outcome: courses and programmes appear in Browse under their kind, and on a new Programmes tab with filters that fit them. Vacancy matching (CV Ranked) is untouched.

## Sub-phases at a glance

Each is its own branch and PR with an exit gate in `docs/STATUS.md`. Order: 15A, 15B, 15C, 15D, 15E, 15F, 15G.

| | | What | Goes live? | Waits on |
|---|---|---|---|---|
| ⏳ | **15A** | Summer-school crawler, typing by source, local trial | no | 14C live (2026-11-11); its recon questions may be answered sooner |
| ❌ | **15B** | Three new kinds (migration 0054), kind labels in both languages, Browse and detail-page rendering | merged, deployed with 15C | 15A |
| ❌ | **15C** | Hosted rollout of the summer-school source | yes: courses in Browse under their kind | 15B |
| ❌ | **15D** | Eurodesk crawler (visitor session), local trial | no | 15B |
| ❌ | **15E** | The bilingual Programmes tab, designed against both data sets | yes | 15C live, 15D's trial data |
| ❌ | **15F** | Eurodesk hosted rollout | yes | 15D, 15E |
| ❌ | **15G** | Job-board kind hygiene and the UI gaps found on the way | later | the owner's go |

## What was measured (2026-11-09, read-only)

### summerschoolsineurope.eu

| Fact | Value |
|---|---|
| Upcoming courses | 537 (9,476 in total; past editions stay published and are skipped) |
| Spread | 24 countries (UK 199, Italy 67, Germany 63, Netherlands 41 … Georgia 3); 35 disciplines; on-site 432, online 40, hybrid 29; under-18 "junior" 29 |
| robots.txt | `User-agent: *` allowed, `Crawl-delay: 15`; AI-training bots refused by name |
| REST API | closed (401 on `/wp-json/wp/v2/course`): not used |
| Listing | `/courses/?_paged=N`, server-rendered, 12 cards a page, 45 pages, upcoming only. The page embeds `FWP_JSON` with `pager.total_rows` and every facet's counts |
| Sitemaps | `sitemap_index.xml`, then `course-sitemap.xml` … `course-sitemap10.xml`, per-URL `lastmod`, oldest first |
| Card | WordPress post id (`data-post-id`), school (`data-destination`), "City, Country", title, When, Credits (EC), Fee (EUR or GBP), Language, tags `Deadline: 01 December` (no year), `Online`, `Top course` |
| Detail `/course/<slug>/` | disciplines and season in the subtitle; When, School, Institution, City, Country, Language, Credits, Fee; optional "Early Bird deadline <date>"; "Learn more & register" link to the organiser (some have an on-site "Interested?" form instead); sections About, Course leader, Target group, Course aim, Fee info; `article:modified_time`; shortlink `?p=<post id>` |
| Not on the site | any nationality or eligibility field. The registration deadline is on the card only, never on the detail page (0 of 3) |
| From our host | HTTP 200, 12 cards, no Cloudflare challenge, with `ScraplifyBot/0.1` |
| Seen once | the listing's total moved 533 to 537 within minutes and two cached pages shared a card (pages are edge-cached up to 2 h, at different moments); one card read "28 June - 02 June 2027" |
| Terms | the terms and disclaimer pages render their text in the browser; not read yet |

### programmes.eurodesk.eu

| Fact | Value |
|---|---|
| Programmes | 463 in total; **94 list Georgia as eligible** |
| The 94 | open now 11 (8 with a dated deadline, 3 "ongoing"); "upcoming" 83 (recurring calls, not open). Audience: young people 57, organisations 25, both 10, none stated 2 |
| The 94 by kind after mapping | competition 27, grant 23, internship 16, course 12, volunteering 7, event 5, scholarship 4 |
| robots.txt | everything allowed, no crawl delay |
| How the list loads | the page shell holds no programmes. Its script calls `GET /search?<filters>&page=N` and gets JSON `{open:{html}, upcoming:{html}, count, "has-more"}`, 20 cards a page |
| Access | a cookieless request gets 403. After a plain `GET /en` (which sets the session cookies) the same request with those cookies and a Referer gets 200. No login, no token header, no challenge |
| Card is the detail | each card carries a `<template data-hash="<id>-eu">` with the whole programme: deadline (`dd/mm/yyyy`, `ONGOING` or `UPCOMING`, plus a timestamp in an inline script), category and subcategory, audience, title, one-line summary, body, "Opportunity offered by", "Find out more" link. There are no per-programme URLs; the share link is `https://programmes.eurodesk.eu/search#<id>-eu` |
| Server-side only | eligible countries, destination countries, topics, age and format are filters, not printed on the card |
| RSS | `/rss`: 463 items with title, one line and id. An id cross-check only |
| Size | a page is about 235 KB compressed and up to 2.8 MB of HTML, because every language version is embedded |
| From our host | page 200, search 200, count 94, 20 cards, with `ScraplifyBot/0.1` |
| Terms | not read yet |

### Our side

- `summer_school`, `scholarship`, `grant` and `event` exist in the `opportunity_type` enum since migration 0015 and can never be assigned.
- `public_opportunity_members` exposes `structured_attributes`, `locations`, `source_categories` and `application_method` for every source; only `description` is blanked when a source's policy has `mayRepublishFullContent` false (`src/db/schema/public-views.ts`). The tab needs no view change and no new grant.
- The CV Ranked bundle takes `type = 'job'` only (`src/matching/bundle/snapshot.ts:63`), but its health gate skips only `TENDER_ONLY_SOURCES` (`src/source-traits.ts:24`). A source with no run yet reads as `never_crawled`, critical, so a new source would freeze the vacancy bundle unless that list is widened first.
- Same-source pairs always score `distinct` and different kinds never merge, so each course becomes its own opportunity. Each same-source pair inside an organiser block still costs two lookups (`src/dedupe/run-dedupe.ts:702-722`): a school with 150 courses is about 11,000 pairs a pass.
- The tender phrases in `opportunityTypeForListing` apply to every non-etenders source: a course titled "Public Procurement for …" would be typed a tender unless the source rule comes first.
- The fetcher (`src/net/http-fetcher.ts`) is GET only, with no cookie or header option. Its 10 MB limit fits Eurodesk's pages.
- Browse filters by Board, State, Kind, First seen and Deadline. Every screen except the landing page is English only, and `toggleLocale` (`web/app/actions.ts`) always returns to `/`.
- The job boards already carry non-jobs stored as jobs: of 8,149 live listings, about 31 trainings and courses, 2 grant competitions and 1 youth camp (0 summer schools, 0 scholarships). jobs.ge's list has an announcement-type filter (`jid`) that the crawler does not record.

## Decisions (owner, 2026-11-09)

1. Courses and programmes show **in Browse under their kind and on a new tab**. Rows on the tab open the existing `/opportunities/[id]` page.
2. Public pages show **facts, a short excerpt and links** (to the source's page and to the organiser). Full text is stored and not shown; a source's policy can switch it on later. This is a per-source exception to the 2026-10-07 "no excerpt" decision, and STATUS says so.
3. The new tab is **bilingual** (Georgian default, English), following the existing KA/EN switch. Field and country names are translated; titles and descriptions stay as published.
4. Summer-school site: **all upcoming courses**. The trial crawl measures how many say "only for …"; a hiding rule is written only if that count is real.
5. Eurodesk is read through **an ordinary visitor session**. The owner writes to Eurodesk himself; nothing waits on the answer.
6. Eurodesk scope: **only programmes eligible for Georgia, every audience**, tagged "for young people" or "for organisations"; the tab's audience filter starts on young people.
7. **Three new kinds**: `competition`, `internship` (shown as "internship abroad") and `volunteering`. Training courses share `summer_school` with summer and winter schools, shown as "course / school". Eurodesk internships stay out of CV Ranked.
8. Standing rules apply: a branch and PR per sub-phase with a STATUS exit gate; a local trial into a disposable `scraplify_qa_*` database before any host run; UI finished only after browser QA at 390 and 1280 wide in both languages; no invented data; no Codex review planned.

## The owner's questions, answered

- **Will the new site fit under the same filters?** Yes. Its courses get the existing `summer_school` kind, so ticking that box in Browse lists them, and Browse's other filters work for them unchanged.
- **A separate page?** Yes: the Programmes tab, because choosing a course needs field, country, month, fee and format, which Browse does not have.
- **If jobs.ge lists a summer school, is it stored as a job?** Today, yes: everything that is not a tender becomes a job and enters CV Ranked. It is rare (about 35 of 8,149 live listings; none is a summer school). 15G fixes it two ways: jobs.ge's own announcement type is recorded, and title rules modelled on the tender detector cover both boards.
- **Only what Georgians can apply to?** Eurodesk states eligibility, so only its Georgia-eligible programmes are taken. The summer-school site states none: its courses are open to anyone who pays, so all are taken and the filters (fee, country, online) do the narrowing.
- **Dedupe before storing?** Each source's listing is stored as received; the dedupe pass in the same run then links copies of one programme into a single public row, as jobs.ge and hr.ge vacancies merge today. Overlap between these two sources should be a handful of courses at most, and is measured on the trial data before any rule is written.

## Design choices

Each was a real alternative; the reason follows.

| | Choice | Reason, and what was set aside |
|---|---|---|
| A | Slugs `summerschoolsineurope-eu` and `eurodesk-eu`; labels are the domains | The registrable-domain convention (`ss-ge` drops `home.`). The Eurodesk policy's `baseUrl` and allowed host still name `programmes.eurodesk.eu`. |
| B | Summer schools: listing pages give membership and card facts; sitemaps only say which detail pages changed | The registration deadline and the "Online" tag exist only on cards, and the listing's `total_rows` is the completeness check. |
| C | Closure uses what the pipeline already has: a course that has started closes by its own date; a course missing from three complete walks in a row closes through `closeMissingListingsInTransaction`, under its existing cap | Simpler than the first design (per-course exit checks and canary refetches). A walk claims full coverage only when its guards pass, so a cached, shifted listing cannot close anything in one run. |
| D | `organizationRaw` is the School; Institution goes to attributes | The School is what the card and the site's facet name; Institution can be "N/A". |
| E | A course with no stated deadline keeps a null deadline | `source_deadline_at` drives "Closes" and "closing in 7 days"; a start date there would be an invented deadline. Early-bird is never the deadline. |
| F | The year of a yearless card deadline is the latest year that puts it on or before the course's start date; two fitting years or none gives null | It does not depend on the day of the fetch. |
| G | Date-only deadlines are stored as 23:59:59 +04:00 of the printed day; course dates are plain `YYYY-MM-DD` strings shown with no time zone | `web/lib/format.ts` renders in Asia/Tbilisi, so the screen shows the day the source printed. |
| H | Fee buckets use a committed, dated reference-rate table for grouping and sorting only; the screen always shows the source's own amount and currency | An unknown currency gets its own bucket and is never guessed. |
| I | Tab at `/programmes`, "Programmes" / "პროგრამები"; its rows are fetched once, cached, and filtered in TypeScript | It holds grants for organisations too, so "Study" does not fit. About 630 rows make in-memory facet counts trivial; revisit SQL filters past about 5,000 rows. |
| J | Browse lists programme kinds by default, tagged, as it lists tenders | "Any kind" keeps meaning any. The first sweep is started so that it ends before that evening's job pipelines, so new vacancies land above the 537 courses. The alternative, leaving programme kinds out of Browse until a Kind is ticked, is one constant if the mix reads badly. |
| K | The landing page's "open vacancies and tenders" stat and its newest panel leave programme kinds out; the subhead and the tab name the programme sources | The stat's label stays true, and "boards merged" would be false for sources that never merge. |
| L | `TENDER_ONLY_SOURCES` becomes `NON_VACANCY_SOURCES`, live before either source's first host run | Otherwise a failed or never-crawled programme source freezes the vacancy bundle. |
| M | Both sources join the 16:10 UTC template timer as instances | No new schedule type; `CRAWL_SCHEDULES` and its test only gain keys. |
| N | Typing by source is built in 15A, before any trial dedupe | A dedupe pass before typing exists would create `job` opportunities. |
| O | Eurodesk: no topic or format walks in v1 | Each response is up to 2.8 MB, and a topic facet would cost 15 to 20 more heavy pages a day. |
| P | A Eurodesk subcategory with no mapping is quarantined with a warning incident, never given a guessed kind | The form lists all 18 values, so this fires only when the site's vocabulary changes. |
| Q | Programme kinds never auto-merge in v1: a would-be `confirmed_same` becomes `needs_review` | Overlap is expected to be a handful; a human confirms the first ones. |

## Architecture in brief

### Kinds and typing

- Enum after migration 0054: `job, summer_school, scholarship, grant, event, tender, competition, internship, volunteering`. `PROGRAMME_KINDS` is every kind except `job` and `tender`.
- New `src/dedupe/programme-kind.ts`:

```ts
// honoured ONLY for registered programme source ids: a job board cannot declare a kind
programmeKindForListing(sourceId: string, hint: string | null): OpportunityType | undefined
opportunityKindSql(column): SQL<string | null>   // structured_attributes->>'opportunityKind'
```

- `ListingTypeInput` gains `sourceKind: string | null`. `opportunityTypeForListing` asks `programmeKindForListing` first and returns its answer; the three tender lines below it stay untouched. Its three call sites (`run-dedupe.ts:175`, `resolve-canonical.ts`, `loadListingOpportunityType`) select the hint.
- Per source: summerschoolsineurope.eu may only be `summer_school`; eurodesk.eu may be any of the seven programme kinds.
- `resolveType`: any tender member gives tender (unchanged). Else, when every member is a programme kind and they agree, that kind. Else the stored kind, with a stored `tender` and no tender member giving `job` (unchanged).

Eurodesk subcategory mapping (one table in the adapter, with a test that every value maps):

| Subcategories | Kind |
|---|---|
| scholarships | `scholarship` |
| grants, travel grants, entrepreneurship, accreditation & labelling | `grant` |
| forums & events, youth exchanges, youth leaders | `event` |
| training courses | `summer_school` |
| internships, work exchange, au pair | `internship` |
| volunteering, work camps, youth ambassadors | `volunteering` |
| competitions, awards, prizes | `competition` |

### Revision content (no new table)

| Field | summerschoolsineurope.eu | eurodesk.eu |
|---|---|---|
| `sourceRecordId` | WordPress post id (card `data-post-id`, checked against the detail shortlink) | programme id from `data-hash` |
| canonical URL | `/course/<slug>/` | `https://programmes.eurodesk.eu/search#<id>-eu`, if a fresh browser opens the programme there (15D recon) |
| `titleRaw` | h1 | modal title, EU (English) version only |
| `organizationRaw` | School | "Opportunity offered by" |
| `locations` | `["City, Country"]`; `[]` when online | `[]` (destination is not printed) |
| `salaryRaw` | null (a fee is not pay) | null |
| `deadlineDate` | card "Deadline: DD Month", year by choice F | dated: the printed `dd/mm/yyyy`; ONGOING and UPCOMING: null |
| `applicationMethod` | the register link exactly as published; "Interested?" gives `form` | "Find out more"; none gives `unspecified` |
| `sourceCategories` | discipline names as printed | `[category, subcategory]` |
| `description` | About + Target group + Course aim + Fee info (stored, not public) | modal body (stored, not public) |

`structuredAttributes`, common keys: `kind: 'programme'`, `opportunityKind`, `audience`, `callStatus`, `excerpt`.

- **Courses add:** `postId`, `season`, `startDate`, `endDate`, `whenRaw`, `durationDays`, `datesSuspect`, `city`, `country`, `countrySlug`, `format`, `language`, `credits {amount, unit:'EC'}`, `fee {amount, currency, raw}`, `feeOptions[{amount, currency, label}]`, `earlyBirdDeadline`, `school`, `institution`, `disciplines[{slug, name}]`, `registration: 'external' | 'on_source'`, `modifiedAt`, `searchFold` (title, school and city with accents folded, so "Krakow" finds "Kraków"). `audience` is `['individuals']`.
- **Eurodesk adds:** `programmeId`, `category`, `subcategory`, `audience` (`young_people`, `organisations`), `callStatus: 'open' | 'ongoing' | 'upcoming'`, `eligibleCountries: ['Georgia']` (the only one known), `languages[]`, `deadlineLocalRaw`.

Rules:
- **Attributes are public.** Free text in them is limited to the bounded excerpt and fee labels; a test pins every attribute string at 300 characters or fewer.
- **Excerpt.** Courses: the first one or two sentences of "About", with emails, phones and URLs removed, cut at a word boundary within 280 graphemes (`Intl.Segmenter`, never `slice`). Eurodesk: the card's own one-line summary.
- **Sticky deadline.** If a card shows no deadline badge but the stored revision has one, the stored one is kept, so an expired course cannot reopen with no deadline. (15A's recon first checks whether the badge really disappears.)
- **Hash inputs** leave out "Top course", images, card order, share links and Eurodesk's card colour.

### Crawl recipes

**summerschoolsineurope.eu** (15 s apart, one at a time):

1. `/sitemap_index.xml`, then the course sitemaps whose index `lastmod` is newer than the last completed run minus two days (all ten on a first run).
2. `/courses/`, then `?_paged=2..N` from the pager in `FWP_JSON`. Three tries per page. Union by post id.
3. A detail fetch when the id is new, the card fingerprint changed (title, school, place, when, credits, fee, language, deadline, online), the sitemap `lastmod` is newer than the stored `modifiedAt`, the listing is quarantined, or `--refetch=all`.
4. End of run: `expireOverdueListings`; the adapter's `closeStartedCourses` (start date passed, no request); and, when the run completed with full coverage, `closeMissingListingsInTransaction` with a streak of 3.

- **Budget.** Daily about 60 to 85 requests, 16 to 23 minutes. First run about 593 requests, about 2.6 hours. Detail cap 700.

| Guard | Fails when | Effect |
|---|---|---|
| `walkComplete` | a page failed three times, or the pager is inconsistent | partial, nothing closes |
| `coverage` | unique cards < smallest `total_rows` seen − max(12, 3%) | partial, nothing closes |
| `nonEmpty` | zero cards | partial |
| `pageSize` | a page other than the last has other than 12 cards | partial |
| `sitemapRead` | the index or a due sitemap is unreadable | partial |
| `quarantineRate` | over 10% of detail fetches | partial |
| `fetchFailureRate` | over 50% of detail fetches | partial |

URL allow-list (`isSummerSchoolsEuUrlAllowed`): `/courses/` with no query or exactly `_paged=<1..200>`; `/course/<slug>/` with no query; `/sitemap_index.xml`; `/course-sitemap<digits>.xml`. Nothing else: no `/wp-json`, `/wp-admin`, `/login`, facet parameters.

**eurodesk.eu** (10 s apart, one at a time; about 8 requests a day):

1. `GET /en`; the fetcher's session jar keeps the cookies it sets.
2. `/search?eligible-country[]=Georgia`, then `&page=N` until `has-more` is false (cap 15 pages). Each answer must be JSON with `open`, `upcoming`, `count` and `has-more`.
3. `/rss` as an id cross-check only.
4. Every card is parsed from its `<template>` (EU version, else EN, else skipped and counted) and written. There are no detail fetches.

- **Coverage.** The run claims full coverage; on a completed run `closeMissingListingsInTransaction` runs with a streak of 3, under its cap.
- **Guards.** `sessionOk`; `walkComplete`; `nonEmpty`; `countMatches`; at least half of the last full run; `quarantineRate`.

URL allow-list: `/en`, `/rss`, and `/search` with exactly `eligible-country[]=Georgia` plus an optional `page`.

Fetcher extension (`src/net/http-fetcher.ts`), off by default and used only by this adapter:

```ts
session?: { host: string; referer?: string }
// in-memory jar: Set-Cookie from `host` only, sent to `host` only, emptied on close(),
// never logged or stored. No POST, no arbitrary headers.
```

### The tab's query and states

- `src/browse/programme-queries.ts`: `publicListProgrammes(db)` runs one query over `public_opportunity_members` joined to `public_opportunities`, where the type is a programme kind and the member is `active`. Used on every surface, cached per process with `cachedFor(120_000, …)` (`web/lib/cached.ts`).
- At request time, in TypeScript: deadline null or not passed, and a course's `startDate` not before today in Tbilisi, so a course that started this morning never shows whatever the crawl lag.
- Facet counts come from the same rows: each facet is counted over the rows matching every other active facet.

| What the source states | State | Row shows |
|---|---|---|
| a dated deadline in the future (either source) | deadline stated | the date |
| Eurodesk ONGOING | no deadline stated | "ongoing" |
| a course with no deadline badge | no deadline stated | nothing |
| Eurodesk UPCOMING | not open yet | "not open yet" |

Default sort: stated deadlines soonest first; then courses by start date; then ongoing; then not open yet. Ties go to newest, then id.

## Cloudflare: staying unblocked

Both sites sit behind Cloudflare and both answered our server normally with our own crawler name (2026-11-09). Nobody can guarantee that lasts: the setting belongs to each site and can change without notice, as ss.ge's did on 2026-10-22. What keeps the risk low, and what each adapter must do:

- **Small and slow.** One request at a time, at the rates above.
- **Honest.** Our own crawler name on every request, only pages the robots file allows, no REST API, no login.
- **Fetch only what changed.**
- **Stop on the first sign.** A `cf-mitigated: challenge` header, a challenge page, a 403 or a 429 ends the run as partial, backs the source off and raises the usual alert. For Eurodesk one session refresh is allowed per run (an ordinary expiry); a second refusal stops. The adapter never retries around a challenge, never solves one and never changes its identity to get past one. Tests pin this with a saved challenge response.
- **First week watched.** Each night's 403/429 counts are read before a source is called stable.
- **The durable fix is an allow-list.** If a site starts challenging us, the owner asks its operator to allow our server's address or crawler name in their Cloudflare rules.
- **Not built:** disguising the crawler as a browser, challenge solving, rotating addresses. They break without notice, they put the home connection's reputation at risk, and concept §4.3 rules them out.

## Sub-phases

### 15A: summer-school acquisition (not hosted)

Recon first (plain GETs, 15 s apart; allowed before 14C is live). Answers go into the adapter's `RECON_NOTES.md`:
- Does the "Deadline" badge stay after its date passes?
- Does the default listing mean "not started" or "not ended"?
- Where are hybrid and junior stated on a detail page? (If only as facets, leave them null.)
- Which currencies appear? What does a removed course answer? Does the apex redirect to `www`?

Add:
- `src/policies/summerschoolsineurope-eu.ts` (+ test): `mayRepublishFullContent: false`; `termsUrl: null` with "not yet reviewed: the page renders in the browser"; dated evidence for the robots.txt read, the named AI bots it turns away, the REST 401 and the host test.
- `src/adapters/summerschoolsineurope-eu/`: `listing.ts`, `sitemap.ts`, `detail.ts`, `dates.ts`, `money.ts`, `crawl.ts`, `RECON_NOTES.md`, `fixtures/`, tests. Model: `src/adapters/etenders-ge/`; for sitemaps `src/adapters/hr-ge/sitemap.ts`.
- `src/cli/run-summerschoolsineurope-eu-crawl.ts` (the name `deploy/run-pipeline.sh` expects), `summerschoolsineurope-eu-options.ts` (+ test) with `--refetch`, `--max-pages`, `--max-detail-fetches`, `--sitemaps=all`; npm script `crawl:summerschoolsineurope-eu`.
- `src/dedupe/programme-kind.ts` (+ test), with this source's fixed rule.

Change:
- `src/policies/index.ts`; `src/policies/policies.test.ts:229-234`; `src/cli/sync-source-policies.ts:40-42`; `src/db/real-data-guard.ts:35`.
- `src/dedupe/tender-post.ts`, `src/dedupe/resolve-canonical.ts`.
- `src/source-traits.ts` (+ test) and `src/matching/bundle/build.ts:93-99`: the rename to `NON_VACANCY_SOURCES`, with the new slug.
- `scripts/run-crawl.ps1:5` (ValidateSet only; no local scheduled task).
- `docs/RIGHTS.md`: a Sources row, and the verdict lines at :7, :22 and :74, saying that permission has not been asked and the terms are not reviewed.
- `docs/scraplify-concept.md`: a dated amendment for the two sources, the new kinds (§12.3), the excerpt exception and the Eurodesk session decision with its limits (§4.3).

Fixtures (dated): listing pages 1, 2 and last with their `FWP_JSON`; the sitemap index and one course sitemap; details for a plain course, a GBP fee, "Interested?" with no external link, Institution "N/A", an early-bird line, an online course and the "28 June - 02 June" card.

Tests:
- `listing.test.ts`: 'reads 12 cards, post id, school, place and the pager from FWP_JSON'; 'the fingerprint ignores "Top course" and card order'; 'a deadline badge is kept raw'.
- `dates.test.ts`: 'a range across months and years'; 'end before start is kept raw and marked suspect'; 'a yearless deadline takes the latest year not after the start date'; 'two fitting years or none give an unparsed deadline'; 'a deadline is the end of its day at +04:00'.
- `money.test.ts`: '1850 EUR and 4640 GBP'; 'an unknown currency keeps the raw text'; 'free'.
- `detail.test.ts`: 'required fields or a typed error'; 'a page whose shortlink names another post is refused'; 'early-bird is never the deadline'; 'the excerpt is bounded and carries no email, phone or URL'; 'no attribute string exceeds 300 characters'.
- `crawl.test.ts` (MockAgent and the test database): 'the union of overlapping pages is one listing each'; 'short coverage leaves the run partial and closes nothing'; 'a newer sitemap lastmod fetches an unchanged card'; 'a vanished badge keeps the stored deadline'; 'a started course closes by date without a request'; 'a course absent from three complete walks closes'; 'a 403 or a challenge page stops the run'.
- `tender-post.test.ts`: 'a course titled "Public Procurement for …" is a course, not a tender'.
- `resolve-canonical.test.ts`: 'an opportunity stored as job whose member is a course becomes a course'.
- `build.test.ts`: 'a critical alert on a non-vacancy source does not fail the vacancy bundle'.

Trial into a new `scraplify_qa_p15` (migrate, crawl, `dedupe --auto-link`, a second crawl the next day). Record:
- counts by country, discipline, format, currency and season;
- share with a registration deadline; share with an external register link;
- Target-group phrases: "only for", "exclusively", "nationals of", "EU/EEA citizens", "students of <institution>";
- date-parse failures, courses with end before start, deadline years left ambiguous;
- unique cards against `total_rows`, and duplicates across pages;
- second-run fetch counts by trigger; and 30 unchanged courses refetched by hand, to see whether a page ever changes without its sitemap `lastmod` changing;
- dedupe pass time and `pairsCompared` with and without the source, and the largest organiser block.

Exit gate:
- [ ] Recon answers written; fixtures committed with their dates.
- [ ] Tests green in CI; the full suite on the throwaway database.
- [ ] Trial run completed with no quarantines; the second run fetched only changed courses.
- [ ] Every trial opportunity is `summer_school`; none reached a bundle snapshot.
- [ ] Measurements recorded; the "only for" count is in front of the owner.
- [ ] Dedupe cost recorded. If the source adds over 30 s, same-source pairs are skipped in the block loop in 15B, with a test.
- [ ] RIGHTS entry written.

### 15B: kinds, Browse and detail rendering

Changed (2026-11-13): the migration is `0054`, not `0052`, since Phase 14 took `0052` and `0053` after this plan was written.

Add:
- `drizzle/migrations/0054_*.sql`: three `ALTER TYPE … ADD VALUE` lines and nothing else (precedents 0038, 0044). The migration-safety-reviewer agent reads it.
- `web/lib/kind-labels.ts` (+ test): `kindLabel(type, locale)`.

| Kind | EN | KA (the owner reads these before the merge) |
|---|---|---|
| `summer_school` | course / school | კურსი / სკოლა |
| `scholarship` | scholarship | სტიპენდია |
| `grant` | grant | გრანტი |
| `internship` | internship abroad | სტაჟირება საზღვარგარეთ |
| `volunteering` | volunteering | მოხალისეობა |
| `competition` | competition | კონკურსი |
| `event` | event | ღონისძიება |

Change:
- `src/domain/opportunity.ts`; `src/db/schema/opportunities.ts:20-27`; `web/lib/labels.ts` (the exhaustive `Record`, its stale comment at :96-105, and a new `programmeSourceLabels` map kept apart from `sourceLabels`, which the taxonomy screens also read); `src/dedupe/membership-review.test.ts:44`.
- `web/lib/search-params.ts:52-56`: order job, tender, course / school, scholarship, grant, internship abroad, volunteering, competition, event.
- `src/browse/queries.ts` and `src/browse/public-queries.ts`: `excludeTypes?: readonly string[]`, used by the landing page's stat and newest panel (`web/app/(local)/page.tsx`; also fix its stale comment at :70-74). Browse does not pass it.
- `web/app/(local)/opportunities/(list)/page.tsx` and `facet-rail.tsx`: the subtitle, sort hint and cross-post tooltip stop saying "vacancy or tender" only; a "More filters on Programmes" hint appears when a programme kind is ticked (linked once 15E is live).
- `web/components/kind-tag.tsx`: uses `kindLabel`.
- `web/lib/opportunity-detail.ts`: a programme branch in `comparisonRows` with no Pay or Posted row: Organiser, Institution, Dates, Place, Language, Credits, Fee with its options, Format, Registration deadline (or "ongoing" / "not open yet" in the source's words, or "not stated"), Early-bird, For whom, Category.
- `web/lib/format.ts`: `plainDate`, `plainDateRange` (no time zone).
- `web/app/(local)/opportunities/[id]/page.tsx`: a Register block ("Register on <host>" plus "Open on <source>"; a form-only course says so), an Excerpt section with `lang="en"`, and a back link that honours `from=programmes` through an allow-list.
- `web/lib/site-metadata.ts`: `opportunityDescription` uses the excerpt when the description is blank.
- `web/app/(local)/opportunities/[id]/not-found.tsx:29-41`; `web/components/site-footer.tsx:21-25`.

Tests: 'a job board cannot declare a kind through its attributes'; 'a reviewer cannot put a course into a vacancy'; 'an internship never reaches the CV bundle'; 'a course has no Pay row'; 'a missing deadline reads not stated'; 'a fee is shown as the source wrote it'; 'excludeTypes leaves programme kinds out and the count agrees'; the new Kind order; 'every enum value has an English and a Georgian label'.

Exit gate:
- [ ] 0054 applied to the test and trial databases; the agent's review has no P0 or P1.
- [ ] Tests green in CI.
- [ ] Browser QA on the trial database, local and public surfaces, 390 and 1280: Browse with courses tagged among vacancies; Kind = course / school; the long board chip with no overflow; a course page with a register link and one without. No console errors.
- [ ] The owner has read the Georgian kind labels.

### 15C: hosted rollout of the summer-school source

Change:
- `deploy/run-pipeline.sh:18,20`; `src/hermes/schema.ts:31-35` (its test follows); `src/crawl-schedule.ts:24-31` and the key list in its test.
- `.claude/skills/prod-status/SKILL.md:39`; `.claude/agents/adapter-drift-checker.md`; `docs/RUNBOOK.md:11,105`; `docs/hermes-hook.md`; the enable comment in `deploy/systemd/xtelo-pipeline@.timer`.

Hermes: one note, shown to the owner first. It names the new slug and says its listings are courses, not vacancies, so Hermes's source lists need it and its CV screener must not screen them (`Hermes/workflows/integrations/xtelo.py:54`, `xtelo_screen.py:48`, `xtelo_events.py:544`).

Sequence (ss.ge's run must have ended; deploy window 13:40 to 20:30 UTC):
1. One polite GET of `/courses/` from the host, to confirm it still answers.
2. Deploy: backup, migrate 0054, `apply-db-roles.sh grants`, repoint, probe.
3. Start the first run by hand straight after, about 13:50 UTC. It ends near 16:30, so that evening's vacancies land above the courses in Browse.
4. Enable `xtelo-pipeline@summerschoolsineurope-eu.timer` after 16:20 UTC the next day.

Effect on the others: the daily run holds its crawl lock for about 20 minutes, during which another pipeline's retention step skips by design; dedupe and the bundle build run once more a day.

Exit gate:
- [ ] First run completed: counts against the site's `total_rows`, 0 quarantined, the Hermes event sent.
- [ ] `health:check` exit 0; 0 active listings unlinked; the vacancy bundle built that day.
- [ ] Morning after: the timer run completed, and in how many minutes. Retention ran at least once on each of the first three days; if not, a separate timer becomes a follow-up.
- [ ] First week: no 403, 429 or challenge in the journal.
- [ ] Live at 390 and 1280: courses under their Kind in Browse, and a course page.

### 15D: Eurodesk acquisition (not hosted)

Recon in a real browser first: does the share URL open the programme in a fresh browser (else use `/en#<id>-eu`)? What does `count` count? How long does a session last?

Add:
- The `session` option in `src/net/http-fetcher.ts`.
- `src/policies/eurodesk-eu.ts` (+ test): `authenticationScope: 'none'`; its notes and evidence say exactly what is done (a session cookie any visitor receives; no login, no token header, no challenge) and the stop rule.
- `src/adapters/eurodesk-eu/`: `search.ts`, `kinds.ts`, `crawl.ts`, `RECON_NOTES.md`, fixtures, tests; the CLI, options and npm script `crawl:eurodesk-eu`.
- The Eurodesk rule in `programme-kind.ts`; `scoreProgrammePair` behind `scoreSameTypePair` in `src/dedupe/run-dedupe.ts` (choice Q).
- The same registrations as 15A: trait list, policy registry, guard list, RIGHTS row ("visitor session; terms not reviewed; the owner writes to Eurodesk").

Tests:
- `http-fetcher.test.ts`: 'a cookie from the session host is sent on the next request to it'; 'the jar is never sent to another host'; 'no Cookie header when the option is off'; 'Max-Age=0 removes a cookie'; 'close empties the jar'; 'the Referer goes only to the session host'.
- `search.test.ts`: 'open and upcoming sections'; 'dated, ONGOING and UPCOMING deadlines'; 'the EU version is the one read'; 'audience none, one and both'; 'the excerpt is the card summary'.
- `kinds.test.ts`: 'every subcategory in the fixtures and in the form's list maps'; 'an unknown one is not mapped'.
- `crawl.test.ts`: 'a 403 before any session stops the run'; 'one refresh, then stop'; 'HTML where JSON was expected stops the run'; 'an unmapped subcategory is quarantined with a warning'; 'a programme absent from three complete runs closes'; 'a pass that would close over the cap closes nothing'; 'an incomplete walk closes nothing'.
- `run-dedupe.test.ts`: 'two same-kind programmes with one organiser link go to review, never merged'.

Trial into `scraplify_qa_p15`, beside the courses. Record: counts by kind, audience and call status against the 94 measured; ids against the RSS; cross-source candidate pairs by decision (if there are any, add organiser, title and date-overlap evidence to the programme scorer).

Exit gate:
- [ ] Recon answers written; the canonical URL opens the programme in a fresh browser.
- [ ] Tests green in CI.
- [ ] Trial: two complete runs; counts match the site; 0 unmapped subcategories; candidate pairs recorded.
- [ ] The host still answers 200 JSON. A challenge or a persistent 403 stops Eurodesk, and 15E ships on the summer-school source alone.
- [ ] The owner has read the policy and RIGHTS wording.

### 15E: the bilingual Programmes tab

Invoke the `professional-frontend` skill before writing components and again before calling it done.

Reused: `StickyFilterBar` (moved to `web/components/`), `KindTag`, the mobile filter popover, the URL-state and "show more" patterns (chunk 60), `cachedFor`, `searchTerms`. New, the way `/real-estate` wrote its own: params, row, filter, copy and dictionary libraries and the facet rail.

Add:
- `web/app/(local)/programmes/page.tsx`, `loading.tsx`, `error.tsx`.
- `src/browse/programme-queries.ts` (+ a database test).
- `web/lib/programme-row.ts`, `programme-params.ts`, `programme-filter.ts`, `programmes-copy.ts`, `programme-dictionary.ts`, `reference-rates.ts`, each with a test.

Design:
- **Kind selector** at the top, as links with counts: All · Courses & schools · Scholarships · Grants · Internships abroad · Volunteering · Competitions · Events. A kind with no rows is not shown.
- **Filters for every kind:** For whom (starts on young people and individuals, which holds every course; "for organisations" and "all" are one click away, and the count line says how many are hidden); Applications (the states above); Deadline within 7, 30 or 90 days; Source; Search.
- **Filters for courses only**, shown when that kind is selected: Field (35); Country (24); Starts (month and year, from the data); Fee (free, up to €500, €500 to 1,000, €1,000 to 2,500, over €2,500, other currency, not stated; captioned "approximate, for grouping; rates of <date>"); Format; Duration; Credits.
- **Sorts:** the default above; starts soonest; newest; fee low to high (courses only).
- **Row:** kind tag; title (`lang="en"`); organiser; city and country, or "online"; dates; fee as the source states it; credits; language; the deadline or its state; a "for organisations" tag; the source chip. It links to `/opportunities/<id>?from=programmes&back=…`.
- **Language:** `lang={locale}` on `<main>`; `uppercase` only on static Latin text when the locale is `en`. Georgian names come from dictionaries keyed by the sites' slugs and fall back to the English name for an unknown slug.

Change:
- `web/components/site-header-nav.tsx`: the entry goes at index 1 in both arrays and the public slice becomes 5 (Browse, Programmes, Listings, Real estate, CV Ranked); the four desktop breakpoints are re-measured.
- `web/lib/locale.ts` and `web/app/actions.ts`: `toggleLocale` returns to the page it was clicked on, rebuilt from an allow-list (`/`, `/programmes`), never from the request.
- `web/lib/surface-routing.ts:22-33` (+ test); `web/app/sitemap.ts`; `e2e/surfaces/seo.spec.ts`, `a11y.spec.ts`, `surfaces.spec.ts`.
- `web/lib/hero-copy.ts`: the subhead gains a link to Programmes, at most 160 characters in each language. English proposal: "Vacancies from jobs.ge and hr.ge, tenders from etenders.ge, courses, scholarships and grants under Programmes, and homes from ss.ge under Real estate."
- `web/lib/site-metadata.ts:45-46` and `web/app/opengraph-image.alt.txt` together.

Tests:
- `programme-filter.test.ts`: 'facet counts ignore their own facet'; 'a started course is dropped whatever its status'; 'the default audience hides organisation-only rows and says how many'; 'the default sort order'; 'fee buckets never convert the shown amount'; 'an unknown currency is its own bucket'.
- `programme-params.test.ts`: 'an unknown slug is dropped'; 'the href round-trips'.
- `programme-dictionary.test.ts`: 'every discipline and country slug in the fixtures has a Georgian name'; 'an unknown slug shows the English name'.
- `programme-queries.test.ts`: 'only programme kinds, only active, read through the public views'.
- `hero-copy.test.ts` (both links once; 160 characters); `surface-routing.test.ts`; `locale.test.ts`.

Exit gate:
- [ ] Tests green in CI; `test:e2e:surfaces` and `test:e2e` pass.
- [ ] Browser QA on the trial database with both sources, public and local, 390 and 1280, Georgian and English: every kind and filter; the empty state; the language switch keeping the filters; back from a detail page; `scrollWidth` equal to `clientWidth`; no uppercased Georgian; no console errors; the header at each new breakpoint.
- [ ] The owner has read the Georgian copy and the two dictionaries.
- [ ] The surface-boundary-reviewer agent has no P0 or P1.
- [ ] Deployed (no migration); probe ok; the tab checked live in both languages.

### 15F: Eurodesk hosted rollout

The same wiring list as 15C for `eurodesk-eu`. One Hermes note, shown to the owner first. The first run is started by hand (about two minutes), then the timer is enabled.

Exit gate:
- [ ] First run completed with full coverage; counts against the site; the Hermes event sent; health check 0.
- [ ] Morning after: the second run complete.
- [ ] Day four: nothing closed that is still on the site.
- [ ] First week: no 403 or challenge in the journal.
- [ ] Each kind checked live on the tab.

### 15G: job-board kind hygiene and UI gaps (later, its own PRs)

How a job-board summer school is told from a job, in order of reliability:

1. **The board's own announcement type.** Each run also walks jobs.ge's small lists for `jid=2` (scholarships), `3` (trainings) and `5` (other), about three requests, and stores the type as `structuredAttributes.announcementType`. This needs policy v4 with dated evidence and `isJobsGeUrlAllowed` accepting exactly those values. (Live today: `jid=3` lists about 15 items, `jid=2` none.)
2. **Title rules for both boards**, in a `programme-post.ts` modelled on `tender-post.ts`: a title opening with "საზაფხულო სკოლა", "ზამთრის სკოლა", "summer school" or "winter school"; "სტიპენდია", "scholarship" or "fellowship"; "საგრანტო კონკურსი" or "grant competition". The existing job-role veto applies. The rules are measured on the whole corpus first and tested with real titles and near misses.
3. **Precedence** in `opportunityTypeForListing`: programme source; then the tender rules, unchanged; then the announcement type (jobs.ge only, vetoed by a job-role word, since one cashier job is misfiled under trainings today); then the title rules; then `job`.

Mapping: scholarships become `scholarship`; trainings become `summer_school` ("course / school"), so no extra enum value is needed; "other" is not mapped until measured. Local internships stay `job`: `internship` means "internship abroad", and a test pins that. Gate: the owner reads the full list of listings that would change kind before the rule is enabled.

The UI gaps are items 1, 3, 4, 5 and 6 of the list below.

## Noted for later (found on the way)

| # | Gap | Where | Fixed in |
|---|---|---|---|
| 1 | The Kind filter shows kinds with no rows, and no option shows a count | `web/lib/search-params.ts:52-56` | 15G |
| 2 | Job-board trainings, grant competitions and camps are typed `job` and sit in CV Ranked | `src/dedupe/tender-post.ts:184-189` | 15G |
| 3 | On the public surface 5 of the 6 State options can never match | `src/browse/public-queries.ts:329-337, 394-396`; `facet-rail.tsx:74-90` | 15G |
| 4 | `.replace(/s+/g, ' ')` where `\s+` was meant: it would eat the letter "s" in a lower-case headline | `web/lib/site-metadata.ts:25` | 15G |
| 5 | Board filter order is not deterministic (no `ORDER BY`; Browse does not sort) | `src/browse/public-queries.ts:651-671`; `src/browse/queries.ts:1105` | 15G |
| 6 | The Georgian nav label for Browse is "ვაკანსიები" though it lists tenders, and soon programmes, too | `web/components/site-header-nav.tsx:40` | 15G |
| 7 | No Georgian label for any kind except tender | `web/lib/labels.ts:106-122` | 15B |
| 8 | Stale comments ("406 canonical opportunities"; the landing's note on `/opportunities`) | `web/lib/labels.ts:96-105`; `web/app/(local)/page.tsx:70-74` | 15B |
| 9 | A critical incident on a non-vacancy source would freeze the vacancy bundle | `src/source-traits.ts:24`; `src/matching/bundle/build.ts:93-99` | 15A |
| 10 | `resolveType` cannot restore a non-job kind once a tender member has come and gone | `src/dedupe/resolve-canonical.ts:78-85` | 15A (programme kinds) |
| 11 | `toggleLocale` always returns to `/` | `web/app/actions.ts` | 15E |
| 12 | Search treats accented Latin letters (ü, é, ó) as word breaks | `src/browse/search-terms.ts:46` | the tab works around it with `searchFold`; Browse left |
| 13 | jobs.ge stores a deadline as the start of its day, so a vacancy seems to leave the public list at 00:00 Tbilisi on its deadline day. Read from code only; check live data before acting | `src/adapters/jobs-ge/dates.ts:162` | open |
| 14 | Hermes labels any non-etenders pipeline source "vacancies" | `Hermes/workflows/integrations/xtelo_events.py:544` | Hermes's side, raised in 15C's note |
| 15 | Dedupe makes two membership lookups per contradicted pair | `src/dedupe/run-dedupe.ts:702-722` | 15B if the trial shows a cost |
| 16 | No JSON-LD anywhere; `Course` markup on course pages could help search | — | open |
| 17 | Local `/ranked` ranks every kind; the `opportunity_type` taxonomy axis is never written; `CLAUDE.md` and `package.json` still describe two job boards | `src/ranking/run-ranking.ts:59-73`; `src/db/schema/taxonomy.ts:19-32` | left; the two descriptions in 15C |

Outside this plan: a short test on 2026-11-09 showed myhome.ge answers a Georgian home connection normally (listing pages 200 with 24 listings in their page data) while the host is still challenged. Trying it for real needs one line in the laptop proxy's filter and is its own decision.

## Risks

| Risk | Mitigation |
|---|---|
| A site starts challenging the host | The stop rule above; a polite GET from the host before each rollout; the allow-list ask. |
| Listing cache instability | Union by id; the coverage guard; closure only after three complete walks. |
| Markup or `FWP_JSON` drift | Fixtures, required-field errors, quarantine, the page-size and coverage guards, the drift-checker agent. |
| Terms unread on both sites; no permission asked of the summer-school site | RIGHTS says so plainly; facts, excerpt and links only. |
| The Eurodesk session reads as access control | The owner decided it. The policy and RIGHTS state exactly what is done; one refresh, then stop; the option cannot send a token or a POST. It sits against concept §4.3 and the ss.ge gateway precedent, which is why the concept gets a dated amendment. This is the plan's weakest point. |
| A wrong year on a card deadline | Anchored on the start date; ambiguity gives null; counted in every run. |
| Unknown fee currencies | Raw text kept; own bucket; the rate table's test lists every currency seen. |
| The same course in two sessions | Two post ids, two rows; same-source pairs never merge. |
| A long source label in the UI | A separate label map; chips checked at 390 and 1280. |
| Vocabulary drift at Eurodesk | Unmapped is quarantined with a warning, never guessed. |
| The first sweep flooding Browse | Started so it ends before the evening's job pipelines; one constant removes programme kinds from Browse's default if needed. |
| Retention starved behind a longer crawl window | Measured for three days in 15C. |
| Model-written Georgian | The owner reads the labels, copy and dictionaries before each UI merge. |

## Verification

```sh
npm run build && npm run typecheck && npm run lint
DATABASE_URL=postgresql://scraplify:throwaway@127.0.0.1:5544/scraplify_qa_re npm test
# trial database in container xtelo-re-test (dropping it later needs the owner's yes; the write guard asks)
DATABASE_URL=<.../scraplify_qa_p15> npm run db:migrate
DATABASE_URL=<.../scraplify_qa_p15> npm run crawl:summerschoolsineurope-eu -- --max-pages=2 --max-detail-fetches=10   # smoke
DATABASE_URL=<.../scraplify_qa_p15> npm run crawl:summerschoolsineurope-eu                                             # full, about 2.6 h
DATABASE_URL=<.../scraplify_qa_p15> npm run crawl:eurodesk-eu
DATABASE_URL=<.../scraplify_qa_p15> npm run dedupe -- --auto-link
npm run test:e2e:surfaces && npm run test:e2e
```

- **Browser.** Serve the trial database on the public and local surfaces and use Playwright at 390 and 1280 in Georgian and English: measurements over screenshots (`scrollWidth` against `clientWidth`, computed styles), console, focus. Reset the viewport afterwards.
- **Host.** The `prod-status` skill before and after each rollout; `health-check.js` through `deploy/with-env.sh worker`; the journal for 403/429 during the first week.

## Starting it

1. **Until then, leave room for it.** Work done before Phase 15 starts should not assume three sources, two kinds or four public tabs.
2. **When the owner says go:** record the eight decisions under STATUS's "Owner decisions in force", add the Phase 15 block and Phase index row, and start 15A in a fresh session on Opus 5.5 working from this file. Not before 14C's morning-after check (2026-11-11); 15A's recon questions may be answered sooner.
3. **Measure again first.** Both sites were measured on 2026-11-09. Repeat the two host tests and the listing counts before building on them.
