# Adding tenders from etenders.ge: study and strategy

**Status:** decided 2026-10-07 (go; see §17). Being built as Phase 9 (`docs/STATUS.md`): 9A acquisition, 9B job-board reclassification and dedupe, 9C the public Tenders tab.
**Date of measurements:** 2026-10-05, about 21:30–22:40 Tbilisi time.
**How it was measured:** about 100 read-only requests to `etenders.ge`. Most were cookieless `curl` with 2–3 s spacing; the rest came from one Playwright session that watched the site's own search form. Every number below is a dated observation, not a guarantee. Re-measure before building and keep the fresh results in `src/adapters/etenders-ge/RECON_NOTES.md`, as was done for the other two sources.

---

## 1. Summary

- **What it is:** etenders.ge is a **private B2B tender board** run by a company, separate from the state procurement system. Companies post purchase tenders and asset sales there, and suppliers bid. Typical buyers are banks, utilities, clinics, retailers and international agencies (TBC, Credo, Telasi, Aversi, Nikora, UNDP, GIZ, UNICEF).
- **Size:** 11,762 tenders have been listed since May 2015, at about 1,500–1,600 a year. 145 were announced in the last 30 days (about 5 a day), and **40 are live right now**.
- **API:** there is none, public or paid, documented or not. The only machine-readable endpoint is a free CPV code list (CPV is the standard procurement category code). Getting the data means scraping server-rendered HTML.
- **Verdict:** feasible and cheap. A crawler aimed at the "live tenders" filter plus a "recently announced" window needs about 40–75 requests a day. The work lies in a dozen site traps (§12) and a label-based parser (§8).
- **Bonus:** about 20 tender posts a month already reach our **job catalogue** from jobs.ge and hr.ge, misclassified as vacancies. About 40% of them are the same tenders as on etenders.ge (§11).

---

## 2. The platform and its business model

| Item | Finding |
|---|---|
| Owner | LLC "Electronic Procurement System" (შპს შესყიდვების ელექტრონული სისტემა), registry ID 405075047. Its terms list two domains, `etenders.ge` and `etender.ge`. |
| History (About page) | Procurement platform launched in 2015 ("the first commercial e-procurement platform"), blog from 2016, sales module from 2017, analytics module from 2022. Developer named in the page footer: GamaSoft. |
| Positioning | "Etenders.ge – B2B შესყიდვების და გაყიდვების ელექტრონული პლატფორმა" (B2B procurement and sales platform). It is unrelated to the state procurement agency, though the homepage links to procurement.gov.ge. |
| Pricing (terms §4.3) | Browsing is free and needs no account. Registration is free. Posting a tender costs **50 GEL**. Each bid costs **50 GEL**, but bids in restricted (invite-only) procedures are free. Bidders can instead buy a subscription: **180 GEL for 3 months, 300 GEL for 6 months, 500 GEL for 12 months**. The owner may change fees without notice (§6.2). |
| Other services | Email alerts for registered users by area of interest; consulting and training (Services page). |
| API or data product | None offered or mentioned anywhere (§3). |

### Terms of use (the "Registration_Contract" page, linked from `/Register` as "შეთანხმების წესებს")

- §2.1: the owner is **not the author** of posted content and is not a party to deals made through it.
- §2.6: posted information is **open to any other user**, with three exceptions. Bids are visible only to the announcer. §2.7 restricted procedures show their details only to invited users. §2.8 anonymous tenders hide the announcer's identity, revealing it after completion only to bidders.
- §5.8: users can ask for their profile's personal data to be deleted.
- There is **no clause on scraping, automated access or reuse of listing content**, and the site has no `robots.txt`.
- URL: `https://etenders.ge/Pages/GeneralHelpViewer/GeneralHelpDisplay.aspx?key=Registration_Contract`

**Permission:** nothing forbids crawling public pages, but per concept §5.3 we should ask etenders.ge for a written OK before sustained production use. Our source-permission grant covers jobs.ge and hr.ge only. The ask is a natural fit, because we would send them bidders, who pay per bid. A feed or export could only come from such an arrangement (§3).

---

## 3. API check: result

The owner asked whether an API exists, whether it works, and whether it costs money. The answer: **no API exists, and none is sold**.

| Probe | Result |
|---|---|
| `/api`, `/api/`, `/api/help`, `/api/tenders`, `/help` | 404 |
| `/swagger`, `/swagger/ui/index`, `/swagger/docs/v1` | 404 |
| `/WebService.asmx`, `/Service.asmx`, `/Services.asmx`, `/Pages/WebService.asmx` | 404 (ASP.NET "resource cannot be found") |
| `/rss`, `/feed`, `/Rss.aspx`, `/odata`, `/.well-known/security.txt` | 404 |
| `robots.txt`, `sitemap.xml` | 404 |
| Web search for "etenders.ge API" | Nothing relevant. The hits were about other countries' eTenders systems. |

The only machine endpoints are private helpers that the site's own pages call:

| Endpoint | What it does | Usable? |
|---|---|---|
| `GET /Pages/Tender/getTenderCPVSelection.aspx?TenderId=-1&lng=1` | CPV dictionary as JSON (served as `text/html`) | **Yes:** anonymous GET works. A body-less POST returns 411. |
| `…?TenderId=<id>&lng=1` | Same list, with `"Selected": true` on that tender's codes (69679 → `30200000`) | Possible cross-check; 153 KB per call, so not routine |
| `/Pages/Tender/FileHandler/TenderDocsFileHandler.aspx?file=<GUID>[&mode=ALLTENDERFILES]` | Tender documents, or a ZIP of all of them | Downloads anonymously; link-only for us (§13) |
| `/Pages/Profile/LogoHandler.aspx?tenderid=<id>` | Buyer logo for each tender | Don't use |
| `/Pages/HeartBeat.aspx` | Session keep-alive (the page calls it every 240 s) | No |
| `/Pages/GeneralHelpViewer/GeneralHelpDisplay.aspx?key=<key>` | Help popups and the terms page | Terms only |
| `/Pages/Tender/TenderSearch/ToggleFav.aspx?tid=&crntval=` | Favourite toggle. Changes state; replies `ERRONOTLOGGEDIN` when anonymous. | **Never** |
| `/Pages/Tender/TenderDetails/DeleteComment.aspx?del=<id>` | Comment delete. **Changes state through a GET.** | **Never** |

