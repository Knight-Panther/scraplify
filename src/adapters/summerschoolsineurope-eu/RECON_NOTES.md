# summerschoolsineurope.eu reconnaissance notes (Phase 15A)

The plan is [`docs/PHASE_15_PLAN.md`](../../../docs/PHASE_15_PLAN.md), whose first measurements date from 2026-11-09. This file is the adapter's working record: what the parsers and the crawl rely on, and how the fixtures were made. Each entry is "confirmed on the date given".

Every request was a plain GET with this crawler's own User-Agent, one at a time and 15 s apart (the robots.txt `Crawl-delay`), from the owner's PC. No sign-in, form, favourite or other state-changing action was ever performed. On 2026-11-13 the recon made about 90 requests: the robots file, every listing page, the sitemap index and the ten course sitemaps, nine course pages, and eight filtered listings.

## The site

- WordPress with FacetWP, behind Cloudflare and Kinsta. `https://summerschoolsineurope.eu/<path>` answers 301 to `https://www.summerschoolsineurope.eu/<path>`, so only `www` is requested.
- robots.txt: `User-agent: *` with an empty `Disallow` and `Crawl-delay: 15`. GPTBot, ChatGPT-User, Google-Extended, ClaudeBot, PerplexityBot and CCBot are refused by name.
- The REST API answers 401 (2026-11-09) and is not used.
- On 2026-11-13 the listing held 625 upcoming courses ("future") of 9,518 (8,893 "past"). The count was 537 on 2026-11-09. The ten course sitemaps list 9,585 course pages.

## Membership: the listing is shuffled on every page

This is the main finding, and it changed the plan (ledger ruling, `docs/PHASE_15_PLAN.md` "Changed:" notes).

- The listing is sorted at random. A plain page (`/courses/`, `/courses/?_paged=N`) is kept by Kinsta's page cache for up to 2 h (`x-kinsta-cache: HIT`, `s-maxage=7200`), each URL filled at its own moment. Every page is therefore an independent random sample of the set.
- Measured: all 53 pages gave 625 cards but only 403 distinct courses, 64%. That is what independent random pages predict, 625 × (1 − (1 − 12/625)^52) ≈ 397. One course appeared on pages 1, 2 and 4. Paging can never establish membership, and absence from a paged walk means nothing.
- A filtered listing bypasses the page cache (`x-kinsta-cache: BYPASS`) and is shuffled anew on every request: Italy's page 1, asked twice four minutes apart, held different courses.
- A filtered result of 12 or fewer is complete on its page 1. `_course_country=georgia` gave `total_rows` 4 and those 4 courses.
- A facet takes several values as OR: `_course_status=future&_course_country=austria%2Cbulgaria%2Ccroatia` gave exactly 12 = 4 + 2 + 6, on one page.
- `_course_status=future` names the default set explicitly (625, uncached), so the default's meaning cannot change underneath the crawl.

So membership comes from a **covering walk**: start at `_course_status=future`, split any result larger than one page by a facet (country, city, start month, duration, discipline), pack the small values of that facet into OR-groups of up to 12 courses, and ask each group's page 1. A result that no facet can split further is asked again until its distinct courses reach its `total_rows`. Every result set is checked against the site's own count, so a walk knows whether it saw every course.

Facets read from `FWP_JSON.preload_data.facets` (value, label and count per choice), with counts for the current filter. Every course has one country (the country counts summed to 626 for 625 courses, so one course carries two), one city and one start month. `course_type` covers 590 of 625 courses (offline 518, online 40, hybrid 32), so it cannot split a set, and `course_junior` is a single value (34).

## The answers the plan asked for

- **Does the "Deadline" badge stay after its date passes?** No deadline badge seen on the 53 pages was in the past (30 November, 1 and 4 December, read on 13 November), so the badge most likely disappears with its date. The sticky-deadline rule stays: a stored deadline is kept when the badge goes.
- **Does the default listing mean "not started" or "not ended"?** Neither exactly. "future" is a flag the site sets, and it lags: two courses that ended on 16 July and 6 August 2026 still carried it on 13 November. The crawl closes a course once its own start date has passed, whatever the flag says.
- **Where are hybrid and junior stated on a course page?** Nowhere. They exist only as listing facets, so they stay null in v1. "Online" is the card's own tag.
- **Which currencies appear?** EUR, GBP, NOK, CHF and SEK on the 403 courses seen. A dot before three digits groups thousands ("1.450 EUR", 6 cards), one card printed two decimals, and 11 of 625 cards print no fee.
- **What does a removed course answer?** 404 (`not-found-404.html`).
- **Does the apex redirect to `www`?** Yes, 301.

