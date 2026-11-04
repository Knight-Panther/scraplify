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

Ten depths of each list were sampled.

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
