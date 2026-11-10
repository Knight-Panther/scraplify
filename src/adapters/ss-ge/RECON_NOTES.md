# ss.ge reconnaissance notes (Phase 11B)

The full study and the design built on it is [`docs/real-estate-implementation-guideline.md`](../../../docs/real-estate-implementation-guideline.md) (live read-only study, 2026-10-12). This file is the adapter's short working record: what the code relies on, and what was measured while building it.

Every request was a plain GET of a public page with the project's User-Agent, one at a time, at least 3 s apart. No sign-in, no form, and never the site's own JSON gateway or the access token its pages embed.

## Acquisition decision

**`http` only.** `home.ss.ge` is a Next.js site behind Cloudflare, and every page carries its data as one JSON block, `<script id="__NEXT_DATA__">`, under `props.pageProps`. Nothing is read from the rendered HTML.

| Purpose | Request |
|---|---|
| One page of a list, newest first | `/ka/udzravi-qoneba/l/<kind>/<deal>?order=1&page=N` |
| One listing | `/ka/udzravi-qoneba/<id>` (the site ignores any slug) |

Kinds: `bina` (flat), `kerdzo-saxli` (house), `agaraki` (summer cottage). Deals: `iyideba` (sale), `qiravdeba` (long-term rent). That is six lists; `SS_GE_LISTS` walks them smallest first.

## What the parsers rely on

- **Results page:** `pageProps.applicationList.realStateItemModel` (16 rows a full page) and `pageProps.initialPage`.
- **Row fields:** `applicationId`, `type` (5 flat, 4 house, 1 cottage), `dealType` (4 sale, 1 rent), `title`, `totalArea`, `floorNumber`, `totalAmountOfFloor`, `numberOfBedrooms`, `price` (`priceGeo`, `priceUsd`, `unitPriceUsd`, `currencyType` 1 lari or 2 dollars), `address`, `orderDate`, `createDate`, `vipStatus`, `similarityGroup`, `description`, and whether `userInfo` is present.
- **Listing page:** `pageProps.applicationData` with `applicationId`, `status` (`Active` or `Expired`), `isInactiveApplication`, `endDate`. A page with no `applicationData` is a listing that does not exist.
- **Never read, logged or stored:** `pageProps.credentialsToken`, `userId`, `userInfo.name`, `applicationPhones`, `contactPerson`.

## Traps, each with a test

1. **A page past the end of a list answers HTTP 200 with page 1.** `parseResultsPage` compares `initialPage` with the page asked for. The walker asks twice before believing it, because one such answer in the middle of a list would end a sweep thousands of pages early.
2. **Times are Tbilisi wall-clock whatever follows them.** 801 of 1,328 sampled rows ended in `Z` and were still local time.
3. **A missing listing is not a 404.** It is a 200 with no listing in it. A page that fails to load, or a challenge page, must never be read as that: it says nothing about its listing.
4. **Rows have no room count.** It is in the title ("3 ოთახიანი"); some cottage titles have none.
5. **`floorNumber` is a string** and can be empty, a list (`7, 10, 11, 13, 15`) or a range (`2-14`); only a single whole number is kept.
6. **A price or bedroom count of 0 means unknown.**
7. **Without `order=1` a list is promoted-first**, and a walk that stops at the first old row stops in the wrong place. `isSsGeUrlAllowed` refuses a results address without it.
8. **A page with no rows is a fault, not an empty list.** Every list holds hundreds of listings at least.
9. **Posters paste control characters into text.** One description held U+0000 between two words (listing 36827800), Postgres refused the row, and the first pass ended at page 1,472 with 23,531 listings stored. The list parser now drops control characters other than whitespace from every text field. A run ended this way resumes five pages back.
10. **Posters type phone numbers into the address.** The street number is free text and shown on the public site. The first pass held 60 street numbers with seven digits or more in one run: bare and spaced mobile numbers, a number after a building's name, long digit strings, and once a whole pasted advert with its contact line. No street name held one. A street name or number with a phone-shaped run (seven digits or more, at most three spaces, dots, dashes, slashes, brackets or plus signs between each pair; a comma breaks the run) is dropped whole.