The CPV dictionary has 273 entries: 272 CPV **groups** (codes ending in `00000`, e.g. `22100000`) plus `99999999` "other". `lng=1` gives Georgian labels with keyword hints in `<span class="cvp-keywords">` (153 KB). `lng=2` gives English labels with empty hint spans (45 KB).

---

## 4. Technology and HTTP behaviour

| Item | Finding |
|---|---|
| Server | `Microsoft-IIS/8.5`, `X-AspNet-Version: 4.0.30319`. The error pages show ASP.NET 4.7.3282.0. This is a Windows Server 2012 R2-era stack. |
| Framework | ASP.NET WebForms with Ext.NET on ExtJS 4.2.1.883, plus jQuery 1.11/1.12, jQuery UI, Bootstrap, Owl Carousel and FancyBox |
| Rendering | Fully server-rendered. Listing cards and detail fields are in the HTML, and no JavaScript is needed to read them. |
| Canonical host | `www.etenders.ge` returns 301 to `https://etenders.ge:443/` |
| Caching | `Cache-Control: private`. **No `ETag` or `Last-Modified`**, so conditional requests are impossible. |
| Compression | **None**, even when `Accept-Encoding: gzip` is sent |
| Sessions | Every cookieless response sets `ASP.NET_SessionId`, so each request creates a server-side session. Some settings live in that session (§6). |
| Rate limiting / WAF | No rate-limit headers, no challenge, no CAPTCHA, no blocks in about 100 requests |
| Latency | Usually 0.2–1.5 s. Outliers: `/instructions` 7.9 s, `/Pages/Static/Services.aspx` **34.1 s**, and one **90 s connect timeout** on the instructions PDF. The site was healthy again 20 s later. |
| Page weight | Homepage 870 KB. `/tenders` 240–330 KB (30 cards). Search pages 170–250 KB (20 cards). Detail pages 86–100 KB. |
| Error handling | Custom errors are off. A malformed parameter produces the ASP.NET yellow error page, including source lines (e.g. `int SheskidvisSashualeba = int.Parse(ss);`). |
| Tracking | Google Analytics (UA and GA4) and the Facebook Pixel and SDK. This matters only if we ever embed their pages or images. |
| Time zone | The countdown script seeds the server clock (`_crntDateTimeFromServer = "Oct 05, 2026 22:19:00"` at 18:19 UTC). **All displayed times are Tbilisi local, UTC+4**, with no daylight saving. |

---

## 5. URL map

| URL | Purpose | Behaviour |
|---|---|---|
| `/` | Homepage | Tabs with the latest ~30 tenders and ~30 sales, a partner carousel of 26 buyers with `/companytenders` links, blog links |
| `/tenders`, `/tenders/?pg=N` | All tenders | **30 cards a page** without cookies. 393 pages, and the last has 2 cards, so 11,762 tenders. **`?pg=394` returns 302 to `/tenders/?pg=1`.** |
| `/sales`, `/sales/?pg=N` | Asset sales | 18 pages at 30 a page, about 510–540 sales |
| `/search/?ss=&ts=&kw=&tn=&br=&cpv=&st=&end=&stamm=&endamm=[&pg=N]` | Filtered list | **20 cards a page** without cookies. Paging links repeat every parameter plus `&pg=N`. With all filters empty it behaves like `/tenders` (30 cards, paging links to `/tenders/?pg=N`). |
| `/view/<id>/<anything>` | Tender detail | The slug is ignored, so `/view/69689/x` returns 200 |
| `/view/<id>` | (bare) | **301 to `/view/<id>/<buyer>-<title>`, with raw UTF-8 Georgian in the `Location` header** |
| `/view/<missing-id>/x` | Not found | **302 to `/Pages/Tender/TenderSearch/TenderNotFound.aspx`**, never a 404 |
| `/view/<sale-id>/x` | Wrong kind | **302 to `/viewsale/<id>/x`** |
| `/viewsale/<id>/<slug>` | Sale detail | Same template as a tender, with sale-specific labels |
| `/companytenders/<registryId>/<name>` | One buyer's tenders | 20 cards a page. The ID is the buyer's Georgian registry code (§9). |
| any page `?lng=lang__en` / `lang__ru` | UI language | Applies to that request only. Labels and CPV names change; titles and descriptions stay as the buyer wrote them. |
| `/login`, `/Register`, `/search/?favs=1`, `?annbyme=1`, `?myparticipations=1` | Account pages | Out of scope |
| `/instructions`, `/salesinstructions`, `/Page/AboutUs`, `/Pages/Static/Services.aspx`, `/blog` | Static pages | Not needed for ingestion |

### How the search form really works

The form fields are Ext.NET components. Clicking search sends a DirectEvent POST to the current page (`__EVENTTARGET=ctl00$ContentPlaceHolder1$rsmgg1`, `__EVENTARGUMENT=ContentPlaceHolder1_SearchBtn|event|Click`). The server answers with a redirect instruction to a **plain GET `/search/?…` URL**, so a crawler can skip the POST and build the GET URL directly.

---

## 6. Search parameters

