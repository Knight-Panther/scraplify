# Real estate tab: study and implementation guideline

**Status:** proposal, awaiting the owner's review. Nothing is built: no branch, no migration, no code. `docs/STATUS.md` and `docs/scraplify-concept.md` are unchanged.
**Date of measurements:** 2026-10-12, 11:50–13:20 UTC (15:50–17:20 in Tbilisi).
**How it was measured:** about 300 read-only requests across `www.myhome.ge` and `home.ss.ge`, one at a time, 2–3 s apart, from a Georgian residential connection. Most were `curl`, sent both with a desktop browser User-Agent and with the project's own `ScraplifyBot/0.1 (+https://github.com/Knight-Panther/scraplify)`. Three Playwright page loads watched what each site's own frontend requests. Five more fetches came from a hosted fetch tool on a datacenter IP (not our server), and twelve from the production server itself at 13:30 UTC (§7.1). No sign-in, no form submission, no state-changing request. Every number below is a dated observation, not a guarantee. Re-measure before building and keep the fresh results in each adapter's `RECON_NOTES.md`, as was done for the other three sources.
**What this document is:** the study and the build guideline in one place, in the manner of `docs/addEtender.md`. It fixes the design and the order of work. Each phase still gets its own step-by-step plan before code is written.

---

## 1. Summary

- **What is being built:** a Real estate tab on the website that pulls residential listings from myhome.ge and ss.ge into one searchable, filterable table, refreshed daily, with every row linking to the original listing. Website only; a ChatGPT, Claude or local-LLM connection is deferred.
- **Verdict:** feasible with plain HTTP on both sites. Both are Next.js sites that embed their data as JSON in every page, so no browser is needed. Both answered the project's own bot User-Agent normally from this machine: no challenge, no CAPTCHA, no 429 in about 300 requests.
- **Size:** about 282,000 residential listings on myhome.ge and about 288,000 counted on ss.ge (flats and houses, sale and long-term rent). The whole job and tender corpus is 15,700 listings, so this is a different order of magnitude.
- **myhome.ge is the easy source.** Twelve sitemap files list every live listing with a last-modified day, so one cheap nightly read tells us what is new, changed or gone. Results pages return 24 listings in about 1.5 s.
- **ss.ge is the hard source.** Results pages take about 7 s, hold 16 listings, and silently return page 1 when asked for a page past the end. The results list hides listings the site considers duplicates, so its counter overstates what can be read. There is no sitemap of listings, so removal has to be inferred.
- **Duplicates dominate.** In one sampled slice, 84–86% of myhome.ge rows had at least one duplicate, and 68% of each site's rows matched a flat on the other site. A raw combined table would show the same flat dozens of times, so grouping identical listings is the main value the tab adds (§6.1).
- **Biggest blocker, measured:** from our production server, myhome.ge answers every page except `robots.txt` with a Cloudflare challenge (HTTP 403), whatever the User-Agent. ss.ge serves the server normally. myhome.ge can be developed and crawled from a Georgian connection today, but running it on the server needs TNET to allow our server first (§7.1).
- **Isolation:** real-estate data lives in its own Postgres schema with its own crawl schedule. The vacancy and tender pipeline is touched in exactly two places, both to make it ignore the new sources (§8.2).
- **Order of work:** gates first (§7), then foundation, myhome.ge, the tab, ss.ge, duplicate grouping, hosted rollout (§16).

---

## 2. Decisions

### 2.1 Made by the owner on 2026-10-12

| Decision | Detail |
|---|---|
| Website first | Build the tab on the site. Any LLM or connector work comes later and is out of scope here. |
| Sources | myhome.ge and ss.ge, on a verbal OK from both. |
| Scope of version 1 | Flats and houses, for sale and long-term rent, all of Georgia. |
| Presentation | Text-only rows, no photos. Each row links to the source. |
| Separation | A separate tab and a separate table structure, not merged into vacancies and tenders. |
| Architecture | Own tables in their own Postgres schema, reusing the shared fetching and policy plumbing; myhome.ge first, then the tab, then ss.ge. |

### 2.2 Recommended here, each needs the owner's yes

| # | Question | Recommendation | Why |
|---|---|---|---|
| 1 | What to do about myhome.ge challenging the server (§7.1) | Ask TNET to allow our server's outbound IP and User-Agent. Do not route around the challenge. | Concept §4.3 rules out circumventing access controls and proxy rotation. The verbal OK makes an allow-list a small ask, and it is a few minutes' work on their side. |
| 2 | Request budget agreed with each site | Up to 2,000 requests a night per site in routine running, plus a one-off first pass (about 12,000 for myhome.ge, up to about 18,000 for ss.ge). One request at a time, 2 s apart on myhome.ge and 3 s on ss.ge. | The volume is what a site would notice. Agreeing it turns a verbal OK into something that survives a traffic review on their side. |
| 3 | How to read ss.ge | Ask ss.ge whether they prefer we use a feed or their JSON gateway. Until they say so, read the public pages only. | Their own frontend pages through a JSON gateway with a site-issued token (§5.8). It would be faster and lighter for them, but using it uninvited is not "reading public pages". |
| 4 | Summer cottages (აგარაკი) | Include them as a third property kind. | About 2,000 listings on myhome.ge; residential; the same filters apply. |
| 5 | Listing descriptions | Store and search them; do not display them on the public site. | Same reasoning as the 2026-10-07 decision for the job boards: keep visitors clicking through to the source. |
| 6 | Default view | Group identical listings into one row, with a switch to see every listing. Launch publicly only once grouping exists. | §6.1: without it the table is mostly repeats. |
| 7 | Backups | Leave listing rows out of the nightly backup; keep price history and the location dictionary in it. | Listings can be re-crawled in about a day. The backup must stay inside the R2 free tier (owner decision, 2026-09-30). |
| 8 | Name and address of the tab | `/real-estate`, labelled "Real estate" and "უძრავი ქონება". | Matches the sites' own wording. |
| 9 | Concept amendment | Add a short §31 to `docs/scraplify-concept.md` recording real estate as a second domain. | The concept is written around "opportunities" and takes precedence over everything else, so the new domain has to be in it. |

---

## 3. Scope of version 1

**In:** flats, houses and (if approved) summer cottages; sale and long-term rent; all of Georgia; both sites; one row per listing with deal, kind, rooms, area, floor, price, location, street, who posted it (owner or agent, where the site says), when it was updated, and a link to the source; filters, sorting and text search; grouping of identical listings; a price-change record per listing.

**Out, by decision or by this document:** photos; phone numbers and people's names (never stored); daily rent, land, commercial property and hotels; pledge deals; listing detail pages as a routine source (so no map and no "near the metro" yet); alerts (dropped project-wide on 2026-09-27); anything involving an account on either site.

**Later, once version 1 runs:** detail-page enrichment (coordinates, condition, build year); the left-out kinds; photos if the sites agree; a connector.

---

## 4. myhome.ge: findings

### 4.1 Platform