## How the lists are ordered (measured 2026-10-12, 84 requests)

Ten depths of each list were sampled. Measured again on 2026-11-10 ("The end of a list holds every listing past its 30 days", below): the sale lists no longer end with the business block.

- **The first 90–95% of every list is in strict order of `orderDate`**, newest first, running from now to about 29 days old. Sixteen rows of one page span minutes near the top and a day or less in the middle.
- **Rent lists then end with listings 30–45 days old**, none posted by a business.
- **Sale lists end with a block of business listings in no date order**, up to 943 days old among rows a week old: about the last 5% of flats for sale, and the last pages of houses for sale.

| List | 25% deep | 55% deep | 85% deep | Last page |
|---|---|---|---|---|
| Flats for sale | 4 days | 14 days | 28 days | 6–943 days, all business |
| Flats for rent | 4 days | 12 days | 24 days | 30–42 days, no business |
| Houses for sale | 6 days | 17 days | 26 days | 5–348 days, all business |
| Houses for rent | 6 days | 18 days | 27 days | 36–42 days |
| Cottages for sale | 6 days | 17 days | 28 days | 4–45 days |
| Cottages for rent | 2 days | 18 days | 27 days | 34–43 days |

What follows from it:

- The nightly stop rule (a page holding only rows older than the last completed run's start, less six hours) is sound: it works in the ordered part, which is where every new or renewed listing lands.
- **"Thirty days of life" is not the whole story.** A listing the site still shows after its thirty days plainly runs longer, and only its own page says until when. Those are checked first (`loadListingsDueForCheck`).
- The business block is reached by sweeps only. Its listings are kept alive between sweeps by a check every thirty days.

## Listing life (first evidence, 2026-10-12)

The trial run checked the 13 cottage-for-rent listings older than 30 days. All 13 were `Active`, none from a business, and each had an `endDate` of exactly `orderDate` plus 45 days. The study's eight listings with a 30-day life may all have been business listings.

Until the first full pass says more, the parser keeps 30 days for every listing: a listing that outlives it costs one check and is extended, where a wrong 45 would show a dead listing for two weeks. If the first pass confirms 45 days for listings with no `userInfo`, setting that in `list.ts` saves about a thousand checks a night.

**Confirmed by the first pass (2026-10-15, 1,036 listing pages checked):** of about 960 listings no business posted, checked once past their 30 days, 890 had an end exactly 45 days after their order time and most of the rest 38 to 44; five had ended. No agency listing came due past 30 days, which fits the rent lists' tails holding no business listings. Developers' listings ran longer (63 to 65 days here), and a check extends a listing at most 30 days ahead, so they are looked at monthly whatever the parser expects. `list.ts` now expects 45 days for a listing with no `userInfo` and 30 for an agency's or a developer's.

**Corrected 2026-11-09: 30 days for every listing again.** The owner found two flats on the tab that ss.ge had ended 16 days before. The first pass's sample was of listings checked past their 30 days, and only an owner's own listing reaches that check alive.

- **Who gets which life:** of the pages read when the listing was 16 to 29 days old, 5,677 of 5,976 brokers' had an end 30 days after the order time, and 245 of 263 owners' had 45 (`userEntityType` on the page).
- **What a results row says:** a business (`userInfo`) or nothing. Nothing covers brokers and owners alike, about nine brokers to one owner. So 45 days for "nothing" kept a broker's dead listing on the tab for up to 17 days: its 15 extra days and the two days of grace.
- **Measured on ss.ge the same day**, 42 listing pages from the operator PC:
  - both reported flats read `Expired`;
  - of 30 random listings shown on the tab, with no business named, past their 30 days, never confirmed by their page and not listed since, 23 read `Expired` and 7 were live, each an owner's with 45 days. Of 285,946 shown listings 11,396 fitted that description, so about 8,800 dead listings were on the tab;
  - of 10 random listings seen in the last two nights, 9 were live and 1 page was blank.
- **Why the checks did not catch them:** a full read had flagged both flats as missing on 2026-11-01, but the queue takes the longest-lived first, about 10,000 pages a night, and 10,804 flagged listings were waiting. Of that night's 10,112 checks, 4,807 were of listings seen in the week before and flagged since, and 95% of those had ended: brokers' listings at their 30 days, which the right expected end hides with no request at all.
- **The fix:** `LISTING_LIFE_MS` in `list.ts` is 30 days for all, as guideline §9.3 rule 1 always said. An owner's listing still listed after its 30 days is the first a run asks (`loadListingsDueForCheck`), and its page gives the real end. Migration `0052` gives the stored guesses the same end, leaving alone any end a page has confirmed since the last renewal and any listing seen after its 30 days. Rehearsed on that morning's copy of production: 160,587 rows in 8 seconds, 6,444 fewer shown, both flats off the tab with ss.ge's own end dates, and a second run touches nothing. Of the 30 sampled, the 9 the next run would give up as lapsed were all dead.
- **The lesson:** an expected end is a guess that nothing corrects until it runs out, so it must be the shortest life any poster of that kind gets; the page lengthens it. And a lifetime measured on listings that were still alive when checked says nothing about the ones that had already ended.
- **Also found, not fixed here:** since Phase 12B went live no page has been read for its details alone. The checks come first and take the whole night, so 54,964 new or changed listings were waiting on 2026-11-09. The fix removes about half of a night's checks; see whether the queue drains with 12B's first-week numbers.

## Trial run (2026-10-12, from the development machine)

`--mode=sweep --max-pages=25 --max-detail-checks=15` into a throwaway database:

| Measure | Value |
|---|---|
| Requests | 38 in 148 s, none failed, no back-off |
| Results pages stored | 25 (all 21 of cottages for rent, 4 of cottages for sale) |
| Listings stored | 393, each once |
| End of list | Found at page 21, a short page of 9 rows |
| Listing pages checked | 13, all live and extended |

Coverage of the 329 cottages for rent: rooms on 306, both prices on 308, a city on all, a sub-district on 63 (cottages are mostly outside Tbilisi), a description on 226, a business poster on 183.

## First pass (2026-10-12 to 2026-10-16, from the development machine)

| Measure | Value |
|---|---|
| Sweep | 7,320 pages over 16 runs (two shutdowns, a power cut, hours of HTTP 500 on flats pages), 110,698 listings, 1,023 listing pages checked |
| Catch-up | One nightly run of 2,016 pages back to the sweep's start (a first attempt ended on an HTTP 500 at flats for rent page 472 and was retried), 130,000+ listings in all |
| Sweep alone against §4.4 | Flats for sale −8.9%, flats for rent −5.7%, houses and cottages within 3% |
| After the catch-up | Every list 9% to 15% above §4.4's count of 2026-10-12: four days of new and renewed listings, none expired yet |
| Size | `realestate.listings` 208 MB of table, 65 MB of indexes |

**A slow sweep misses what moves above it.** A list newest first, walked over 10 to 25 hours, gets new and renewed listings at its top the whole time: they land above the walk, and the rows they push down are read twice (flats for sale: about 41,800 rows read, 37,821 distinct). The nightly run's read back to the walk's start is what picks them up, so a first pass is a sweep and then one nightly run.

## Recon 2026-11-03: every kind and deal (Phase 12, from the development machine)

Owner decision the same day: our filters identical to ss.ge's, so all six kinds for all four deals. Read live, one request at a time, 3 s apart.

**Addresses:** `/ka/udzravi-qoneba/l/<kind>/<deal>?order=1&page=N`, 16 rows a page. The kind and deal are both always named; the kindless `/l/qiravdeba-dghiurad` hub is not read.

| Kind | Slug | Row `type` | | Deal | Slug | Row `dealType` |
|---|---|---|---|---|---|---|
| flat | `bina` | 5 | | sale | `iyideba` | 4 |
| house | `kerdzo-saxli` | 4 | | rent | `qiravdeba` | 1 |
| cottage | `agaraki` | 1 | | daily | `qiravdeba-dghiurad` | 3 |
| commercial | `komerciuli` | 6 | | pledge | `giravdeba` | 2 |
| land | `mitsis-nakveti` | 3 | | | | |
| hotel | `sastumro` | 2 | | | | |

**Readable listings per list (`initialCardCount`), smallest first, which is the walk order:** land-daily 1 · hotel-pledge 3 · cottage-pledge 8 · commercial-pledge 14 · commercial-daily 21 · land-pledge 88 · hotel-daily 165 · house-pledge 176 · land-rent 210 · cottage-rent 381 · cottage-daily 739 · flat-pledge 758 · cottage-sale 975 · hotel-sale 2,188 · flat-daily 3,329 · house-daily 3,625 · hotel-rent 3,785 · commercial-sale 8,571 · house-sale 13,319 · land-sale 22,295 · house-rent 22,853 · commercial-rent 32,082 · flat-sale 44,295 · flat-rent 45,923. About 205,800 in all, 78,000 more than the six lists of version 1.

**Speed:** results pages 0.3–1.0 s (6.8 s median in October), listing pages 0.1–0.6 s. At the policy's spacing a page costs about 3.5 s, so reading all 24 lists whole (~12,900 pages) takes about 12.5 hours. A nightly run reads whole as many of the least recently read lists as fit 4,000 pages (`DEEP_PAGE_BUDGET`), so each list is read whole every three or four nights.

**Results rows also carry** (stored since Phase 12A):
- `commercialRealEstateType`: 6 warehouse/production, 7 office, 13 catering, 14 garage, 21 basement, 22 retail, 31 commercial space, 0 none.
- `landType`: 1 agricultural, 2 non-agricultural, 3 commercial, 4 special, 5 investment, 6 farm. Null or 0 when none.
- `imageCount`, `furniture` and `withBuiltInKitchen` (true, false or null), `isExclusive`, `hasRemoteViewing` (video viewing), and `price.unitPriceGeo`.
- `address.municipalityId/Title`: the key is present but was null in every sampled row.

**Only on a listing's own page** (`pageProps.applicationData`, read from Phase 12B): building status (`realEstateStatusId`, 2 = new build; set on about 86% of flats for sale), condition (`state`), project, floor type, bathrooms, balconies, kitchen, house and yard areas, the poster's type, about 33 amenities, coordinates and municipality. Phones, contact names and user ids are never read.

**Traps:**
- **An empty list is normal:** HTTP 200, page 1, `initialTotalApplicationCount` 0, no rows (`results-empty.html`). The walker finishes such a list instead of calling it a fault; any other page with no rows is still a fault.
- **Transient errors:** the commercial daily-rent list answered HTTP 500 once and 200 minutes later; listing 7188875 rendered "no listing" once and was live minutes later.
- **ss.ge's own status filter cannot label rows:** `realEstateStatuses=1` and `=3` return the same top rows.
- **Daily rent is priced per night** ($6 to $450 a night on the first page, 2026-11-03), and land runs to tens of thousands of m² at a few dollars a m². The typo rule for the price and area sorts has bounds per deal and leaves large cheap plots alone (`src/realestate/queries.ts`).

## Trial 2026-11-04: listing pages (Phase 12B, from the development machine)

A nightly run into a disposable database with `--max-pages=60 --stop-after-hours=1`, after a 30-page sweep seed:
- **Pace:** 1,002 requests in 1 h 0 m, 3.6 s each. The time box ended it, as built: no request after the hour, and the run saved its counts on the way out.
- **Pages read:** 854 listing pages had their details saved, and `details_count` was 854. Another 238 listings stayed wanted for the next run.
- **"No listing" is common and passes:** 84 of the 942 listing pages asked (9%) answered "no listing" for listings their list had shown minutes before. They were spread over nine kind-and-deal pairs, and in each pair most pages read fine. One of them, read by hand right after, was live. All 84 were left unsettled and still wanted, so they are read again next run. Only 4 requests failed outright.
- **What the pages carry,** of the 854 read: the poster's type always; amenities 81%; building status 71%; condition 68%; municipality 59%; coordinates 35%.

## Not yet measured

- How many listing pages a 16-hour night reads, how long the run takes, and the share of active listings with details after a week (B6 step 4).

- How many listings a night reach their expected end without being seen again, and what share of those is still live. That decides whether 1,000 checks a night is enough.
- Whether an edit always moves a listing's `orderDate`.
- Other end states than `Active` and `Expired`.

## Measuring dead listings on the tab

When someone finds a listing on the tab that ss.ge has ended, measure before changing a rule. It took 42 requests on 2026-11-09.

1. **Read the listing's row** on the host (read-only, as `scraplify_backup`): `source_updated_at`, `expected_end_at`, `last_seen_at`, `verified_at`, `missed_at`, `poster_type`. A row seen once, never verified, flagged missed and close to its expected end is the 2026-11-09 case.
2. **Draw two random samples** of shown listings, by `order by md5(source_listing_key || '<any salt>') limit 30`. "Shown" is `status = 'active'` and the later of `expected_end_at` and `last_seen_at` within two days (`src/realestate/filters.ts`).
   - Suspects: the pattern the reported listing fits. On 2026-11-09: `poster_type = 'unknown'`, `verified_at is null`, `source_updated_at + interval '30 days' < now()` and `last_seen_at < source_updated_at + interval '30 days'`.
   - Control: `last_seen_at > now() - interval '2 days'`.
3. **Ask ss.ge** from the operator PC: `npm run build`, then `node scripts/ss-ge-ask-listings.mjs suspect=<ids> control=<ids>`. It uses the crawler's fetcher, spacing and parser, and writes nothing.
4. **Size it:** the dead share of the suspects times how many shown listings fit the pattern.

Two numbers to watch after any change to the expiry rules: how many flagged listings wait for a check (`missed_at is not null`, 10,804 on 2026-11-09), and how many pages wait to be read for their details (`details_wanted_at is not null and details_read_at is null`, 54,964).

## One results page ended a whole night (2026-11-09)

The run of 2026-11-09 21:30 UTC ended `partial` at 21:39 with 49 requests. Flat-daily page 9 came back four times over six minutes (the retry waits of `3ce5634`: at once, after a minute, after five) as a full 112 KB page with its title and no listing list; the same URL loaded fine the next afternoon from the PC and from the host through the proxy, 41 KB compressed. It read then as a moment of trouble on ss.ge, like flat-rent page 130 on 2026-11-05 at 17:00; the next day showed otherwise (below). The crawl treated a page that would not load after its tries as the site refusing, which also cancels everything after the walk, so the night checked nothing, lapsed nothing and made 13A's first deletions wait: 37,634 listings past their end, 10,804 flagged missing and 3,904 gone 14+ days were waiting the next afternoon.

**The cause, found the next day: one listing breaks whichever page holds it.** On 2026-11-10 at 16:01 UTC the same list failed again, on page 39, four times over six minutes, while pages 38 and 40 loaded, from the host and from the PC alike. The broken page answers HTTP 200 with its title and the usual page data but no `applicationList` at all (20 KB compressed where a good page is 41 KB). Flats for daily rent gain about 26 new or renewed rows an hour, which is 30 pages in the 18.5 hours between the two failures: the same listing, pushed down. So this is not a moment of trouble but a page that will not load on any try, every night, until that listing ends. The earlier idea that ss.ge had served a data-less page "for at least six minutes" was wrong; page 9 loaded the next afternoon because the broken listing had moved off it.

**What the crawl does (PR #89, then the skip):** a page that will not load after its four tries is passed over, and the walk goes on with the next page of its list; the run completes, its notes naming the page last. The rows on that page are not seen that night; those a full read then flags as missed are asked by their own pages. Page 1 is never passed over, nor a second page in a row, nor more than five pages in a run: that list is given up for the run (`partial`, the page named first, which Hermes reads as `pages_failed`) and resumed by the next, while the other lists, the checks, the details, the lapses and the deletions go on. Three lists given up end the walk. Leaving the list at the broken page, as PR #89 alone did, would have stopped that list at the same listing every night, and worse: a walk with a list left unread is resumed, not started again, so no other list would have been read either until the walk was a week old.

**To look at one:** fetch the page before and after it (`curl --compressed` with the crawler's user agent from a Georgian connection) and look for `realStateItemModel`. If the neighbours load, it is a broken listing and needs nothing. If a night still ends early, read the run's notes: a refusal (403, 429, a slow-down header) or the proxy staying away is the site or the laptop, and still ends the run.

## The end of a list holds every listing past its 30 days (2026-11-10)

From the day the tab dropped its two days of grace, a live listing past its 30 days was hidden until its own page was asked, and a night has listing pages for about a third of those asking. The lists themselves answer it, sixteen listings to a request.

**The order, measured again** (27 requests from the operator PC, eight depths of three lists). Land for sale (21,895 rows, 1,369 pages), flats for sale (47,098; 2,944) and flats for rent (47,501; 2,969) are in date order to their very end:

| List | 50% deep | 80% | 92% | 95% | 97.5% | 99% | Last page |
|---|---|---|---|---|---|---|---|
| Land for sale | 15 days | 25 | 29 | 34 | 40 | 43 | 45.0 |
| Flats for sale | 7 days | 20 | 27 | 29 | 31–33 | 40 | 45.0 |
| Flats for rent | 8 days | 21 | 26 | 28 | 29 | 36–38 | 44.9 |

Every row past the 30-day line names no business. The block of business listings "in no date order" that ended the sale lists on 2026-10-12 is no longer at the end: a page of developers' listings 34 days old sat 40% of the way down flats for sale, with ends a year and more ahead.

**Is a row there alive?** 54 rows past their 30 days, from five pages of three lists, each asked by its own page: 52 live, 2 a blank page (which says nothing: trap 3, and guideline §9.3 rule 3). Of the 52, 48 had an end exactly 45 days after their order time. The other four had less (38 to 44.9 days) and ended with their neighbours on the page: their order time had moved (below). So a row its list still shows past its 30 days is live, and nearly always an owner's on its 45 days.

**What the crawl does with it** (`readListTail` in `crawl.ts`, `endAfterSighting` in `src/realestate/ingest.ts`): after the walk, each list the run stopped early is read from its last page backwards until a page holds no row past its expected end. A row seen past its 30 days stays on show for sixty hours from the sighting, and never past its order time plus 45 days where it names no business. No listing page is asked for it. Guideline §9.2 and §9.3 rule 2 have the rules.

**A list places a row by its real start, not by its order time.** A few rows on a page are much newer than their neighbours by `orderDate`. 31 pages of flats for sale and for rent between 10% and 95% deep held 10 such rows among 496 (2%); a thirty-second page, the developers' one, is left out. Asked by their own pages, all 10 ended where their neighbours do: seven (brokers' and agencies') 30.00 days after the page's median order time, three (owners') 45.00 days after it. Their own order time was 1.4 to 23 days later, so `orderDate` moves on some edit that does not renew the listing, and the list goes on ordering it by when its time began. For the seven, order time plus 30 days is 1.4 to 18 days too late (9 on average): the tab would show them dead that long, unless a full read of their list flags them missing first (guideline §9.3 rule 6) and their page is asked. Not acted on yet: the page's median order time would give such a row its real end, but the same bound would wrongly end a broker's row that sits among developers' long-running ones (one did, on that page 40% down flats for sale), so it needs the mixed pages sampled first.

**Results pages fail more in ss.ge's evening.** In runs started between 16:00 and 17:00 UTC, 3.5 to 7.7% of results requests came back without their list (deep pages of houses for rent about one in eleven), against 0.1 to 0.3% at night. They load on the immediate retry, rarely only on the third try. So the fault of 2026-11-05 at 17:00 (flat-rent page 130, three tries with no waits) fits bad luck, not a broken listing, and a page passed over in a run started by hand in the evening may be chance: look at the next night before taking it for a broken listing.