| Param | Meaning | Accepted shape | Wrong shape |
|---|---|---|---|
| `ss` | **Procurement method** (parsed as an integer) | `-1` all, `1`–`5` (§7) | `ss=_99` returns **HTTP 500** |
| `ts` | **Status set** | `__` for all, or underscore-wrapped codes such as `_2_` or `_1_2_3_` | `ts=2` returns **200 with zero results (silent)** |
| `kw` | Keyword | text | — |
| `tn` | Tender number | digits | — |
| `br` | Buyer name, substring match | text (`br=კრედო` found 97 Credo Bank tenders in 2025) | — |
| `cpv` | CPV code | 8 digits | — |
| `st`, `end` | Date range | `DD-MM-YYYY` (the form's date pickers produce this) | not tested |
| `stamm`, `endamm` | Amount range | number | not tested |
| `pg` | Page | positive integer | past the end on `/tenders`: 302 to page 1 |
| `lng` | UI language | `lang__en`, `lang__ru` | — |

**Page size is server-session state.** The "show on page" box (10/20/40/80/100) is saved in the ASP.NET session. After it was set to 100 in the browser, the same session saw `/tenders` at 118 pages and `/sales` at 6 pages. A crawler must not touch that setting and must check the card count on every page.

---

## 7. Vocabularies

### Statuses

The card class `status_N` gives the code; the detail page shows the text.

| Code | Georgian (card/detail) | English label | Meaning |
|---|---|---|---|
| 1 | გამოცხადებულია | Announced | Published; bids not open yet |
| 2 | წინადადების მიღება დაწყებულია | Submission of proposals commenced | Bid window open |
| 3 | მიმდინარეობს ვაჭრობა | Bidding commenced | Live auction (none was running during the study) |
| 4 | შეწყვეტილი, detail says "ტენდერი შეწყდა" | Cancelled | Terminated; no reason shown |
| 5 | ტენდერი არ შედგა | No Pretendents | Failed, e.g. 0 bidders (69607) |
| 99 | დასრულებული, detail says "ტენდერი დასრულდა" | Finished | Completed |

### Procurement methods (`ss`)

| Code | Georgian | Meaning | Detail-page specifics |
|---|---|---|---|
| 1 | განცხადება | Notice | Number label "განცხადების ნომერი". Submission form "მითითებული ინფორმაციის შესაბამისად", meaning off-platform per the instructions. Price basis often "არ არის მითითებული". Deadlines often at 00:00. Used by GIZ, UNDP and UNICEF. |
| 2 | რევერსული აუქციონი | Reverse auction | End label "წინადადებების მიღების დასრულება/ვაჭრობის დაწყება". Has a minimum decrement ("ფასის კლების მინიმალური ბიჯი: 1 000 დოლარი") and the line "ვაჭრობა იმართება ჯამურ ღირებულებაზე" (auction on total price). |
| 3 | 1 კონვერტის პრინციპი (detail: "ტენდერი ერთი კონვერტის პრინციპით") | One-envelope | Base template |
| 4 | 2 კონვერტის პრინციპი | Two-envelope | Price basis can omit currency ("დ.ღ.გ-ს ჩათვლით") |
| 5 | პრეკვალიფიკაცია | Prequalification | Seen in USD, excluding VAT, with a maximum value (69617) |
| sales | რეალიზაციის საშუალება: რეალიზაციის აუქციონი | Sale auction | "საწყისი ღირებულება" (starting price), "ფასის მატების მინიმალური ბიჯი" (minimum increment), "მომსახურების ადგილი" |

---

## 8. Anatomy of a listing card

The selector is `table.RightNAndStarAndDetails`. Each card's markup appears more than once (desktop and mobile copies) with **duplicate `id` attributes**, so deduplicate by tender ID. The homepage had 90 tables for 60 cards.

| Field | Where | Notes |
|---|---|---|
| ID | `#` followed by digits; also `FavImage_<id>` | One ID sequence shared by tenders and sales |
| Buyer | Row 1 text | Raw name, with many spelling variants for the same buyer (§10). "ანონიმური ტენდერი" marks an anonymous tender. |
| Title | Row 2 text | GE, EN or RU, often with the buyer's own reference code (`№597`, `0007464`, `DR0018/09/26`) |
| Announce date | "გამოცხადების თარიღი: DD/MM/YYYY" | Date only |
| End date | "დასრულების თარიღი: DD/MM/YYYY" | Date only; the detail page has the time |
| Status | `span.stst.status_N` plus text "სტატუსი: …" | **Use the class code**, not the text |
| Restricted | `img[src*="lock.jpg"]` **and no `a.detail-btn`** | An empty, hidden restricted-alert anchor sits on **every** card, so never key on the alert text |
| Amended | `img[src*="changed2.png"]` inside `JavaScript:alert('ცვლილება: DD/MM/YYYY HH:MM:SS')` | **Exact last-change timestamp; a free refetch trigger** |
| Detail link | `a.detail-btn` → `/view/<id>/<buyer>-<title>` or `/viewsale/…` | Raw Georgian in the `href`. The path also gives the kind (tender or sale). |
| Logo | `/Pages/Profile/LogoHandler.aspx?tenderid=<id>` | Don't fetch |

### List ordering

Live tenders (status 1, 2, 3) come first, newest announcement first. Finished ones (99, 4, 5) follow, ordered by end date, newest first. Within a day the order is not by ID: 59 of 144 neighbouring pairs in the 30-day sample run against ID order. **ID is not a reliable time key**, so don't use an ID high-water mark for discovery. Because tenders jump from the live block to the finished block when they close, page boundaries move between requests, which is one more reason to avoid full walks.

---

## 9. Anatomy of a detail page

Fields live in inline-styled `<span>`/`<div>` markup with **almost no IDs or classes**. The only useful IDs are `ContentPlaceHolder1_EtenderOrNot`, `FilesTable`, `ContentPlaceHolder1_AllFilesDownloadHandle`, `tenderCommentsWrapper` and `TenderCommentsTable`. So parsing has to anchor on Georgian labels. Some attributes are quoted wrongly (e.g. `style='…;' color:blue; text-decoration:underline;'`), so use a proper HTML5 parser (cheerio/parse5), never regex.

| Field | Georgian label (variants) | Example values | Notes |
|---|---|---|---|
| Number | "ტენდერის ნომერი:" / "განცხადების ნომერი:" | 69689 | The label varies (notices, sales, some terminated tenders) |
| Unique views | "უნიკალური ნახვების რაოდენობა:" | 69, 465, 4520 | **Changes constantly; exclude from change hashes** |
| Bidder count | "პრეტენდენტების რაოდენობა:" | 0, 1, 2 | **Appears only after close.** Winners and prices are never published, not even for finished reverse auctions (69611). |
| Status | "სტატუსი : …" | see §7 | Plus a closing line ("ტენდერი დასრულდა" / "შეწყდა" / "არ შედგა") |
| Countdown | "…დაწყებამდე დარჩა:" / "…დასრულებამდე დარჩა:" / "განცხადების დასრულებამდე დარჩა:" | — | Seeded by inline JS (`_dateToCountDownToFromSrv`, `_crntDateTimeFromServer`). **Changes on every request.** |
| Submission form | "წინადადებების წარდგენის ფორმა:" | "ელექტრონულად Etenders.ge-ზე ატვირთვის საშუალებით" (upload on the platform) / "მითითებული ინფორმაციის შესაბამისად" (off-platform) | Has a stable ID: `ContentPlaceHolder1_EtenderOrNot` |
| Method / kind | "ტენდერის ტიპი" / "რეალიზაციის საშუალება" | §7 | — |
| Announced | "გამოცხადების თარიღი:" | 05/10/2026 17:47 | Tbilisi time |
| Bid start | "წინადადებების მიღების დაწყება:" | 06/10/2026 15:00 | Can be weeks after the announcement (69617) |
| Bid end | "წინადადებების მიღების დასრულება :" / "…/ვაჭრობის დაწყება :" | 09/10/2026 18:00 | Note the space before the colon |
| Price basis | "პრეტენდენტებმა წინადადება უნდა წარმოადგინონ" | "დ.ღ.გ-ს ჩათვლით ლარში", "დ.ღ.გ-ს ჩათვლით დოლარში", "დ.ღ.გ.-ს გარეშე დოლარში", "დ.ღ.გ-ს ჩათვლით", "არ არის მითითებული" | VAT included/excluded × GEL/USD; EUR not observed |
| Max / start value | "მაქსიმალური ღირებულება" / "საწყისი ღირებულება" | "არ არის მითითებული", "12 200 ლარი დ.ღ.გ-ს ჩათვლით", "120 000 დოლარი დ.ღ.გ.-ს გარეშე", "140 000 ლარი დ.ღ.გ-ს ჩათვლით" | Spaces as thousands separators; usually "not specified" |
| Min step | "ფასის კლების მინიმალური ბიჯი" / "ფასის მატების მინიმალური ბიჯი" | "1 000 დოლარი", "2 000 ლარი", empty | Auctions only |
| Place | "მიწოდების / მომსახურების ადგილი" / "მომსახურების ადგილი" | "თბილისი, რუსთავი , ზუგდიდი, ბათუმი", "Tbilisi, Georgia", "საქართველო", empty | Free text, mixed languages |
| Auction basis | "ვაჭრობა იმართება ჯამურ ღირებულებაზე" | present or absent | Reverse auctions |
| Buyer | link `/companytenders/<registryId>/<name>` | 204854595 (TBC), 205232238 (Credo), 202052580 (Telasi), 204432710 (GIZ), 204907128 (UNDP) | **Georgian registry code; a strong organization key.** Placeholders exist (UNICEF `1122334455`). Sale detail pages have no buyer link. |
| Title | In-page title block | — | **The `<title>` tag is SEO-rewritten** (e.g. "ტენდერი სავარძლების შესყიდვაზე – კრედო ბანკი – 69619") and must not be used |
| CPV | "CPV :" then "XXXXXXXX : label" pairs | 22100000, 30200000, 39100000, 45200000, 66100000, 79800000, 92100000 | Labels follow `lng`. Several codes per tender are common. |
| Partner ads | "პარტნიორი კომპანიის შეთავაზება" | — | Ad block; exclude |
| Description | "დამატებითი ინფორმაცია:" | Free text in GE/EN/RU | **Contains names, mobile numbers and emails** (§13). May contradict the structured fields (§10). |
| Documents | `#FilesTable`; rows `tr.IsObsolete0` with name, optional description ("სატენდერო დოკუმენტაცია", "დანართი #1") and date | docx, xlsx, xls, doc, pdf, zip | GUID links are stable, unlike hr.ge's expiring ones. Download is anonymous: `application/octet-stream`, `Content-Disposition` with a raw UTF-8 filename. `IsObsolete0` suggests replaced documents get `IsObsolete1` (not observed). |
| Invited companies | "მოწვეული კომპანიები" (company, ID number, email) | Empty on open tenders | Contains emails when filled. Never store. |
| Q&A | `#tenderCommentsWrapper` / `#TenderCommentsTable`; entries with "თარიღი : DD/MM/YYYY HH:MM:SS", role "მიმწოდებელი" (supplier) or "შემსყიდველი" (buyer), and text | 69619 had two | Public. The "module disabled by buyer" message is in the markup **even when messages exist**, so don't infer anything from it. Sales show a raw key, `Tender_Has_No_Chat_SALE`. |

English labels (`?lng=lang__en`, as the site spells them): "Tender Number", "Number of unique views", "Proposal Submission Form", "Tender Type", "Announcement Date", "Applying Start", "Applying End/Start of Reverse Auction", "Pretendents must provide price: Inlcuding VAT In USD" (typo in source), "Maximal Price", "Price Reduction Minimal Step", "Delivery / Service Location", "The auction will be held on the total price", "Offers from our partners", "Additional Information". Recommendation: parse Georgian (the default). One fetch per detail is enough, and English CPV labels can come from the dictionary instead.

---

## 10. Corpus measurements and data quality

### Volume

Counts come from the last page number at 20 per page, so treat them as ±20.

| Slice | Count |
|---|---|
| All tenders (`/tenders`, exact) | **11,762**; the oldest listed is 41358, announced 18/05/2015 |
| By year | 2015 ~200 · 2016 ~620 · 2017 ~580 · 2018 ~700 · 2019 ~680 · 2020 ~900 · 2021 ~1,160 · 2022 ~1,180 · 2023 ~1,460 · 2024 ~1,620 · 2025 ~1,540 · 2026 to 5 Oct ~1,240 |
| Last 30 days | **145** (about 4.8 a day) |
| Live now (`ts=_1_2_3_`, exact) | **40** (1 restricted). 12 had bids open; none were in live bidding. |
| By status | completed ~11.3k · failed ~330 · terminated ~90 · live 40 |
| By method | notice ~5.4k · one-envelope ~4.4k · reverse auction ~1.65k · prequalification ~310 · two-envelope ~20–40 |
| Asset sales | about 510–540, with a few live at a time |

### 30-day sample: 145 tenders on 8 pages

- **27 locked (19%)**: 22 anonymous currency purchases ("ვალუტის შესყიდვა", same-day announce and close) plus 5 named restricted tenders (Credo insurance, TBC DWDM, a TBC "closed electronic tender", United Financial Corporation NVMe, TBC Insurance Fortinet).
- **30 distinct buyers.** Top: Telasi 23, anonymous 22, Credo 18, TBC 15, Nikora 6, Telmiko 6, Ori Nabiji 6, Aversi Clinic 5, Microbank Crystal 5, Bochorishvili Clinic 4, Tradeline 3, UNICEF 3, Selfie Mobile 3, GIZ 2, UNDP 2.
- Status when sampled: 99 completed, 28 announced, 12 bids open, 4 failed, 2 terminated.
- Some items are opportunities rather than procurement, e.g. Credo's "N585-Woman in AI Scholarship Program", posted as a two-envelope tender.

### Data-quality issues observed

- Raw resource keys show on pages: `Tender_Has_No_Chat_SALE`, `Trainer_Shuko_Name`, `Consulting_InnerPageText2`.
- Placeholder buyer registry IDs, e.g. UNICEF `1122334455`.
- Many spellings for one buyer: სს "კრედო ბანკი", სს კრედო ბანკი, სს ,,კრედო ბანკი'', სს  ''კრედო ბანკი''. Normalize on the registry ID.
- VAT abbreviations differ: "დ.ღ.გ-ს" and "დ.ღ.გ.-ს". Amounts use spaces as thousands separators ("120 000").
- **Free text can contradict structured fields.** In 69617 the description says "DEADLINE … 24.10.2026; 19:59", but the structured bid end is 25/10/2026 20:00. Structured fields win, and deadlines are never taken from free text.
- Titles are mixed GE/EN/RU (Telasi writes bilingual GE/RU titles; UN agencies write English). Titles carry the buyer's own reference codes.
- Notice-type deadlines often fall at 00:00, so they are effectively a date.
- Re-runs are marked "(განმეორებით)" ("repeated") and get a new ID.
- Duplicate element IDs, broken attribute quoting, inline styles only.

---

## 11. Overlap with jobs.ge and hr.ge (our own corpus)

A read-only query on the local `scraplify` database found **22 tender posts first seen in the last 35 days** on jobs.ge and hr.ge, with titles like "ტენდერი - …". They sit in our job catalogue as vacancies. Buyers include Aversi Clinic, World Vision, UNDP (as "გაეროს განვითარების პროგრამა"), UNICEF, SOS Children's Villages, Lomisi, Carrefour, Aversi Pharma, NALAG, the Notary Chamber and Webservice.

Matching them against the 30-day etenders sample (title token-set ≥ 70 and buyer ≥ 60) found **7 of 22 automatically**. Two more are clear manual matches, giving **about 9 of 22 (40%)**:

| etenders.ge | hr.ge | jobs.ge | Buyer / subject |
|---|---|---|---|
| 69637 | 496263 | 757404 | Aversi Clinic, mobile computer carts |
| 69612 | 495732 | 756615 | Aversi Clinic, eye ultrasound (B-scan) |
| 69613 | 496109 | 757203 (manual) | Aversi Clinic, HVAC works |
| 69484 | — | 751590 | Lomisi, fire-detection system |
| 69470 | 492864 | — | Aversi Pharma, generators |
| 69647 (English title) | — | 756843 (Georgian title; manual) | UNDP, transport services |

What this means:

- Dedupe must **block by buyer** first. A plain best-title match paired Aversi's HVAC post with another buyer's HVAC tender.
- Titles can be in **different languages**, so buyer aliases across GE and EN are needed (UNDP ↔ გაეროს განვითარების პროგრამა), along with **deadline equality** and a publication window.
- A "tender post" detector for jobs.ge and hr.ge would remove these from vacancy ranking. It must exclude real job titles such as "ტენდერების მენეჯერი" (tender manager).

---

## 12. Traps and how to handle them

| # | Trap (evidence) | Handling |
|---|---|---|
| 1 | Paging past the end on `/tenders` gives **302 to page 1**, which a redirect-follower would silently loop on | Fetch with `maxRedirects: 0` and treat any 3xx as a named outcome. Stop at the last page number shown in the paging links. |
| 2 | A missing ID gives **302 to `TenderNotFound.aspx`**, never 404 | Record "not found"; mark removed only after 2 confirmations on different days |
| 3 | Bare `/view/<id>` gives **301 with a raw-UTF-8 `Location`** that can become garbled text in undici | Always request `/view/<id>/x`; the slug is ignored |
| 4 | A sale ID under `/view/` gives **302 to `/viewsale/`** | Take the kind from the card's link; never guess URLs |
| 5 | Bad `ss` gives **HTTP 500** (yellow error page); bad `ts` gives **200 with 0 results** | Build URLs only through a typed function, and check every outgoing URL against an allow-list (§14.3). Treat a 500 error page as a parser incident and don't retry it. Zero results on a normally non-empty query is an anomaly, not "no tenders". |
| 6 | **Page size lives in the session** (set to 100, it stuck) | Send requests without cookies, so every request gets the defaults. Check 30 cards a page on `/tenders` and 20 on search, except the last page. |
| 7 | ~19% locked cards with no detail link | Keep card metadata only. **Never build a detail URL for a locked card** (terms §2.7/2.8). Skip anonymous currency purchases. |
| 8 | No IDs; labels vary by method and kind; broken quoting | Use cheerio/parse5 with a **versioned Georgian label dictionary**. Required fields must be present, or the page is quarantined (§13.4). |
| 9 | View counter, server clock, ads and Q&A change on every request | Leave them out of the meaningful-content hash, and track Q&A separately as a count plus the last message date |
| 10 | Free-text deadline contradicts the structured one | Structured fields always win; keep the raw text |
| 11 | Names, phones and emails in descriptions and Q&A | Don't republish descriptions or Q&A; redact contacts if text is ever shown; keep them out of logs |
| 12 | 34 s responses, a 90 s connect timeout, no gzip | 60 s timeout per request, retry with backoff on network errors and 5xx (but not trap 5's 500), 3 s spacing, one request at a time, and a small request budget |
| 13 | State-changing GET endpoints (`DeleteComment`, `ToggleFav`) | They are built in JavaScript, not links, but the URL allow-list rules them out anyway |
| 14 | Legacy stack that may be rebuilt without warning | Canary checks (§14.8); mark the run partial on drift and keep the last good data |
| 15 | No `ETag`/`Last-Modified`, so every fetch is a full download | Pick what to fetch from card changes (status, end date, amendment timestamp) |

---

## 13. Privacy and rights

- Descriptions name real people with mobile numbers and work emails (a TBC procurement manager's mobile, a Credo staff email, Nikora contact phones). Q&A text is public free text, labelled by role.
- The invited-companies table holds company emails and would only be visible to invited users. We never fetch restricted details.
- Anonymous tenders hide the buyer by design. **Never try to work out who the buyer is.**
- Documents are public but belong to buyers. Mirror nothing (concept §16). Show a count and file types, and link to the etenders.ge page.
- Logos: don't hotlink. That would send our visitors' requests to etenders.ge, and the logo rights are unclear.
- Our detail fetches may raise the "unique views" counter shown to buyers, which is another reason to keep fetches few.

---

## 14. Strategy

### 14.1 Product framing (recommended)

- Add **tenders as a separate opportunity type and a separate "Tenders" tab**, aimed at freelancers, consultants and small firms. Don't mix them into vacancies or into the vacancy CV ranking by default.
- **Scope v1:** public purchase tenders only. Skip asset sales (`/viewsale`), locked or restricted cards and anonymous currency purchases. Optionally count restricted ones without showing details.
- **Show:** title, normalized buyer, deadline (date and time, Tbilisi), status, method, value (only when stated, with currency and VAT basis), delivery place, CPV labels (GE/EN), document count and types, and an "Open on etenders.ge" link (bidding happens there and is paid). Write "not specified" wherever the source says so; never invent a value.
- **Don't show** descriptions, until permission is granted (policy `mayRepublishFullContent: false`), and don't show Q&A or logos.

### 14.2 Acquisition plan

| Job | When | Request | Cost |
|---|---|---|---|
| **A. Live set** | every 4 h | `/search/?ss=-1&ts=_1_2_3_&kw=&tn=&br=&cpv=&st=&end=&stamm=&endamm=&pg=N`, every page | 2–3 requests |
| **B. New arrivals** | daily | same with `ts=__&st=<last success − 2 days>` | 1–2 requests; catches tenders that open and close between polls |
| **C. Detail fetch** | as triggered | new ID, or a card change (status code, end date, amendment timestamp) | ~5–15 a day |
| **D. Live refresh** | daily | details of all live tenders, because documents and Q&A can change without the amendment icon | ≤ 40 a day; can drop to every 2 days |
| **E. Closure** | when a tender leaves A | one detail fetch reads the terminal status (99/4/5) and bidder count; then stop tracking it | ~5 a day |
| **F. Reconciliation** | weekly | `st=<today − 30 days>` window, every page | ~8 requests |
| **G. CPV dictionary** | weekly | `lng=1` and `lng=2` | 2 requests, ~200 KB |
| **Backfill** | once | `st=<today − 90 days>` window plus details of public tenders | ~22 index pages + ~350 details, ~35 MB, ~20 min at 3 s |

- Daily budget: about **40–75 requests and 5–10 MB**, mostly from job D.
- **Never:** full `/tenders` walks, session page-size tricks, document or logo downloads, the sales list (v1), or any logged-in path.
- Closure here is **read from the source**, not inferred from absence (jobs.ge and hr.ge need missing-streak logic; this source doesn't).
- No archive backfill: the full archive would be about 1.2 GB and about 10 hours at 3 s, and the 60/60/180-day retention policy would delete most of it.

### 14.3 Source policy and URL allow-list (`src/policies/etenders-ge.ts`)

- `allowedHosts: ['etenders.ge']`. `www` redirects there.
- `allowedPathPatterns`: `/search/` (exact), `/view/` (prefix), `/Pages/Tender/getTenderCPVSelection.aspx` (exact). Optionally `/tenders` (exact) as a fallback, and `/companytenders/` (prefix) later.
- `disallowedPathPatterns`: `/Pages/Tender/TenderDetails/`, `/Pages/Tender/TenderSearch/`, `/Pages/Tender/FileHandler/`, `/Pages/Profile/`, `/Pages/HeartBeat.aspx`, `/login`, `/Register`, `/viewsale/` (v1).
- `isEtendersGeUrlAllowed`, fixing the exact parameter shapes:
  - `/search/` must carry exactly these keys: `ss ∈ {-1,1,2,3,4,5}`; `ts` is `__` or matches `^_(?:(?:1|2|3|4|5|99)_)+$`; `st`/`end` empty or `^\d{2}-\d{2}-\d{4}$`; `kw`, `tn`, `br`, `cpv`, `stamm`, `endamm` empty (v1); `pg` absent or a positive integer. No other keys and no duplicates.
  - `/view/<digits>/x` with no query.
  - The CPV URL with `TenderId=-1` (or digits) and `lng ∈ {1,2}`.
- `rateLimit: { crawlDelaySeconds: 3, maxConcurrency: 1 }`. robots.txt declares no delay because there is no robots.txt; 3 s matches hr.ge.
- Fetch options for this source: `maxRedirects: 0` and a 60 s timeout (the shared fetcher defaults to 5 hops and 15 s).
- `termsUrl`: the Registration_Contract URL above. `robotsUrl`: `https://etenders.ge/robots.txt`, with the 404 recorded in the evidence.
- `display.mayRepublishFullContent: false` until permission. `linkedResources` stays disabled (documents link-only).

### 14.4 Adapter (`src/adapters/etenders-ge/`)

- Modules: `discovery.ts` (cards), `detail.ts` (fields), `labels.ts` (versioned label dictionary), `money.ts`, `dates.ts`, `crawl.ts`, `RECON_NOTES.md`, `fixtures/`.
- **Card parse:** deduplicate cards by ID. Status comes from the `status_N` class. Restricted means a lock image or no detail link. Anonymous means the buyer text is "ანონიმური ტენდერი". Take the amendment timestamp from the `changed2` alert and the kind from the link path.
- **Detail parse:** find label text in normalized text nodes and read the value that follows.
  - **Required:** number, status, method or kind, announced datetime, bid end datetime, buyer, title.
  - **Optional:** bid start, price basis, max/start value, min step, places, CPV, description, documents, bidder count, Q&A count and last date, buyer registry ID.
- **Normalization:**
  - Datetimes: `DD/MM/YYYY HH:MM` in Asia/Tbilisi (+04:00).
  - Money: "120 000 დოლარი დ.ღ.გ.-ს გარეშე" becomes `{amount: 120000, currency: 'USD', vat: 'excluded'}`. Map ლარი/ლარში → GEL, დოლარი/დოლარში → USD, ევრო/ევროში → EUR (EUR is not observed yet, so test it).
  - "არ არის მითითებული" becomes null, an explicit unknown.
  - Places: split on commas and keep the raw text.
  - CPV: store the codes; labels come from the dictionary.
- **Meaningful-content hash excludes** the views counter, countdown and server clock, the partner block, Q&A, notifications and `__VIEWSTATEGENERATOR`.
- **Fixtures to capture, dated:**
  - One-envelope live (69689-like); completed with Q&A (69619)
  - Reverse auction live (69679) and completed (69611)
  - Notice in English (69674, GIZ); two-envelope completed (69397); prequalification in USD excluding VAT (69617)
  - Terminated (69534); failed (69607); 2015 legacy (41358); sale (69678, kind detection)
  - Live search pages; arrivals window; restricted card (69589); anonymous currency-purchase card (69685); amended card (69679)
  - The 302s (past the last page, not found, view → viewsale), the 500 error page, and the silent empty `ts=2`

### 14.5 Domain and schema

- Add `'tender'` to `OpportunityType` (`src/domain/opportunity.ts`) and to the database's type constraint. This is an **additive migration and needs owner approval** (decisions in force).
- **v1:** keep tender fields in `source_listing_revisions.structured_attributes` (JSON) together with the existing `published_date` and `deadline_date`, so nothing else in the schema changes. Move them to a typed `tender_details` table (method, submission form, bid window, currency, VAT basis, max value, min step, places, CPV codes, bidder count, restricted/anonymous, buyer registry ID, documents) once the public UI needs indexed filters.
- CPV becomes a taxonomy axis: a versioned dictionary table (code, label_ka, label_en) or `taxonomy_terms` with a `cpv` axis.
- Organizations: store the buyer registry ID as an external identifier. Trust 9-digit Georgian codes and flag anything else.

### 14.6 Dedupe and the tender-post detector

- **Within etenders:** a re-run ("განმეორებით") is a new procedure with a new ID. Link it as a successor, not as a duplicate.
- **Across sources:** build candidates within the same buyer (normalized, with GE/EN aliases), then score with equal deadline date, publication within ±7 days, title similarity (after stripping "ტენდერი -" style prefixes) and the buyer's reference codes (`№597`, `0007464`) when both sides have them.
- **Golden pairs:** the 9 matches in §11. **Hard negatives:** Aversi's 4 different September tenders, Telasi's many similar equipment tenders, Ori Nabiji's repeated vehicle sales.
- **Detector for jobs.ge and hr.ge:** a title beginning with ტენდერი, or containing tender, ფასთა გამოკითხვა, RFQ, RFP or "expression of interest", **and** no job-role words (მენეჯერი, სპეციალისტი, manager, specialist, officer, კოორდინატორი) makes the item a `tender`. Check it on the full corpus before switching it on (22 hits in 35 days).

### 14.7 Public surface

- A "Tenders" tab sorted by soonest bid end, with filters for CPV group, buyer, method and value range. Shows a real deadline countdown and the structured fields only.
- Follow the frontend rules in CLAUDE.md: never invent data, never uppercase Georgian, and browser QA through the `professional-frontend` skill before calling it done.

### 14.8 Operations

- A pipeline unit for etenders-ge. Jobs A–E run every 4 h (cheap); F and G run weekly. The matching bundle doesn't need tenders in v1.
- **Canary checks** (mark the run partial and keep the last good data on any failure):
  - the live set returns at least 1 card (it held 40 when measured)
  - every card has an ID, a status class and both dates
  - status codes ⊆ {1, 2, 3, 4, 5, 99}
  - cards per page equal the expected page size, except the last page
  - required detail labels are present
  - counts of 302s and 500 error pages
- Retention follows the existing 60/60/180-day policy.
- `/admin` shows the source's health row like the other sources.

### 14.9 Matching (later)

- A reviewed, versioned **CPV-to-role crosswalk** would let CV Ranked show tenders to freelancers and consultants. Verified codes to start from: 92100000 film/video services, 30200000 computer equipment, 79800000 printing, 66100000 banking/investment services, 45200000 construction works, 39100000 furniture.
- Keep tenders out of the vacancy ranking unless the user opts in.

### 14.10 Scaling to more tender sources

- Keep the tender model independent of any one site: normalized method (with raw), normalized lifecycle status (with raw), bid window, money (amount, currency, VAT), CPV codes, buyer with registry ID, document metadata.
- Then the next source is just an adapter plus a policy. Candidates, **not studied here:**
  - tenders.ge, another private board with paid announcements
  - the state procurement agency's system at tenders.procurement.gov.ge, much larger
  - international agencies' own procurement pages (UNDP, UNICEF and GIZ also post here as notices)

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Audience fit: tenders are B2B, and bidders need a company or sole-proprietor registration plus a fee | Start as a separate tab, measure clicks, keep the scope small |
| Permission and rights | Ask etenders.ge first; show only structured fields and a link |
| Site rebuilt or markup changed | Canary checks, quarantine, fixtures, adapter isolation |
| Server slowness or outages | Timeouts, backoff, last good data; the cost is negligible |
| Wrong data (free text, placeholders) | Explicit unknowns, structured-first fields, provenance kept |
| Privacy (contacts in text) | Don't republish descriptions or Q&A; redact; keep out of logs |

---

## 16. Rollout plan

1. **Owner decisions** (§17), and contact etenders.ge.
2. **Adapter, policy and fixtures**, local surface only. *Exit:* fixture tests pass; a live dry run on `scraplify_qa`; 7 days of scheduled polling with no anomalies; the live-set count equals the site's own count.
3. **`tender` type migration** (owner approval), the jobs.ge/hr.ge tender-post detector, and dedupe rules with golden pairs. *Exit:* precision checked on the golden pairs; no tender posts left in the vacancy catalogue.
4. **Public "Tenders" tab.** *Exit:* real-browser QA, then deploy.
5. Optional: the CPV-to-role crosswalk for CV Ranked; more tender sources.

---

## 17. Owner decisions (2026-10-07)

1. **Go**, as a separate "Tenders" tab for freelancers and small firms; not mixed into vacancies or CV Ranked.
2. **Scope:** public purchase tenders only. Asset sales, invite-only tenders and anonymous currency purchases are skipped.
3. **Permission:** the owner asked etenders.ge and has its confirmation (recorded in `docs/RIGHTS.md`). Descriptions stay unpublished for now, like the job boards' (`mayRepublishFullContent: false`), because they carry personal contacts.
4. **Job-board tender posts** are reclassified as tenders (Phase 9B).

## 18. Not verified yet (check at build time)

- Whether `st`/`end` filter on the announcement date (assumed) or on the end date. A boundary query would settle it.
- Status 3 (live bidding): none was running. Capture a fixture while a reverse auction is bidding.
- `IsObsolete1` rows (replaced documents) and EUR amounts: not seen.
- Whether adding documents or Q&A sets the amendment icon. Unknown, which is why job D refreshes live tenders daily.
- Whether search's default of 20 and `/tenders`' default of 30 per page hold over time. Check them, don't assume them.
- How fast the server tolerates requests (it sends no rate-limit headers). Stay at 3 s.

---

## 19. Reproduction pointers

- Live set: `https://etenders.ge/search/?ss=-1&ts=_1_2_3_&kw=&tn=&br=&cpv=&st=&end=&stamm=&endamm=`
- Detail: `https://etenders.ge/view/69689/x` · sale: `https://etenders.ge/viewsale/69678/x` · buyer: `https://etenders.ge/companytenders/204854595/x`
- CPV: `https://etenders.ge/Pages/Tender/getTenderCPVSelection.aspx?TenderId=-1&lng=2`
- Terms: `https://etenders.ge/Pages/GeneralHelpViewer/GeneralHelpDisplay.aspx?key=Registration_Contract`
- Traps: `https://etenders.ge/tenders/?pg=394` (302 to page 1) · `https://etenders.ge/view/9999999/x` (302 to TenderNotFound) · `…/search/?ss=_99&ts=__…` (500) · `…/search/?ss=-1&ts=2…` (empty)