| Item | Finding |
|---|---|
| Operator | TNET (შპს „თინეთი"), which signs the usage and privacy page at `auth.tnet.ge/ka/usageagreement` |
| Stack | Next.js (pages router) behind Cloudflare. Every page carries its data in a `<script id="__NEXT_DATA__">` JSON block, as a React Query cache under `props.pageProps.dehydratedState.queries`. |
| Where the data sits | Results: the query whose key starts `["statements","list", …]`, rows at `state.data.data.data`. Detail: key `["statements","details", …]`, record at `state.data.data.statement`. |
| Build id | `buildId` in the JSON block. It changes on every site deploy and is part of the JSON data routes (§4.7). |
| Time zone | Timestamps are Tbilisi wall-clock with no zone marker (`2026-10-12 16:48:34` was fetched at 12:50 UTC). Georgia is UTC+4 all year. |
| Bot handling from this machine | None seen. Bot and browser User-Agents got identical answers. |

### 4.2 robots.txt and terms

```
User-agent: *
Disallow: /makler/*
Disallow: /makler?maklerId=*
Disallow: /product?*
Disallow: /help/
Disallow: /contact/
Allow: /
Allow: /udzravi-qoneba/*
Allow: /udzravi-qoneba*
Allow: /en/real-estate/*      (and the Russian equivalents)
Sitemap: https://www.myhome.ge/sitemap_index.xml

User-agent: *
Content-Signal: ai-train=no, search=yes, ai-input=yes
```

No `Crawl-delay`. The listing paths are explicitly allowed. The content signal permits search use and forbids AI training, which matters for any later LLM work. The TNET usage page was read in a browser and searched for clauses on automated access, copying and database rights: none was found. It is mainly a personal-data policy, and a separate site-rules document was not found.

### 4.3 Size, by the site's own counter

| Scope | Listings |
|---|---|
| Everything | 349,050 |
| Sale / long-term rent / daily rent | 127,580 / 214,718 / 6,298 |
| Tbilisi, everything | 297,798 (85% of the site) |
| Flats and houses, sale and long-term rent, all Georgia | 284,460 |
| Tbilisi flats for sale | about 77,000, of which 5,924 with `owner_type=physical` (not checked against rows) |
| One neighbourhood: Saburtalo flats for sale | 19,204 |

A Tbilisi-only version would save 15%, so geography is not a useful cut.

### 4.4 Sitemaps: the inventory

`https://www.myhome.ge/sitemap_index.xml` lists twelve files named `sitemap-listings-N-ka.xml`.

| Property | Measured |
|---|---|
| Listings | 345,711, every id unique. Eleven files of 30,000 and one of 15,711. |
| Order | By listing id, ascending. File 1 holds the oldest ids, file 12 the newest. |
| Per listing | The URL and a last-modified **day** (`<lastmod>2026-10-11</lastmod>`), no time |
| URL shape | `https://www.myhome.ge/udzravi-qoneba/<slug>-<id>/` |
| What the slug tells us | Deal, room count, kind and area name, e.g. `iyideba-3-otaxiani-bina-saburtaloze`. All 345,711 slugs gave a known kind, and all but 138 (a land-lease deal, `gaitsema-ijarit`) a known deal, without fetching anything. |
| Regeneration | All twelve carried `Last-Modified: Mon, 12 Oct 2026 01:33 GMT`. Observed on one day only. |
| Cost | 111–325 KB each compressed (about 4.4 MB raw for a full file), 0.4–0.9 s each, about 2.7 MB a night in total |
| Conditional requests | `ETag` is sent, and `If-None-Match` returned `304` |

Classified by slug: rent/flat 168,377; sale/flat 88,156; rent/commercial 25,995; sale/land 18,661; rent/house 15,671; sale/house 10,194; sale/commercial 6,395; daily/flat 3,464; rent/hotel 2,892; daily/house 1,953; sale/hotel 1,358; sale/cottage 849. **Flats and houses for sale or long-term rent: 282,398 (81.7%).**

How fast it changes, read from the last-modified days:

| Window | Listings modified | Share |
|---|---|---|
| The last 7 days | 97,085 | 28.1% |
| The last 14 days | 176,416 | 51.0% |
| The last 30 days | 345,238 | 99.9% |

- **A listing lives 30 days unless renewed.** Almost nothing in the sitemap is older than that.
- **About 12,400–16,300 listings are modified on a weekday**, and 5,400–10,100 on a Saturday or Sunday.
- **New ids arrive at roughly 7,000–11,000 a day** (estimated from id growth during the day). Comparing two consecutive nightly sitemaps will give the exact figure for free.

A thirteenth file, `sitemap-listings-13-ka.xml`, exists with 777 URLs and an older date but is not in the index. Read only what the index lists.

### 4.5 Results pages

| Property | Measured |
|---|---|
| Address | `/udzravi-qoneba/?<filters>&page=N` |
| Page size | 24 listings |
| **Hard cap** | **Page 400 is the last page that returns rows** (9,600 listings per query). Page 401 and beyond answer HTTP 200 with zero rows. |
| Speed | Median 1.5 s over 22 consecutive pages, maximum 2.9 s. One broad multi-value query took 37 s. |
| Sorting | `order_by=date` or `price`, with `sequence=desc` or `asc`. The default is date, newest first. |
| Promoted listings come first | Within any sort, paid tiers lead: super-VIP, then VIP+, then VIP, then ordinary listings, each tier newest first. For a 77,000-listing query, pages 1–3 were super-VIP, page 10 was VIP+, and page 40 was ordinary. |
| Filters confirmed | `deal_types`, `real_estate_types`, `cities`, `urbans`, `room_types`, `area_from`, `area_to`, `price_from`, `price_to` with `currency_id=2` for US dollars. Comma-separated lists work (`deal_types=1,2`). |
| No date filter | The site offers no "posted in the last N days" filter. |
| Other languages | `/en/real-estate/` and `/ru/nedvizhimost/` return the same rows |
| Light version | `/_next/data/<buildId>/ka/udzravi-qoneba.json?<filters>&slug=udzravi-qoneba&page=N` returns the same data as JSON, about 42 KB instead of 75 KB |

Codes: `deal_types` 1 = sale, 2 = long-term rent, 3 = pledge, 7 = daily rent. `real_estate_types` 1 = flat, 2 = house, 3 = summer cottage, 4 = land, 5 = commercial, 6 = hotel. `cities` 1 = Tbilisi, 15 = Batumi. `currency_id` 1 = lari, 2 = US dollar. `room_types` 1–5 mean 1–5 rooms, then **7 = 6 rooms, 8 = 7, 9 = 8, 10 = 9, 11 = 10 or more** (there is no id 6).

### 4.6 What a results row contains

58 fields. The ones version 1 uses: `id`, `deal_type_id`, `real_estate_type_id`, `room`, `bedroom`, `area`, `yard_area`, `floor`, `total_floors`, `price` (lari under key `1`, dollars under `2`, euros under `3`, each with a total and a per-m² figure), `currency_id` (the currency the poster chose), `price_negotiable`, `address` (street text), `street_id`, `city_id` and `city_name`, `district_id` and `district_name`, `urban_id` and `urban_name`, `last_updated`, `status_id` (1 old build, 2 new build, 3 under construction), `user_type.type` (`physical`, `agent`, `broker` or `developer`), the three VIP flags, and `comment` (the description).

- **The description is complete in the results row.** It matched the detail page character for character on a 2,106-character sample.
- **No coordinates.** `lat` and `lng` were empty on every results row checked.
- **Personal data is present and must be dropped at parse time:** `user_title` (a first name), `user_id`, and on detail pages `owner_name` and `user_phone_number`.

### 4.7 Detail pages

| Property | Measured |
|---|---|
| HTML | `/udzravi-qoneba/<slug>-<id>/`, about 60 KB, about 1 s |
| JSON | `/_next/data/<buildId>/ka/udzravi-qoneba/<slug>-<id>.json?slug=udzravi-qoneba&slug=<slug>-<id>`, about 20 KB, about 1.2 s |
| Adds over a results row | `lat`, `lng`, `created_at`, `condition`, `build_year`, heating, parking, balcony and storeroom details, `is_active`, `views` |
| Wrong slug | `308` redirect to the canonical address, so a listing can be reached by id alone |
| `/pr/<id>/` | `301` to `/udzravi-qoneba/<id>/` |
| A listing that does not exist | **HTTP 200** with a detail page that carries no detail record. Never a 404. |
| A stale `buildId` on the JSON route | HTTP 404 |

### 4.8 Public JSON endpoints the site's own pages call

These were seen in the network log of an anonymous page load, so a normal visitor's browser calls them too.

| Endpoint | What it returns | Use for us |
|---|---|---|
| `api-statements.tnet.ge/v1/statements/count?<filters>` | Total and page count for a filter set | Optional, for planning slices. Sends `x-ratelimit-limit: 1500`. |
| `api-statements.tnet.ge/v1/statements/statement-parameters?lang=ka` | The code lists in §4.5 | Reference only |
| `api-locations.tnet.ge/v2/cities` | 126 cities, their districts and sub-districts ("urbans"), each with Georgian, English and Russian names, a slug and coordinates. Sends `x-ratelimit-limit: 500` and `access-control-allow-origin: *`. | A one-time seed for the location dictionary (§12.1) |
| `api-statements.tnet.ge/v1/statements` (the listings themselves) | **401 Unauthorized** for an anonymous caller | Not available; do not try to obtain credentials for it |

### 4.9 From a datacenter IP

Fetched through a hosted tool on a datacenter IP: `robots.txt` returned 200 and `api-locations.tnet.ge/v2/cities` returned 200, but a results page and `sitemap-listings-12-ka.xml` both returned **403 Forbidden**.

The same happens from our production server, and there the cause is visible: the 403 carries `cf-mitigated: challenge`, so it is a Cloudflare challenge page, not content and not a plain refusal. It applies to the homepage, the sitemap index, listing sitemaps, results pages and detail pages, with the bot and the browser User-Agent alike. Only `robots.txt` and the `api-locations.tnet.ge` host answered normally. Full results are in §7.1.

---

## 5. ss.ge: findings

### 5.1 Platform

| Item | Finding |
|---|---|
| Operator | შპს „საქმე.ჯი", per the site's privacy policy page |
| Stack | Next.js (pages router) on `home.ss.ge` behind Cloudflare. Data is in `__NEXT_DATA__` under `props.pageProps`. |
| Where the data sits | Results: `applicationList.realStateItemModel` (the misspelling is theirs), with `initialTotalApplicationCount` and `initialPage`. Detail: `applicationData`. |
| Location dictionary | Embedded in every page as `pageProps.locations` |
| Time zone | Results rows carry an explicit `+04:00`. Detail pages show the same wall-clock value with a `Z` suffix, which is wrong (§17). |
| Bot handling | None seen from this machine, and a datacenter fetch of a results page also got real content. |

### 5.2 robots.txt and terms

`home.ss.ge/robots.txt` disallows only `/ka/user`, `/en/user` and `/ru/user`, with no `Crawl-delay`. The posting-rules page was read in a browser: no clause on automated access or reuse. It does say the site takes no responsibility for agents copying an owner's listing.

The sitemap it points to (`ss.ge/sitemap.xml`) lists filter pages, not listings. Its "classifieds" sitemap addresses return the HTML homepage. **There is no usable inventory of listings.**

### 5.3 Addresses and filters

`https://home.ss.ge/ka/udzravi-qoneba/l/<kind>/<deal>?<filters>&order=1&page=N`

| Part | Values |
|---|---|
| Kind | `bina` (flat, code 5), `kerdzo-saxli` (house, code 4) |
| Deal | `iyideba` (sale, code 4), `qiravdeba` (long-term rent, code 1), `qiravdeba-dghiurad` (daily rent, code 3) |
| `order=1` | Newest first |
| Filters confirmed | `cityIdList=95` (Tbilisi), `subdistrictIds=<id>`, `rooms=<n>`, `areaFrom`, `areaTo` |
| Not found | A price filter. `priceFrom` and `priceTo` were ignored. |

### 5.4 Size, by the page's own counter

Flats for sale 95,320; flats for rent 162,682; houses for sale 12,030; houses for rent 17,793. Total for the version 1 scope: **287,825**. All real estate: about 363,000.

### 5.5 Results pages

| Property | Measured |
|---|---|
| Page size | 16 listings |
| Speed | Median 6.8 s over 16 successful pages on broad queries (3.5–13.1 s). Median 4.3 s over 11 pages of a narrow query. |
| **The counter overstates the list** | The list collapses listings the site considers similar. A query counted at 483 returned 168 rows over 11 pages and then ended. Houses for sale did not collapse: all 752 pages existed. |
| **Past the end, it returns page 1** | Asking for a page beyond the real end gives HTTP 200, `initialPage: 1` and the first page's rows. It took 8–20 s when this happened. |
| How deep it goes | Page 4,000 of all flats worked (64,000 rows deep). Flats for rent worked at page 900 and fell back at 3,200. Flats for sale worked at page 300 and fell back at 4,000. A query counted at 29,776 worked at page 600 and fell back at 1,000. |
| What "newest first" means | Ordered by the listing's latest order time. Promoted listings are re-ordered constantly, so the top of the list churns: 16 rows spanned under a minute at peak time. About 300 pages cover a day of flats for rent, about 250 a day of flats for sale. |

Because the counter cannot be trusted, **the number of readable ss.ge rows is unknown until a first full pass**. It is somewhere between roughly 60,000 and 288,000.

### 5.6 What a results row contains

42 fields. Used in version 1: `applicationId`, `type`, `dealType`, `title`, `totalArea`, `floorNumber` (a string, sometimes empty), `totalAmountOfFloor`, `numberOfBedrooms`, `price` (`priceGeo`, `priceUsd`, the per-m² `unitPriceGeo` and `unitPriceUsd`, and `currencyType`), `address` (ids and names for city, district, sub-district and street, plus the street number), `orderDate`, `createDate`, `vipStatus`, `similarityGroup`, `detailUrl`, and `description`.

- **There is no room count.** It has to be read from the title ("3 ოთახიანი"), which the site generates. It parsed on 168 of 168 sampled rows.
- **The description is complete** (identical to the detail page on two samples).
- **Who posted it is partial.** `userInfo` (a name, an image and `userType` 2 or 3) is present on about a third of rows and appears to mark agents and companies. Its exact meaning is not confirmed.
- **`similarityGroup`** holds the id of the listing that represents a group of look-alikes. Each visible row had a distinct value.
- **Personal data to drop:** `userId`, `userInfo.name`.

### 5.7 Detail pages

| Property | Measured |
|---|---|
| Address | `/ka/udzravi-qoneba/<id>` works. The slug is ignored, and there is no redirect. |
| Speed | Median 1.25 s over 13 pages. Much faster than results pages. |
| Adds over a results row | `rooms`, `status`, `isInactiveApplication`, `endDate`, condition (`state`), new or old build (`realEstateStatus`), street coordinates, `userEntityType`, view count |
| Expiry | `endDate` was exactly `orderDate` plus 30 days on 8 of 8 ordinary listings. Exceptions exist: two long-running house listings ended on `2040-01-01` and one 218 days out. |
| An expired listing | HTTP 200, `status: "Expired"`, `isInactiveApplication: true` |
| A listing that does not exist | HTTP 200 with no `applicationData`. Never a 404. |
| Personal data to drop | `applicationPhones`, `contactPerson`, `userId` |

### 5.8 The site's own JSON gateway (not to be used without their say-so)

The frontend loads further pages with `POST https://api-gateway.ss.ge/v1/RealEstate/LegendSearch`, body `{"order":1,"page":1,"pageSize":16}`, and counts with `v3/RealEstate/legend-search-count`. It authenticates with a token embedded in every page as `pageProps.credentialsToken`: a one-hour anonymous token for the site's own web client, with scopes that reach well beyond reading listings. Using it would mean acting as ss.ge's website. It was not used in this study. If ss.ge agrees to it, it would replace the 7-second pages with a fast call and probably a larger page size.

---

## 6. Across the two sites

### 6.1 Duplicates

One narrow slice was read in full from both sites: three-room flats for sale in Saburtalo, 79–81 m². Listings were matched as the same flat when area (±0.6 m²), floor, building height and price (±3%) agreed, and in the strict version when the street name also agreed.

| | myhome.ge | ss.ge | Both together |
|---|---|---|---|
| Rows read | 496 | 168 (the site counted 483) | 664 |
| Distinct flats, loose to strict match | 131–145 | 122–127 | 171–194 |
| Rows with at least one duplicate | 84–86% | 38–42% | 86–89% |
| Largest group | 57 listings | 6 listings | 66 listings |

- **About three rows in four are repeats.** 664 rows describe roughly 170–190 flats.
- **Cross-site overlap is about two thirds.** 68% of ss.ge rows matched a flat on myhome.ge, and 68% of myhome.ge rows matched one on ss.ge.
- **Agents drive it.** 88% of the myhome.ge rows were posted by agents or brokers, 6% by owners. One flat appeared 66 times: 62 times on myhome.ge from 62 different posters, and 4 times on ss.ge.
- **ss.ge already collapses.** That is why its list is shorter than its counter.

This is one slice in the busiest neighbourhood, and the match rule can merge genuinely different identical units in a new building. Treat the figures as an upper estimate. The conclusion holds either way: the table needs grouping to be usable, and an "owner listings only" filter is worth a lot.

### 6.2 Locations

- **Tbilisi matches well.** Both sites use the same five administrative districts with the same names, and sub-district names mostly agree.
- **Spelling differs in places.** For example ss.ge has "თხინვალა", "კონიაკის დას." and "სანზონა" where myhome.ge has "თხინვალი", "კონიაკის დასახლება" and "სან. ზონა".
- **A few places sit under different districts.** Ortachala is under Isani-Samgori on ss.ge and under Old Tbilisi on myhome.ge.
- **Outside Tbilisi the models differ.** myhome.ge has 126 cities, 67 of them with districts. ss.ge has 9 main cities and 63 municipalities containing 3,751 settlements.
- **myhome.ge's dictionary is the better base.** It has English names and coordinates for every level.

---

## 7. Gates before any code (Phase 11.0)

### 7.1 Can the production server reach both sites?

**Measured from the production server on 2026-10-12 at 13:30 UTC** (twelve requests, 2–3 s apart):

| Request | Bot User-Agent | Browser User-Agent |
|---|---|---|
| ss.ge results page | 200, real content, 5.2 s | 200, real content, 3.5 s |
| ss.ge detail page by id | 200, real content, 1.2 s | not tried |
| myhome.ge `robots.txt` | 200 | not tried |
| myhome.ge homepage, sitemap index, listing sitemap, detail page | **403**, challenge page of about 3 KB, under 0.1 s | not tried |
| myhome.ge results page | **403**, challenge page | **403**, challenge page |
| `api-locations.tnet.ge/v2/cities` | 200 | not tried |
| myhome.ge JSON data route (`/_next/data/…`) | **403**, challenge page | not tried |
| `api-statements.tnet.ge/v1/statements/count` and `/statement-parameters` | 200 | not tried |
| `api-statements.tnet.ge/v1/statements` (the listings) | 401 Unauthorized, the same answer as from anywhere | not tried |

- **The challenge covers `www.myhome.ge` only.** TNET's API hosts answer our server normally. The listings endpoint there needs authorization, so it is closed for a different reason.
- **ss.ge is clear.** The server can crawl it as planned.
- **myhome.ge is not.** Every response carried `cf-mitigated: challenge`: Cloudflare is showing our server an interactive challenge that a plain HTTP client cannot pass. The User-Agent makes no difference, so the trigger is the server's network or country, and which of the two is unknown.
- **What to send TNET:** our server's outbound IP address, our User-Agent string, and the reference of one refused request so they can find the rule: Cloudflare Ray ID `a49677936f91bb3a-CDG`, 2026-10-12 13:31 UTC, `GET /sitemap-listings-12-ka.xml`. The ask is a rule that skips the challenge for that IP.
- **Until then:** myhome.ge can be developed, tested and crawled from a Georgian connection, which is where all of Phases 11A–11C happen anyway. Only the hosted rollout of myhome.ge waits on TNET.

To re-test after TNET changes the rule, run this from the owner's machine, filling in the server login. It changes nothing on the server.

```powershell
ssh -i <key> <user>@<host> "for u in 'https://www.myhome.ge/sitemap-listings-12-ka.xml' 'https://www.myhome.ge/udzravi-qoneba/?page=3' 'https://home.ss.ge/ka/udzravi-qoneba/l/bina/iyideba?order=1'; do curl -s -o /dev/null -m 60 -A 'ScraplifyBot/0.1 (+https://github.com/Knight-Panther/scraplify)' -w '%{http_code} %{size_download}B %{time_total}s %{url_effective}\n' `$u; sleep 3; done"
```

| Result | Meaning | Next step |
|---|---|---|
| Three lines starting `200`, each hundreds of KB or more | The server is served normally | Proceed |
| `403` or `503`, or a body of a few KB | The server is still challenged | Go back to the site with the new Ray ID. Do not use proxies, a headless browser or a challenge solver to get around it. |

If TNET will not allow the server, the fallback is to run that one crawler from the owner's Windows machine, which already runs scheduled crawls locally (`scripts/run-crawl.ps1`), and to load the result into the host database. That is a worse arrangement and should be a last resort.

### 7.2 Agree the request budget and the channel with both sites

Send each site the numbers in §2.2 row 2. Ask ss.ge the question in row 3. Record the answers in `docs/RIGHTS.md`, which gets a row per site in the same format as the other three sources.

### 7.3 Owner approvals

- The concept amendment (§2.2 row 9).
- The new schema on the real database. Schema and role changes need the owner's approval first (`docs/STATUS.md`, "Owner decisions in force").
- The remaining rows of §2.2.

### 7.4 Capacity check on the server

Read on 2026-10-12: 2 CPUs; 3.8 GB of memory, 3.0 GB of it available; a 38 GB disk with 20 GB used and **18 GB free**. The estimate for real estate is 2–3 GB of disk (§14.4), so it fits with room to spare. Read it again before the hosted rollout, since the first pass is what will show the real size.

---

## 8. How it fits the codebase

### 8.1 What is reused and what is not

| Existing piece | Reuse? | Note |
|---|---|---|
| `src/net/http-fetcher.ts`, `rate-limiter.ts`, `user-agent.ts` | Yes, unchanged | Policy check on every request and redirect, SSRF guard, response-size cap, decompression. Set `requestTimeoutMs` to 60,000 for ss.ge: its pages take up to 20 s and the default is 15 s. |
| `sources` and `source_policies` tables, `src/policies/*.ts`, `syncSourcePolicy`, `withPolicyRevalidation` | Yes | The append-only policy record is the project's compliance core. Each site gets a policy file and a URL predicate that pins the exact address shapes, as `etenders-ge.ts` does. |
| `src/db/crawl-process-lock.ts` | Yes | Prevents two crawls of one source overlapping |
| `source_listings`, `source_listing_revisions`, `opportunities` and everything built on them (dedupe, taxonomy, matching bundle) | **No** | Built for 15,000 text listings with full revision history. Real estate has its own tables. |
| `resources` and `fetch_attempts` | **No** | One row per request would add tens of thousands of rows a night. Real-estate runs record counters per run and log requests to the journal. |
| `crawl_runs` | **No** | Its consumers treat every source as a job board. Real estate gets `realestate.crawl_runs`. |
| `deploy/run-pipeline.sh` and `xtelo-pipeline@.timer` | **No** | That pipeline runs dedupe, taxonomy, the matching bundle and retention after each crawl. Real estate gets its own script and timer. |

### 8.2 The two places the existing product must change

Registering the two sites in the shared `sources` table has side effects, because two functions enumerate every source:

1. **`getSourceHealth()` in `src/browse/queries.ts`.** It feeds the health page, the admin sources page, the landing page, the source filters on Browse and Listings, `npm run health:check` (which exits 1 on a critical alert) and the matching bundle's health gate. A real-estate source with no job-style runs would raise a critical alert there and could stop the vacancy matching bundle from building.
2. **`allSourceIds()` in `src/retention/run-retention.ts`.** Retention takes every source's crawl lock and skips when one is held. A real-estate crawl that runs for hours would make vacancy retention skip.

Add `REAL_ESTATE_SOURCES` to `src/source-traits.ts`, next to `TENDER_ONLY_SOURCES`, and exclude those slugs in both functions. Each exclusion gets a test that seeds a real-estate source and asserts it never appears. `CRAWL_SCHEDULES` in `src/crawl-schedule.ts` is opt-in, so the landing page's board rows are unaffected unless real estate is added there on purpose.

`src/db/real-data-guard.ts`, which stops tests from destroying real data, must learn about the new schema before any test writes to it.

### 8.3 Proposed layout

| Path | Contents |
|---|---|
| `src/db/schema/real-estate.ts` | The `realestate` schema (drizzle `pgSchema`). `drizzle-kit generate` emits `CREATE SCHEMA` itself, and `drizzle.config.ts` needs no change. |
| `src/realestate/` | Domain types, normalisers (locations, street key, prices, dates, group key), ingest (upsert, price change, run bookkeeping), queries, public queries, health |
| `src/policies/myhome-ge.ts`, `src/policies/ss-ge.ts` | Source and policy records and URL predicates |
| `src/adapters/myhome-ge/`, `src/adapters/ss-ge/` | Parsers, crawl logic, fixtures, `RECON_NOTES.md` |
| `src/cli/run-myhome-ge-crawl.ts`, `src/cli/run-ss-ge-crawl.ts` | Command-line entry points. These names already match the pattern `scripts/db-write-guard.sh` asks about, as will `npm run crawl:myhome-ge`. |
| `web/app/(local)/real-estate/page.tsx`, `web/lib/real-estate-params.ts` | The tab and its address-bar state |
| `deploy/run-realestate.sh`, `deploy/systemd/xtelo-realestate@.service` and `.timer` | Hosted schedule |
| `scripts/sql/phase-11-realestate-roles.sql` | Grants for the public, worker and admin roles |

Implementation happens on phase branches. The pre-commit hook blocks implementation files on `main`.

---

## 9. Data model

All tables are in the schema `realestate`.

### 9.1 `listings`: one row per source listing, current state only

| Column | Type | Note |
|---|---|---|
| `id` | uuid | Primary key |
| `source_id` | uuid | References `public.sources` |
| `source_listing_key` | text | The site's own id. Unique together with `source_id`. |
| `canonical_url` | text | The address the row links to |
| `deal_type` | enum `sale`, `rent` | |
| `property_type` | enum `flat`, `house`, `cottage` | |
| `rooms`, `bedrooms` | smallint, nullable | |
| `area_m2`, `yard_area_m2` | numeric, nullable | |
| `floor`, `total_floors` | smallint, nullable | |
| `price_gel`, `price_usd`, `price_per_m2_usd` | numeric, nullable | As converted by the source |
| `currency_posted` | enum `gel`, `usd`, `eur`, nullable | What the poster chose |
| `price_negotiable` | boolean | |
| `city_id`, `district_id`, `urban_id` | integer, nullable | References `locations`. Null until mapped. |
| `source_city_ref`, `source_district_ref`, `source_urban_ref` | text, nullable | The site's own ids and names, kept for tracing and re-mapping |
| `street_raw` | text, nullable | As the site gave it |
| `street_key` | text, nullable | Normalised form used for grouping (§12.2) |
| `build_status` | enum `old`, `new`, `under_construction`, nullable | myhome.ge results rows only |
| `poster_type` | enum `owner`, `agent`, `developer`, `unknown` | |
| `promoted` | boolean | Any paid tier on the source |
| `description` | text, nullable | Searched, never shown on the public site |
| `search_tsv` | tsvector | Built from street, location names and description (§13.4) |
| `source_updated_at` | timestamptz | myhome.ge `last_updated`, ss.ge `orderDate`, converted from Tbilisi time |
| `source_created_at` | timestamptz, nullable | ss.ge `createDate`; myhome.ge only on detail pages |
| `expected_end_at` | timestamptz, nullable | ss.ge only (§11.3) |
| `first_seen_at`, `last_seen_at` | timestamptz | Ours |
| `status` | enum `active`, `gone` | |
| `gone_at` | timestamptz, nullable | |
| `group_key`, `group_key_version` | text, smallint | §12.5 |
| `content_hash` | text | Hash of the fields whose change matters |
| `parser_version` | text | |

Indexes: unique `(source_id, source_listing_key)`; a composite on `(status, deal_type, property_type, city_id, urban_id)`; one each on `price_usd`, `area_m2` and `source_updated_at`; `group_key`; and a GIN index on `search_tsv`. No extension is needed: `tsvector` and GIN are built in.

### 9.2 Other tables

| Table | Purpose |
|---|---|
| `price_changes` | `listing_id`, `observed_at`, old and new price in both currencies. The only history kept. |
| `locations` | The shared dictionary: `id`, `kind` (city, district, urban), `parent_id`, `name_ka`, `name_en`, `slug`, `lat`, `lng` |
| `location_aliases` | `(source_id, kind, source_ref)` to `location_id`, with the raw name. A null `location_id` is an unmapped place waiting for review. |
| `sitemap_inventory` | myhome.ge only: `source_listing_key`, `lastmod`, deal and kind read from the slug, first and last night seen |
| `crawl_runs` | One row per run: source, mode (first pass, nightly, sweep), start, end, status, and counters for requests, pages, rows, new, changed, unchanged, gone, failed and fallback pages |
| `crawl_slices` | Progress of a first pass or sweep, so an interrupted run resumes instead of restarting |
| `listing_groups` | Added in Phase 11E (§12.5) |

### 9.3 Rules that keep the tables small and healthy

- **Never rewrite an unchanged row.** Compare `content_hash` first. A full sweep would otherwise rewrite 280,000 rows a night.
- **Delete gone rows after 14 days.** With roughly 7,000–11,000 new listings a day per site and a 30-day life, the table would otherwise grow by millions of rows a year. Price history goes with the row.
- **Diff the sitemap in SQL.** Load each night's sitemap into a temporary table and write only the differences to `sitemap_inventory`.
- **A public view, not the table, is what the public site reads** (§13.5).

---

## 10. Acquisition: myhome.ge

### 10.1 Policy

Host `www.myhome.ge` only. Allowed: `/sitemap_index.xml`, `/sitemap-listings-` (prefix), `/udzravi-qoneba/` (prefix), and `/_next/data/` (prefix) if the JSON routes are used. Disallowed, from robots.txt: `/makler`, `/product`, `/help/`, `/contact/`. A URL predicate pins the exact query parameters. Mode `http`, no authentication, 2 s between requests, one at a time, `mayRepublishFullContent: false`. The TNET API hosts are not in the policy.

### 10.2 The full sweep (also the first pass)

1. Read the sitemap index and the twelve listing files. Load them into `sitemap_inventory`.
2. Walk results pages for each slice, newest first, upserting every row.
3. A slice is a filter set whose results fit under the 9,600-row cap. Start from deal × kind × Tbilisi-or-not. **When a walk reaches page 400 and that page is full, the slice is too big:** split it by the next dimension (district, then sub-district, then room count, then price band) and walk the parts. Walking the same slice oldest-first as well doubles its reach to 19,200 rows before a split is needed.
4. Stop a slice at the first page with fewer than 24 rows or none.
5. Reconcile against the inventory: any residential id in the sitemap that no page returned gets fetched individually by its detail JSON route, up to a nightly limit.

Cost: about 11,800 pages for 282,000 listings, roughly half a day at 2 s spacing.

Rows shift while a slice is being walked, because renewed listings jump to the front. That produces repeats, which the upsert absorbs, and it can skip a just-renewed row, which the next run or step 5 picks up.

### 10.3 The nightly run

1. Sitemaps, as above. The diff gives three sets: new ids, ids whose last-modified day advanced, and ids that disappeared.
2. Walk each slice newest first and stop once a page holds only ordinary (non-promoted) rows older than the previous successful run, minus a six-hour overlap. Promoted tiers are always walked in full, because they sit ahead of the date order.
3. Reconcile as in step 5 above, limited to ids whose sitemap day is newer than what we hold.
4. Mark gone (§10.4).

Expected cost: 12 sitemap files, 600–1,000 results pages, and up to 500 detail fetches, so about 1–1.5 hours. This assumes every edit advances `last_updated`; the reconcile step is what proves or disproves that, and its count is an exit gate (§16).

Build the sweep first and run it as the nightly job until the incremental run is proven against it.

### 10.4 Removal

A listing is gone when its id is missing from **two consecutive** nightly sitemaps. If a night's sitemap total drops by more than 10% against the previous night, treat the read as faulty and mark nothing gone.

### 10.5 Build id

The JSON routes need the current `buildId`. Read it from any HTML page at the start of a run, and again whenever a JSON route returns 404. The HTML pages need no build id and are the fallback.

---

## 11. Acquisition: ss.ge

### 11.1 Policy

Host `home.ss.ge` only. Allowed: `/ka/udzravi-qoneba/l` (prefix) for results and `/ka/udzravi-qoneba/<digits>` for detail pages, pinned by a URL predicate so the hub's calculators and maps are not reachable. Disallowed: `/ka/user`, `/en/user`, `/ru/user`. `api-gateway.ss.ge` is not in the policy. Mode `http`, 3 s between requests, one at a time, 60 s timeout, `mayRepublishFullContent: false`.

### 11.2 Walking results

- Slice by kind × deal, then by city and room count. Narrow queries were faster (4.3 s against 6.8 s).
- **After every page, check `initialPage` against the page asked for.** If they differ, the walk has passed the end: discard the rows and stop. Ingesting them would file page 1's listings under the wrong position and hide the fact that the slice ended.
- Also stop at the first page with fewer than 16 rows.
- Never plan from `initialTotalApplicationCount`. It counts listings the list will not show.
- Read the location dictionary from `pageProps.locations` on any page; it costs nothing extra.
- Nightly: walk each slice newest first until rows are older than the previous run, with the same overlap as myhome.ge. Expect 600–700 pages, a little under two hours.
- First pass: every slice to its end. Somewhere between 4,000 and 18,000 pages, so half a day to two days.

### 11.3 Removal, without an inventory

Absence from the list proves nothing on ss.ge, because the list hides look-alikes. Version 1 uses a rule plus a small checking budget:

1. On every sighting, set `expected_end_at` to `orderDate` plus 30 days.
2. A row is shown only while the current time is before `expected_end_at` plus a two-day grace period.
3. Each night, fetch the detail page of up to 1,000 rows nearest their expected end, oldest first. Detail pages are fast (1.25 s). `Active` with a later `endDate` extends the row. `Expired`, inactive or missing marks it gone.
4. Long-running listings (an `endDate` far in the future) are re-checked monthly.

A row that is neither re-seen nor checked in time is hidden at its expected end. That errs towards hiding a live listing over showing a dead one. The first weeks of running will show how often each happens; tune the budget from that.

---

## 12. Normalisation rules

### 12.1 Locations

- Seed `locations` once from myhome.ge's `v2/cities` dictionary, trimmed to cities, districts and sub-districts with their Georgian and English names, slugs and coordinates. Commit the trimmed seed with a note of where and when it was read.
- Map each site's own ids through `location_aliases`. myhome.ge maps one to one. ss.ge maps by normalised name, with a short hand-written list for the spelling differences in §6.2.
- An unmapped place keeps the row visible under its city and appears in a "places to map" count on the health view. It never blocks ingestion.

### 12.2 Street key

Lowercase; drop text in brackets, house numbers and punctuation; drop street-type words (ქ., ქუჩა, გამზ., გამზირი, შეს., ჩიხი and similar) and single-letter initials; strip the Georgian case endings with the project's existing `stem` from `src/matching/lexical/text.ts`; keep the two longest remaining words. A rough version of this matched streets across the two sites well enough to find the 68% overlap in §6.1. A row with no street gets no key and is never grouped.

### 12.3 Prices, rooms, dates

- Store lari and dollar prices as each site gives them, and the currency the poster chose. Do not convert.
- myhome.ge rooms come from `room`. ss.ge rooms come from the title. Where the title has no room count, leave it null.
- Convert every source timestamp from Tbilisi time (UTC+4) to UTC. Ignore the `Z` on ss.ge detail dates.

### 12.4 Who posted it

myhome.ge: `physical` is an owner; `agent` and `broker` are agents; `developer` is a developer. ss.ge: `userInfo` present means an agent or company (to be confirmed against detail pages, which carry `userEntityType`); absent means unknown, not owner.

### 12.5 Grouping identical listings

`group_key` is a hash of: deal, kind, city, sub-district, street key, area rounded to the nearest m², floor, building height and rooms. Price is left out on purpose, because agents list the same flat at slightly different prices.

- A group's row shows the number of listings, the lowest and highest price, which sites carry it, and whether any listing is from an owner.
- Label it as what it is: "N listings with the same street, area, floor and rooms". Two identical units on one floor of a new building would share a key, so the tab must never claim they are certainly one flat.
- `listing_groups` is maintained at ingest: one row per key with those aggregates and the filter columns copied in, so the tab can filter and sort groups without aggregating 400,000 rows per request.
- `group_key_version` lets the key be recomputed when a normaliser improves.

---

## 13. The tab

### 13.1 Before writing any component

Invoke the repo's `professional-frontend` skill before writing components and again before calling the work done. Two of its rules are correctness rules here as well: **never render invented data**, and **never uppercase text that may be Georgian**. UI work is finished only after it has been rendered in a real browser and inspected.

### 13.2 Columns

Deal · Kind · Rooms · Area · Floor (as "3 / 9") · Price · Price per m² · Location (sub-district, district, city) · Street · Posted by · Updated · Source (link). In the grouped view, Price becomes a range and Source becomes the list of sites with a count.

### 13.3 Filters and sorting

- Deal, kind, city, district and sub-district, price range with a lari or dollar switch, area range, rooms, floor (with "not first" and "not last"), posted by (owner only), source, updated within 1, 3, 7 or 30 days, text.
- Sort by newest, price, price per m², or area.
- State lives in the address bar, following `web/lib/listing-params.ts`.

### 13.4 Search

Text search covers street, location names in both languages, and description. Build query terms with the same `tokenize` and `stem` the Phase 10A search uses, and match them as prefixes against `search_tsv` (the `simple` configuration, since Postgres has no Georgian stemmer). This keeps Georgian case endings and Latin-typed Georgian working the way they do on Browse. The existing search runs a regular expression over 15,000 rows at query time; that would not hold over several hundred thousand, which is why this one is indexed.

### 13.5 Surfaces, roles and speed

- The page is in the `(local)` route group and is surface-aware like `/listings`. On the public surface it reads only through a view, `public_real_estate_listings` (and later one for groups), which exposes active rows and leaves out `description`.
- Add `/real-estate` to `isPublicRoute` in `web/lib/surface-routing.ts`, and to both nav lists in `web/components/site-header-nav.tsx`.
- Grants go in a new SQL file run by the owner: the public role gets `USAGE` on the schema and `SELECT` on the views only; the worker role gets write access to the tables. Note the warning in `scripts/sql/phase-8b-public-role.sql`: recreating a view drops its grants.
- Return 50–100 rows at a time with keyset paging ("show more"). The existing `ROW_CHUNK` of 500 is too large here.
- Do not run an exact `count(*)` on every request. Count up to a ceiling and show "10,000+" above it.

---

## 14. Operations

### 14.1 Schedule

A separate timer per site, away from the 16:10 UTC job pipeline: myhome.ge at 01:50 UTC (just after its sitemap is regenerated; confirm that time over several days), ss.ge at 03:30 UTC. The nightly runs should finish in one to four hours. The systemd unit keeps the same hardening as `xtelo-pipeline@.service`.

### 14.2 Health

Real estate gets its own health section, not rows in the vacancy one: last run per site and its counters, the age of the newest listing, unmapped places, fallback pages on ss.ge, and reconcile fetches on myhome.ge. A parser that returns zero rows from a page that should have them is an incident, in the manner of `recordParserIncident`.

### 14.3 Backups

`deploy/backup-db.sh` dumps the whole database and keeps the off-host copies under 8 GB in total by deleting the oldest, so bigger dumps mean fewer days of backups. Exclude the row data of `realestate.listings`, `sitemap_inventory`, `crawl_slices` and `listing_groups` from the dump (`pg_dump --exclude-table-data`). Keep `price_changes`, `locations` and `location_aliases`: they cannot be re-crawled.

### 14.4 Capacity

A stored row averaged about 1.7 KB in the sample, of which the description is about 1 KB. For roughly 430,000 active rows plus 14 days of gone rows: about 1.1 GB of table, plus indexes and the search index, so **2–3 GB in total**. This is an estimate; the measured size after the first pass is an exit gate. CPU and memory load is light, because the crawl spends its time waiting on the network.

### 14.5 Local development and real data

Develop against fixtures and a throwaway or `scraplify_qa` database. A live smoke run is bounded by a page limit option. Writing the first pass into the real `scraplify` database is a real-data write: the guard hook will ask, and the owner runs it. Test every production-bound change on the local surface servers before the host.

---

## 15. Testing

- **Parsers:** fixture tests per page type per site, colocated `*.test.ts` under vitest, following the existing adapters. Fixtures are the embedded JSON of real pages, trimmed.
- **Fixtures must be scrubbed.** The repository is public, and these pages carry phone numbers and names. Remove `user_phone_number`, `owner_name`, `user_title`, `user_id`, `applicationPhones`, `contactPerson`, `userId` and `userInfo.name`, and blank phone-like digits in descriptions. Add a test that fails if any fixture contains a phone-shaped number.
- **Named traps get named tests:** the ss.ge page-1 fallback, the myhome.ge 400-page cap and slice split, the soft 404 on both sites, the stale build id, the `Z` suffix, room-type id 7 meaning 6 rooms, both spellings of the daily-rent slug.
- **Normalisers:** table-driven tests for the street key, location mapping and group key, using the real name pairs in §6.2.
- **Isolation:** the two tests in §8.2.
- **Surfaces:** extend `test:e2e:surfaces` so `/real-estate` exists on local and public and is refused on admin, and so the public role cannot read `description`.
- **Browser:** render the tab with real data, in Georgian and English, at desktop and phone widths.

---

## 16. Phases and exit gates

Phase numbers continue from `docs/STATUS.md` (10B is the latest). One branch per phase. STATUS is updated in the same commit as any change to a phase's state.

### Phase 11.0: gates (no code)

- [x] The server reaches ss.ge (measured 2026-10-12, §7.1)
- [ ] TNET allows the server on myhome.ge and the re-test passes, or the owner has chosen the fallback. This blocks only the hosted rollout of myhome.ge (Phase 11F), not local work.
- [ ] Request budget agreed with both sites; ss.ge has answered the channel question
- [ ] `docs/RIGHTS.md` has a row for each site
- [ ] Concept §31 written and approved
- [ ] The rows of §2.2 answered
- [ ] The schema change approved

### Phase 11A: foundation

- [ ] `realestate` schema and migration, reviewed with the `migration-safety-reviewer` agent before it is applied
- [ ] Source and policy records for both sites, synced
- [ ] `REAL_ESTATE_SOURCES` and the two exclusions, with tests; `health:check` and the matching bundle build behave as before
- [ ] `real-data-guard.ts` covers the new schema
- [ ] Location dictionary seeded; myhome.ge ids mapped

### Phase 11B: myhome.ge

- [ ] Sitemap inventory, slice walker with split-on-cap, reconcile step, removal rule
- [ ] First pass complete on a local database: residential rows within 2% of the sitemap's residential count
- [ ] Nightly run proven against a full sweep: after the nightly run, fewer than 1% of sitemap-changed ids need a reconcile fetch
- [ ] Table and index size measured and recorded
- [ ] No phone number or name in any table or fixture
- [ ] `RECON_NOTES.md` written with fresh measurements

### Phase 11C: the tab, one row per listing

- [ ] Queries, public view and grants
- [ ] The page with every filter, sort and search in §13
- [ ] Each filtered page answers in under a second on the local corpus
- [ ] Browser check passed in both languages and at phone width
- [ ] On local only; not yet in the public nav

### Phase 11D: ss.ge

- [ ] Walker with the fallback check; expiry rule and checking budget
- [ ] First pass complete; the real number of readable rows recorded
- [ ] ss.ge locations mapped: at least 95% of Tbilisi rows carry a sub-district
- [ ] A week of nightly runs with the hidden-while-live and shown-while-dead rates measured from the checks

### Phase 11E: grouping

- [ ] Street key, group key and `listing_groups`
- [ ] On a fresh read of the §6.1 slice, 50 groups checked by hand: in at least 45, every member is plausibly the same flat
- [ ] Grouped view is the default, with the switch to every listing

### Phase 11F: hosted rollout

- [ ] myhome.ge re-tested from the server and served normally. If TNET has not allowed the server by then, the owner chooses between launching with ss.ge only and the fallback in §7.1.
- [ ] Migration and grants applied on the host by the owner
- [ ] Timers installed; backup exclusion in place and a dump size checked
- [ ] First pass run on the host; disk headroom confirmed
- [ ] `/real-estate` public, in the nav, and checked live

---

## 17. Traps

1. **ss.ge returns page 1 past the end**, with HTTP 200. Always compare `initialPage` with the page requested.
2. **ss.ge's counter is not the row count.** A query counted at 483 held 168 rows.
3. **myhome.ge stops at page 400** and returns empty pages after it, with HTTP 200.
4. **Neither site returns 404 for a missing listing.** Both answer 200 with a page that has no listing record.
5. **myhome.ge puts promoted listings ahead of the date order**, in three tiers. A walk that stops at the first old row will stop inside a promoted tier.
6. **myhome.ge's JSON routes break on every site deploy**, with a 404, until the build id is re-read.
7. **ss.ge detail dates carry a false `Z`.** The value is Tbilisi time.
8. **myhome.ge timestamps have no zone at all.** They are Tbilisi time.
9. **myhome.ge room-type ids skip 6.** Id 7 means six rooms.
10. **The daily-rent slug is spelled two ways:** `qiravdeba-dghiurad` in addresses, `qiravdeba-dgiurad` in the code list.
11. **ss.ge results rows have no room count.** It is in the title.
12. **ss.ge `floorNumber` is a string and is sometimes empty.**
13. **ss.ge embeds a working access token in every page.** Never log it, never store it in a fixture, never send it anywhere.
14. **Both sites' payloads carry phone numbers and names.** Drop them in the parser, before anything is stored or logged.
15. **Descriptions contain phone numbers typed by posters.** They are searched but not displayed publicly; remember this before any later feature shows or exports them.
16. **A thirteenth myhome.ge sitemap file exists but is stale.** Follow the index.
17. **One broad myhome.ge query took 37 s.** Narrow slices are faster on both sites.
18. **Listing rows are long-lived only by renewal.** Without deleting gone rows, the table grows by millions of rows a year.
19. **A real-estate source in the shared `sources` table can stop the vacancy matching bundle** unless §8.2 is done first.

---

## 18. Not verified

- Which rule makes myhome.ge challenge our server: its hosting network, its country, or something else. Only TNET can say.
- Any tolerance for more than one request at a time, or for sustained running over hours. The longest unbroken run against one site in this study was 22 requests.
- How many ss.ge rows are actually readable.
- Whether ss.ge has other listing end states besides `Active` and `Expired` (sold, deleted, blocked).
- The exact meaning of ss.ge's `userInfo.userType` 2 and 3, and of `currencyType`.
- Whether myhome.ge's `owner_type=physical` filter matches `user_type.type` on rows.
- Whether every edit on myhome.ge advances `last_updated`.
- The time myhome.ge regenerates its sitemap, beyond one observation.
- Both sites outside Tbilisi afternoon hours.
- A TNET site-rules document, if one exists apart from the privacy page.
- Duplicate rates beyond one slice.
