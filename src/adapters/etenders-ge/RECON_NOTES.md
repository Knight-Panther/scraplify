# etenders.ge reconnaissance notes (Phase 9A)

The full study, with every finding and the strategy built on it, is [`docs/addEtender.md`](../../../docs/addEtender.md) (live read-only study, 2026-10-05, about 100 requests). This file is the adapter's short working record: what the parsers and the crawl rely on, and how the fixtures were made. Treat each entry as "confirmed on the date given", the way the source policy's comments are dated.

No sign-in, form submission, bid, favourite or any other state-changing action was ever performed. Every request was a plain GET at 2–3 s spacing, apart from one Playwright session that watched the site's own search form (2026-10-05).

## Acquisition decision

**`http` only.** Every page is server-rendered ASP.NET WebForms on IIS 8.5. There is no API of any kind: `/api`, Swagger, `.asmx`, RSS and OData all return 404, and there is no robots.txt or sitemap. The one JSON endpoint is the CPV dictionary (`GET /Pages/Tender/getTenderCPVSelection.aspx?TenderId=-1&lng=1|2`, 272 CPV groups plus `99999999`).

| Purpose | Request |
|---|---|
| Live set (statuses 1–3) | `/search/?ss=-1&ts=_1_2_3_&kw=&tn=&br=&cpv=&st=&end=&stamm=&endamm=[&pg=N]` |
| Recent announcements, any status | the same with `ts=__&st=DD-MM-YYYY` |
| Tender detail | `/view/<id>/x` (the slug is ignored by the site) |

The archive (`/tenders/?pg=N`, 393 pages of 30, 11,762 tenders on 2026-10-05) is never walked. The live set holds all open tenders (38–40 when measured), and the date window catches tenders that opened and closed between runs.

## What the parsers rely on

- **Search cards:** one `table.RightNAndStarAndDetails` per card, repeated for desktop and mobile with duplicate ids, so cards are deduplicated by tender id. Rows:
  1. buyer
  2. title
  3. `#<id>`, plus the lock icon (invite-only) and the `changed2.png` amendment stamp, `ცვლილება: DD/MM/YYYY HH:MM:SS`
  4. the two dates and `span.stst.status_N`

  The detail link (`a.detail-btn`) sits in the enclosing table, and locked cards have none. Search pages hold 20 cards without a session; the page size lives in the server session, so the crawl sends no cookies.
- **Ordering:** every list is live-first (announced, bids open, bidding), then finished by end date. A tender's id is not its chronology.
- **Detail pages** have almost no field ids, so values are read by Georgian label inside the fields box. The box is found through the method's help link, `TenderTypeHelp_Type__N`, which also gives the method code:
  - 1 notice
  - 2 reverse auction
  - 3 one-envelope
  - 4 two-envelope
  - 5 prequalification
- **Other stable anchors on the detail page:**
  - the buyer link `/companytenders/<Georgian registry code>/<name>` (with malformed attribute quoting)
  - the `<!-- ტენდერის სათაური -->` comment before the title (the `<title>` tag is rewritten for SEO and is not used)
  - `/cpvtenders/<code>/` links
  - `div.additional-info-text`, cut at its "დოკუმენტაცია" heading
  - `#FilesTable` rows `tr.IsObsolete0|1`
  - `#TenderCommentsTable`
- **Statuses** are text only on the detail page:
  - 1 announced
  - 2 bids open
  - 3 live bidding
  - 4 terminated
  - 5 failed
  - 99 completed

  Unknown status text quarantines the page.
- **Times** are Tbilisi local, UTC+4 all year. The countdown script seeds the server clock on every detail page.
- **Volatile parts**, kept out of the meaningful-content hash: the unique-views counter, the countdown and server clock, partner ads, and the Q&A thread (kept as a count and last date).

## Traps the crawl handles

| Answer | Meaning | Handling |
|---|---|---|
| 302 to `?pg=1` | page past the end | redirects are never followed (`redirect: 'manual'`); the walk stops at the last page the paging names |
| 302 to `/Pages/Tender/TenderSearch/TenderNotFound.aspx` | tender removed | `missing_suspected`, then `closed` on a second run |
| 302 to `/viewsale/<id>/x` | an asset sale | skipped |
| 301 from bare `/view/<id>`, raw-UTF-8 `Location` | — | the crawl always requests `/view/<id>/x` |
| 500 ASP.NET error page | malformed `ss` | the URL allow-list admits only valid shapes |
| 200, zero results | malformed `ts` | the same, and an empty live set marks the run partial |

## Fixtures (captured 2026-10-07)

Plain cookieless GETs at 3 s spacing, with the project's own User-Agent. **Personal contact details were redacted before commit**: names, mobile numbers and staff emails in 69607, 69611, 69619 and 69679 were replaced with `სახელი გვარი` / `Name Surname`, `500 …` numbers and `contact-?@example.invalid`. GIZ's organizational submission mailbox (`ge_quotation@giz.de`) is kept, because it is the tender's real application method.

| File | Covers |
|---|---|
| `search-live-p1.html`, `search-live-p2-last-restricted.html` | live set, 20 + 18 cards, paging, locked cards on page 2, amendment stamps |
| `search-window-p1.html` | 5-page date window; page 1 is all live (ordering) |
| `search-empty.html` | a search with no results: no cards, empty paging |
| `error-500-method-format.html` | the yellow ASP.NET error page for `ss=_99` |
| `detail-69679-reverse-auction-open-usd.html` | reverse auction, USD, minimum step, auction on total price, Q&A |
| `detail-69611-reverse-auction-completed.html` | completed auction, GEL step, bidder count |
| `detail-69619-one-envelope-completed-qa.html` | one-envelope, completed, two Q&A entries |
| `detail-69397-two-envelope-completed.html` | two-envelope, five CPV codes, VAT without currency, empty description |
| `detail-69617-prequalification-usd-excl-vat.html` | prequalification, USD excluding VAT, stated maximum value, free-text deadline that contradicts the structured one |
| `detail-69674-notice-off-platform-english.html` | notice (method 1), off-platform submission by email, midnight deadline, English text |
| `detail-69534-terminated-notice.html` | terminated (status 4) |
| `detail-69607-failed-no-bidders.html` | failed (status 5), 0 bidders |
| `detail-41358-legacy-2015.html` | a 2015 tender: same template |