## What the parsers rely on

- **Listing cards** (`article.course-card`): the post id on the favourite button (`data-post-id`), the school in `data-destination`, "City, Country" in the body's first `<p>` (one is "Zagreb and Šibenik, Croatia"), the title in `h3`, a label/value grid (When, Credits, Fee, Language; Fee or Language may be missing), tags in `span.card-tag` ("Top course", "Online", "Deadline: 01 December" with no year), and the course link in `a.overlay-link`.
- **"When"** is always "DD Month - DD Month YYYY" on the cards seen (625 of 625 cards on the 53 pages). One card read "28 June - 02 June 2027" (post 73181) on both visits.
- **Course pages** (`/course/<slug>/`): `section.header` holds the pretitle ("Business &amp; Entrepreneurship & Psychology Summer Course": names HTML-escaped one by one, joined by a raw " & ", then the season), the `h1`, and a grid: When, School (a `/destination/<slug>/` link), Institution, City and Country (links carrying the facet slugs, `?_course_city=amsterdam`), Language, Credits, Fee. Then an optional "Early Bird deadline 07 February 2027" line, and either a "Learn more & register" link to the organiser, or an "Interested?" button to the site's own form (`#course-information`) with a "Visit school" link to the school's site in that section.
- The registration deadline is never on a course page; it is on the card only (also on 2026-11-09).
- The body sections are `h2` About, Course leader, Target group, Course aim and Fee info; some are missing. Fee info has a grid of options ("1295 EUR, Student") and free text.
- The bottom of every course page lists "Other relevant courses" as cards, deadline badges included. The parser reads the header section only.
- The post id is on the favourite button and in the shortlink (`<link rel="shortlink" href="https://www.summerschoolsineurope.eu/?p=48834">`). JSON-LD's WebPage carries `datePublished`, and `dateModified` when the page changed later. `article:modified_time` is missing on some pages.
- **Sitemaps**: entries are ordered by modification date, so a recently changed course sits in the last file. The index's date for the first file is the whole type's newest change, not that file's (its newest entry was 2024-09-02). All 403 upcoming courses seen were in the last three files.

## Fixtures (captured 2026-11-13, stored byte for byte, `.gitattributes`)

| File | What it shows |
|---|---|
| `listing-p1.html`, `listing-p10.html` | plain listing pages: the pager, facets, "Top course", "Online", two deadline badges, the "28 June - 02 June" card, a card with no fee |
| `listing-future-root.html` | `?_course_status=future`, the walk's root (625, 53 pages) |
| `listing-future-austria-bulgaria-croatia.html` | three countries as OR, 12 courses on one page |
| `listing-georgia.html` | `?_course_country=georgia`, 4 courses |
| `sitemap_index.xml`, `course-sitemap.xml` | the index and the first course sitemap |
| `detail-48834-early-bird-register.html` | a plain course: early bird, external register link |
| `detail-72366-gbp-online.html` | a GBP fee, online on its card |
| `detail-63043-interested-form-fee-options.html` | the site's form, "Visit school", fee options, a course that ended in July 2026 still listed |
| `detail-72851-online-no-fee.html` | online, no fee printed (its title says "free", which the parser does not read) |
| `detail-73181-end-before-start.html` | "28 June - 02 June 2027" |
| `detail-64143-nok.html` | a NOK fee |
| `detail-20152-fee-dot.html` | "1.450 EUR" |
| `detail-73336-tbilisi.html` | a course in Tbilisi, Institution "N/A", a fee option with decimals |
| `detail-72548-card-deadline-only.html` | its card says "Deadline: 30 November"; the page does not |
| `not-found-404.html` | a course page that does not exist |

Institution "N/A" appears on the Tbilisi course (`detail-73336-tbilisi.html`); the parser stores it as none.
