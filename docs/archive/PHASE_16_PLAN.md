# Phase 16 plan: the site redesign (filters, Browse, dark and light)

Three designs the owner approved as HTML mockups on 2026-11-14, to be built into the site. Kept as a tracker once building starts.

- **Status: Phase 16 complete 2026-11-15.** **16D and 16E live** since 2026-11-15 07:01 UTC as `557f8d0` (migrations 0055 and 0056; checked on jobster.fun). **16A live** since 2026-11-14 11:25 UTC as `5f69597` (PR #111); **16B live** since 2026-11-14 13:05 UTC as `c0ddf0f` (PR #112); **16C live** since 2026-11-14 14:14 UTC as `4a251d2` (PR #114, CI green), web-only; Phase 16's three sub-phases are done (16D optional, waiting on the owner).
- **The mockups are the visual source of truth.** They live outside the repo, on the owner's PC, in `C:\Users\Giorgi Teliashvili\Desktop\xtelo-mockups\`. To view them, run `python -m http.server 8765 --bind 127.0.0.1` in that folder and open `http://127.0.0.1:8765/home-v2.html`. Stop the server afterwards.
  - `real-estate-filters-v2.html` with `real-estate-filters-data.js`: Real estate filters, **approved**. It uses synthetic listings drawn from real distributions; the sub-districts, streets and stations are real.
  - `browse-v2.html` with `browse-data.js`: Browse, **approved**. It uses a real read-only sample of the live catalogue: 460 random open jobs, all 61 open tenders, 272 courses.
  - `home-v2.html`, `theme.css` and `theme.js`: the dark and light themes and the switch, **approved**. They are wired into both pages above. `assets/` holds copies of `web/public`'s logo, poster and film.
- **All open work, every phase:** the Board at the top of `docs/STATUS.md`.
- **Keeping it current:** CLAUDE.md, "Tracking". Each item gets its mark (✅ done · ⏳ under way · ❌ not started) and a "Changed:" note wherever building changes the plan.

## The owner's decisions (2026-11-14)

1. **Real estate filters v2: approved** ("brilliant, approved"). He singled out the metro line diagram and the price panel.
2. **Browse v2: approved.**
3. **Dark and light: approved.** Dark stays exactly as the site is today. Light is new.
4. **The theme is remembered** in the visitor's browser and stays the same on every visit until they change it.
5. **A first visit gets light.** This changes the mockup's first default, which was dark.
6. **The Programmes tab stays a separate page** (Phase 15's 15E). It should be built in this style, reusing Browse v2's course filters.
7. **Not yet answered:** "Buy" versus "Sale" on Real estate. Keep "Buy" unless the owner says otherwise.

## Sub-phases

Each is its own branch and PR with an exit gate in `docs/STATUS.md`. **Order: 16A, then 16B, then 16C.** The theme comes first because the other two are built on its colours, so nothing is coloured twice.

| | | What | Goes live? | Waits on |
|---|---|---|---|---|
| ✅ | **16A** | Theme foundation: one set of colours for every screen, dark and light, the header switch, the choice in a cookie | yes | done: merged as `5f69597` (PR #111), live 2026-11-14 11:25 UTC |
| ✅ | **16B** | Real estate filters v2 | yes | done: merged as `c0ddf0f` (PR #112), live 2026-11-14 13:05 UTC |
| ✅ | **16C** | Browse v2 | yes | done: merged as `4a251d2` (PR #114), live 2026-11-14 14:14 UTC |
| ✅ | **16D** | A field for jobs.ge vacancies, guessed from the listing's text and labelled as a guess. The owner's go 2026-11-14; merged as `efa1c99` (PR #115); live since 2026-11-15 07:01 UTC as `557f8d0` | — | — |
| ✅ | **16E** | A city for jobs.ge vacancies, read from the listing's own text and marked "from text". The owner's go 2026-11-14; merged as `0e5bdc9` (PR #116); live since 2026-11-15 07:01 UTC as `557f8d0` | — | — |

## 16A: theme foundation

**What exists today.** `web/app/globals.css` has two families of colours:
- a base family: pure black, a pink accent `#d88bd2`;
- a "browse" family: lime `#d6ff3f`, `#0e1114` panels, the yellow header.

The v2 designs use the browse family everywhere. `html` is fixed to `color-scheme: dark`.

**Build:**
- **One colour set, as CSS variables.**
  - Dark values: as `theme.css` and the mockups' `:root` blocks.
  - Light values: under `:root[data-theme="light"]`, as `theme.css`.
  - Every screen moves onto it: home, Browse, the detail page, Listings, Real estate, CV Ranked, admin, the error and not-found pages, and the footer.
  - The pink base accent goes. Ask the owner before deleting a colour he might want kept elsewhere.
- **Light rules.**
  - Lime is never text on white; it measures about 1.1:1.
  - Lime fills buttons and selected options, and it is the highlighter under the home headline.
  - Words that were lime become olive: `#4a6400` (6.6:1 on white), lines `#7aa300`, bars `#a6d000`.
  - Warning text `#8a5a00`. Kind colours: job `#4a6400`, tender `#1d6fb8`, course `#b45f06`. Metro line colours `#d64545` and `#23913a`.
  - The yellow header and the logo stay as they are.
- **The home page film.** In light mode, `filter: invert(1) grayscale(1) contrast(0.55) brightness(1.2)` on the same video and poster, under a light veil. It is the same file, so nothing new is downloaded. The crawler's scrape colours (`--scrape-color`) need checking on light.
- **The switch.** A sun and moon switch in the header, `role="switch"`, on every page, desktop and the phone menu.
- **Remembering the choice.**
  - A cookie `theme=light|dark`, one year, `SameSite=Lax`.
  - The root layout reads it on the server and renders `<html data-theme=…>`. The first paint is then right, with no flash and no inline script.
  - With no cookie, the page is light.
  - Clicking the switch sets the cookie and the attribute at once. A short colour fade runs, and none for reduced motion.
- **Caching.** The cookie must not break the public pages' caching (`web/lib/cached.ts`). Check what varies by cookie on the public surface before building.

**Exit gate:**
- ✅ Every screen in both themes at 390 and 1280 on local and public, in Georgian and English, through Playwright. 200 page loads on 2026-11-14 against a throwaway copy (`scraplify_qa_16`: 4,254 opportunities, 4,146 ss.ge listings, migrations to 0054): public 5 routes (40 loads), local 15 routes including a detail page and the not-found page (120), admin 5 routes signed in with the e2e test session (40); screenshots read by eye in both themes.
- ✅ `scrollWidth` equals `clientWidth` on all 200. No console errors (the not-found page logs only its own 404).
- ✅ Contrast checked on every text colour against its background: every text element on every load (101,000 to 165,000 per surface), composited over its real ground, none under 4.5:1 (3:1 for large text); the check was shown to catch a planted lime word on light (1.05:1). axe (WCAG 2.1 AA, `test:e2e:surfaces`) finds nothing on the public pages, now light by default.
- ✅ A first visit is light. The choice survives a reload and a new tab; Space on the focused switch toggles it; the cookie is `SameSite=Lax` for 365 days. No flash on load: with the CPU throttled 6×, the first frame painted after a red start page is already the chosen theme's ground, in both themes.
- ✅ `web-design-guidelines` review clean (one fix: the phone menu contains its scroll). Surface-boundary review: no defect. Tests: 2,735 pass locally; ✅ CI green on PR #111.
- ✅ Deployed web-only 2026-11-14 11:23 to 11:25 UTC (`.git/handoff-16a/deploy-16a.sh`; no migration, the ss.ge crawl left running on its own release, so old releases not pruned yet). Both sites ready, health check ok. On jobster.fun, five pages at 390 and 1280 with no cookie: light, the switch present, no overflow, no console error; a click sets a `Secure`, `SameSite=Lax` cookie and dark survives a reload.

**Changed while building (2026-11-14):**
- The header is built as the mockups draw it, in both themes: the links as plain ink words with the current page an ink pill, then the switch and the language. Today's olive blocks are gone. On the public site the links now fit inline from 900px wide (they were in the menu below 1,560px); the local bar's eleven links fit from 1,640px in English and 2,230px in Georgian, measured.
- The cookie is `xtelo-theme`, beside `xtelo-locale`, rather than `theme`.
- Light status and kind colours were darkened to hold 4.5:1 on the selected-row ground as well: open `#1a7431`, unconfirmed `#8a5a00`, held `#a84300`, tender `#1a64a8`, course `#9c5205`.
- Decorative lime (the rule under the headline, the dots, the CV progress bar) uses the line colour, `#7aa300` on light, where lime itself vanished. The landing crawler deepens its three colours on light.
- The site's focus ring moved into Tailwind's base layer, so the header's own ink ring applies (lime on the yellow could not be seen).
- The pink accent and its two siblings are deleted outright, as planned; nothing else used them.

## 16B: Real estate filters v2

The mockup is the spec. Key points:
- **Deal:** a segmented control, Buy · Rent · Daily · Pledge · All.
- **Kind:** a Kind button with line icons.
- **Where:** one combobox. It takes:
  - neighbourhood, ss.ge district, official district, city, street or metro station;
  - free words, in Georgian or English.
- **Promoted pills by kind:**

  | Kind | Pills |
  |---|---|
  | Flat | Price, Rooms, Metro, Area, Floor |
  | House, cottage | Price, Rooms, Metro, House area, Yard area |
  | Commercial | Price, Space type, Metro, Area |
  | Land | Price, Land type, Area |
  | Hotel | Price, Rooms, Area, Metro |

  Floor applies to flats and commercial only: floor is stated on 97.5% of flats and 1.4% of commercial spaces.
- **All filters:** a right-hand sheet with every filter the live tab has today, in eight groups (Type, Location, Price, Size and layout, Building, Features, Listing, Display). It has jump links and a live "Show N" button.
- **Counts:** on every option; options with none are dashed.
- **Metro:** walking time (5, 10, 15 or 20 minutes) plus the two-line station diagram.
- **Price:** $ or ₾, total or per m², with a histogram, a two-handle slider and presets.
- **Results:** chips for applied filters with Clear all, and a sticky bar.
- **On a phone:** each pill opens a bottom sheet.
- **Empty state:** offers which filter to drop.
- **Detail-page filters:** a note says how many listings had their page read.
- **Location quality:** a toggle on `location_uncertain`.

**Data it needs already exists:**
- `realestate.listings.metro_nearby` and `metro_nearby_minutes` (0053, public);
- `location_uncertain` and `location_precision` (14D);
- the place catalogue (14B, C6);
- every panel filter in `web/lib/real-estate-panels.ts`.

**To decide while building:**
- Counts on every option can be the costly part. Keep them only inside open panels if they are slow.
- The state stays in the URL, as today.

**Exit gate:** as 16A's, plus every filter the live tab has today still reachable (a test lists them).

**Built 2026-11-14** on `phase-16b-real-estate`:
- The bar, the pills by kind, the popovers (wide) and bottom sheets (phone), "All filters" in its seven groups plus Display, the Where box, the metro diagram and the price panel, drawn in the browser from one registry (`web/lib/real-estate-registry.ts`). The address is still the whole state (`web/lib/real-estate-form.ts`, `real-estate-params.ts`): each change asks the server for the page again while the list dims.
- Counts: `/real-estate/facets` (`src/realestate/facets.ts`), asked only while a panel is open, each facet capped at 2.5 s and kept ten minutes per filter set; a timed-out one is kept one minute (changed after the deploy, below). Place suggestions: `/real-estate/places` (`src/realestate/place-suggest.ts`), over C6, with counts under the other filters in one scan.
- Results: a Metro column (our walking band to the nearest station, or to the one asked for; "over 20 min" where located and none is near) and a "Nearest metro first" order; three-line rows under 900px.

Changed while building:
- **A bare `/real-estate` is "Buy"** (the mockup's default; the owner confirmed it after the deploy, 2026-11-14); `deal=all` is every deal. Old addresses still work: `city` and `area` become places, and a house's `hmin`/`hmax` become its area.
- **"House area" is the list's area** for houses and cottages: on production the two agree on all 775 houses whose own page gives both, and the list's covers every house (44,648). Yard area stays a listing-page filter (740 of 44,648 houses) and says so in its panel.
- **Floor** is offered for flats and commercial spaces (and with no kind), no longer for houses, land and hotels, as the plan says. Rooms, status and condition now work with no kind chosen, as in the mockup.
- **Area presets** depend on the kind (a plot in hundreds of m²); the mockup had one set.

Gate:
- ✅ Every filter the tab had still reachable: `web/lib/real-estate-params.test.ts` lists 29 of them, each set from an old address and found in the registry; 53 address tests in all.
- ✅ Browser, public and local surfaces on `scraplify_qa_16`: 144 page loads (9 filter states, both themes, Georgian and English, 390 and 1280) and 56 open panels (every pill, the kind, and "All filters" for five kinds, both themes, both widths): no overflow, no console error, no text under its contrast floor, every panel inside the screen with focus in it.
- ✅ Reviews: web-design-guidelines (two fixes: focused rows clear of the sticky bar, pills without the tap delay); surface-boundary review, no defect (the endpoints read only `public_listings` and `public_places`).
- ✅ Tests: 2,785 pass locally (26 new for the counts and place suggestions); ✅ CI green on PR #112.
- ✅ Deployed web-only 2026-11-14 13:05 UTC (`.git/handoff-16b/deploy-16b.sh`; no migration; the ss.ge crawl left running on its own release, so old releases still not pruned). Both sites ready, health check ok. On jobster.fun at 390 and 1280: light, 91,726 properties under "Buy", no overflow, no console error; facets answer in 0.8 to 1.5 s on broad filters, place suggestions in 0.7 s.
- Changed after the deploy: the default page's Kind and Rooms counts timed out on the first request after the restart (cold caches) and, kept ten minutes, left those panels without numbers. A timed-out count is now kept one minute: PR #113, live as `9e678ef` at 13:12 UTC; the default page's counts then answered in 1.6 s.

## 16C: Browse v2

The mockup is the spec.
- **Kind:** a segmented control at the top, All · Jobs · Tenders · Courses, with counts.
- **Promoted pills by kind:**

  | Kind | Pills |
  |---|---|
  | All | Place, Closing, New, Board |
  | Jobs | Field, City, Salary, New, Closing |
  | Tenders | Category (the CPV division), Closing, Procedure, New |
  | Courses | Starts (month), Country, Field of study, Fee, Credits |

- **One search box:** words, a city or country, a field, or an employer, buyer or school. Picking a field switches to its kind.
- **All filters,** in groups (What, Where, When, Money, Requirements, Listing, Display). It includes hr.ge's seniority, education ("Your education"), "Languages you speak" (no language beyond those ticked), contract, hours, where you work, bonus, students, driving licence and benefits. It also includes the tender's estimated value and where bids go, and the course's language, length and format.
- **Results rows:**
  - a kind icon, the title, the organisation, and a facts line that depends on the kind;
  - a pay, value or fee column, left blank when not stated, never a column of "not stated";
  - "Closes", or "starts" for a course with no deadline;
  - board chips.
  - On a phone, pay, dates and boards share one line.
- **Never hide silently.** jobs.ge, most of the vacancies, states no city, salary or field. So every filter on a fact only some listings state must:
  - say how many listings it leaves out and from which board ("275 from jobs.ge, which never states it");
  - offer one switch, "Also show the N that don't state it". The kept rows come after the matches, under a divider.
  - The count line says "· N left out for not stating it — show them too".
- **State leaves the public filter.** The public site lists only open rows, so its closed and expired options show 0 today. It stays on the local surface.
- **Course fees:** each row shows the school's own amount and currency. Grouping uses a dated reference-rate table: Phase 15's choice H, and its buckets (up to €500, €500–1,000, €1,000–2,500, over €2,500).

**Data:**
- **jobs.ge:** title, employer and deadline only.
- **hr.ge** (`source_listing_revisions`):
  - `locations` (city);
  - `salary_raw` ("1500-?" or "1500-2000"; about 30% of active listings);
  - `structured_attributes`: `specialty`, `industry`, `seniorityLevels`, `educationLevels`, `languages`, `employmentTypeName`, `workScheduleName`, `employmentFormTypeName`, `isWithBonus`, `isSuitableForStudent`, `drivingLicenses`, `benefits`.
- **etenders.ge:** `cpv`, `method`, `maxValue` (stated on about 3 of 38), `submission`, `tenderNumber`.
- **Courses:** `country`, `city`, `startDate`, `endDate`, `durationDays`, `format`, `language`, `fee`, `credits`, `disciplines`, `earlyBirdDeadline`.
- **The public views:** `public_opportunity_members` exposes `locations`, `salaryRaw` and `structuredAttributes`.
- **The query layer:** `src/browse/queries.ts` and `public-queries.ts` gain these filters and the option counts. The search box needs its suggestion lists from the server.

**Exit gate:** as 16A's, plus a test per new filter, including the "doesn't state it" counts.

**Built 2026-11-14** on `phase-16c-browse`:
- **Rows in memory.** `src/browse/browse-index.ts` reads every opportunity with its live members and the facts Browse filters on, in one query per surface (the base tables on local, `public_opportunity_members` and `public_opportunities` only on public): 0.2 s for the 29,167 live memberships of the local corpus. Each web process holds it and rebuilds it in the background every 60 s (`refreshingFor`, `web/lib/cached.ts`), so a crawl's rows show within about a minute and no page waits on the rebuild. Whether a public row is open is checked on every request.
- **The engine.** `src/browse/browse-engine.ts`, pure TypeScript: the matches, counts on every option, the kind counts, what each filter leaves out and from which board, and what dropping one filter would show; one pass per page. `src/browse/browse-form.ts` is the form and its address, shared with the browser.
- **The screen,** as the mockup: All · Jobs · Tenders · Courses with counts; one search box over words, cities, countries, fields, employers, buyers and schools (`/opportunities/suggest`; Latin typing finds Georgian names, "silk" → სილქნეტი); the pills by kind; popovers and bottom sheets; "All filters" in its groups; the price panel for salary, value and fee; applied chips; the count line with "N left out for not stating it — show them too"; kept rows after a divider; the empty state offering which filter to drop. Rows: kind icon, title, organisation, a facts line by kind, pay/value/fee (blank when not stated), closes or starts, board chips; Save and Dismiss and the state stay on the local edition.
- **Course fees and tender values** are grouped at the National Bank of Georgia's official rates of 2026-11-14 (`src/browse/reference-rates.ts`, dated, committed); each row shows the source's own amount, and a currency not in the table is never converted.
- **Shared controls.** The chip, switch, number field, slider, histogram and sheet helpers 16B drew now live in `web/components/filter-ui.tsx`, used by both tabs.
- **Fold-in:** a detail page's "What the source states" table has no minimum width below 640px, so at 390 its values wrap in a 343px box instead of scrolling sideways by 41px.

Changed while building:
- **Counts are worked out in memory, not in SQL** (16B's way): with counts on every option, the kind counts and the "left out" numbers, one SQL query per count would have been dozens per page. It follows Phase 15's choice I.
- **Older addresses keep working:** `source=` is a board; `type=` becomes the kind it names, and the landing page's `type=job&type=tender` (no one kind) stays a filter with its own chip. The other old values (`closing`, `since`, `cross`, `status`, `sort`, `show`) read as before.
- **"Courses" is the summer-school kind.** The other programme kinds (none crawled yet) show under "All" until Phase 15E's tab.
- **On a phone** pay, dates and boards wrap onto a second line, and the boards drop under them when there is no room (a fixed four-column line overflowed by 19px on cross-posted rows).

Gate:
- ✅ A test per filter (30, each with a row that fits, one that does not, and one that does not state the fact: left out, counted, then kept after the match), plus the windows, public eligibility, the by-board "never states it", option counts, order, drops and the kind change (`browse-engine.test.ts`); the address (`web/lib/browse-params.test.ts`); the loaders on a throwaway database and the assembly (`browse-index.test.ts`); the rates; `refreshingFor`. 2,859 tests pass (2,785 before).
- ✅ Browser, both themes, Georgian and English, 390 and 1280: the local surface on the real local corpus, read-only (8,164 open vacancies, 32 tenders): 80 page loads over 10 states including a detail page, and 52 open panels; the public surface on the course database (`scraplify_qa_p15`, 623 courses): 56 page loads and 28 panels. No overflow, no console error, no text under its contrast floor, every panel inside the screen with focus in it. A real flow driven by mouse and keyboard: a salary preset, keeping the 7,209 vacancies with no salary (461 match), Batumi picked from the search (242 shown, 5,000 left out for stating no city), Tenders dropping the job-only filters.
- ✅ web-design-guidelines review: two fixes (dates through `Intl`, the search input's name).
- ✅ Surface-boundary review: no leak (the public process reads only the public views; nothing writes). One fix: the suggestions cache is keyed on the checked form, not the raw address, so made-up parameters cannot fill it. Noted: a row the public views drop (quarantined, detached) can stay on the public list up to about a minute, until the next rebuild; whether it is open is checked on every request.
- ✅ CI green on PR #114. Deployed web-only 2026-11-14 14:13 to 14:14 UTC (`.git/handoff-16c/deploy-16c.sh`; no migration; the ss.ge crawl left running on its own release, so old releases still not pruned). Both sites ready, health check ok. On the host: the first Browse page 4.4 s (the index built once), then 0.2 to 0.4 s; suggestions 0.15 to 0.6 s. On jobster.fun at 390 and 1280 in both themes: 16 loads, no overflow, no console error; 8,759 open (8,075 vacancies, 61 tenders, 623 courses); a salary of ₾1,500+ shows 457 and says 7,127 are left out for stating none. From the PC the page is 34 KB compressed (343 KB raw) and arrives in about 0.7 s.

## 16D (optional): a field for jobs.ge vacancies

jobs.ge states no field. A keyword classifier on the title could give one, using the taxonomy step's `keyword` method. It would be shown as "field guessed from the title". The owner gave the go on 2026-11-14.

Changed 2026-11-14, before building: 5,048 of the 5,170 open jobs.ge vacancies have no hr.ge twin, and every listing on both boards has its description. So the guess is learnt from hr.ge's 11,640 labelled listings (title, employer and description, its 40 top-level fields), not from a hand-written keyword list. It is checked against the jobs.ge vacancies that do have an hr.ge twin, which give jobs.ge's own text with hr.ge's field. It is stored as a `keyword` classification and given only above a threshold chosen on that check.

**Built 2026-11-14** on `phase-16d-field-guess`:
- ✅ **The model.** `src/taxonomy/field-guess.ts`, pure: a multinomial naive Bayes over the title's words (weight 3), the employer (2) and the first 200 words of the description (0.3), with the shared Georgian stemmer. A vacancy hr.ge files under several fields counts toward each in part. `FIELD_GUESS_VERSION` is written with every guess.
- ✅ **Checked on the local corpus** (read-only), before choosing anything: on the 758 jobs.ge vacancies with an hr.ge twin, each twin held out of training, the top guess is hr.ge's field 86% of the time; at a 0.8 floor 95% get one and 89% of those are right. A time split on hr.ge (newest fifth, trained on the rest): 87%, and 88% at 0.8. A sweep of 96 weightings stayed within about a point of the defaults, so the defaults stand (no tuning to one sample).
- ✅ **The step.** `src/taxonomy/guess-fields.ts`, the third call in the taxonomy backfill every pipeline runs, under its lock: trains on hr.ge's current revisions, guesses jobs.ge's current revisions that have none under this model, writes a `keyword` classification on the `profession` axis only at 0.8 or above, retires guesses from an older model, never guesses over a `human_review` field, skips quarantined listings, and trains nothing from fewer than 500 examples. On the local corpus: 6 s for the whole taxonomy step; 11,590 trained on, 16,376 of 17,484 jobs.ge revisions guessed, 1,108 below the floor; the second run writes nothing.
- ✅ **Read by Browse.** Migration `0055_guessed_field` adds `guessed_field` to `public_opportunity_members` (the view is rebuilt, so the deploy re-applies the public role's grant: `apply-db-roles.sh grants`); the local index reads the same through `listing_classifications`. A job takes a guess only when no member states a field, as `fieldGuessed`. The Field filter matches it, and the row shows the field with a dashed "guessed" tag (kept whole when the name is cut) and a tooltip saying so; "All filters" says "hr.ge; guessed for jobs.ge".
- ✅ Tests: the model (14), the step on a throwaway database (5), the index's assembly and both loaders (2 new). 2,880 pass.
- ✅ Browser, the local surface on the real local corpus: 1280 and 390, light and dark. Field "Sales" shows 5,888 vacancies with 1,280 left out for stating none; the Field popover counts include the guesses; 40 tags on a page, none cut or off-screen; no horizontal overflow; the tag's text 6.8:1 on the dark background; no console error.
- Found on the way, not 16D's: the local `scraplify` database stopped at migration 0042. Fixed with 16E (below).

## 16E: a city for jobs.ge vacancies, read from the text

Added 2026-11-14 on the owner's go. jobs.ge states no city, so its vacancies never matched the City filter. Most of them do name one in their text ("ოფისი თბილისში"), so this reads it rather than guesses.

**Built 2026-11-14** on `phase-16e-city-read`:
- ✅ **The reader.** `src/taxonomy/city-read.ts`, pure: hr.ge's own place names (74, of which 71 can be named in a sentence: not abroad, nationwide or Tbilisi's outskirts), in any Georgian case through the shared stemmer, plus their Latin spellings; from the title and description, in the order named. A name followed by a word for a street, avenue or university is skipped (Tbilisi has a Kutaisi Street; Tbilisi State University is where someone studied). A text naming more than three places reads as none, since a list of every branch says little about one vacancy.
- ✅ **Checked on the local corpus** (read-only), against the 759 jobs.ge vacancies with an hr.ge twin and that twin's stated cities: a city is read for 74% of them; 95% of the cities read are hr.ge's, 99% get at least one right and 94% the exact set; 7 are wholly wrong, several of them hr.ge's default of Tbilisi for work elsewhere. A cap of one city is a little more exact (98.7%) but reads 225 fewer vacancies; five adds almost nothing. Three stands.
- ✅ **The step.** `src/taxonomy/read-cities.ts`, the fourth call in the taxonomy backfill, under its lock: a `location` term per hr.ge place, made the first time it is needed; a `keyword` classification on the `location` axis per place, with its order; read once per `CITY_READ_VERSION`; never over a person's own; quarantined listings skipped. On the local corpus: 11,438 of 17,484 jobs.ge revisions read (12,448 readings), 3,345 of the 5,170 open vacancies; the second run writes nothing.
- ✅ **Read by Browse.** Migration `0056_read_cities` adds `read_cities` (in order) to `public_opportunity_members` (the view is rebuilt again, so the deploy re-applies the grants once after both migrations); the local index reads the same. A job takes them only when no member states a city, as `citiesRead`; the City filter matches them, and the row shows them with a dashed "from text" tag and a tooltip. "All filters" says "hr.ge; read from the text for jobs.ge".
- ✅ Tests: the reader (12), the step on a throwaway database (4), the index's assembly and both loaders (2 new). 2,898 pass.
- ✅ Browser, the local surface on the real local corpus, 1280 and 390, light and dark: City "Batumi" shows 2,371 with both tags side by side on a jobs.ge row and none on an hr.ge row; 51 tags on a page, none cut or off-screen; no horizontal overflow; no console error.
- Also on the way: the local `scraplify` database is migrated through 0056. The 0043–0054 backlog failed as one transaction (0044 adds an enum value a later migration uses, which Postgres refuses in the same transaction), so it was applied one migration at a time, as production had been.

## Deploy of 16D and 16E, 2026-11-15

- ✅ Deployed 07:00 to 07:02 UTC with `.git/handoff-16d/deploy-16de.sh` (machine-local), once ss.ge's run `8044ab2c` had ended (`completed`, 03:39 Tbilisi, its 16-hour limit). Backup copied off the host first; migrations 0055 and 0056; grants re-applied (the public role reads `public_opportunity_members` and still no table); both sites ready; health check all ok.
- ✅ The taxonomy step run by hand on the host straight after: 26 s; trained on 9,745 hr.ge vacancies (the host's corpus is younger than the PC's); 16,246 fields guessed (1,095 below the floor) and 11,322 listings read for a city, 69 places known. Of the 5,169 open jobs.ge vacancies, **4,828 have a guessed field and 3,342 a read city**.
- ✅ The old releases pruned (owed since 16A): five removed, the live one and the two before it kept; the disk at 41%.
- ✅ `npm run probe -- https://jobster.fun`: ok. On jobster.fun at 390 and 1280, light and dark: City "Batumi" 594 open vacancies (jobs.ge rows tagged "from text"); Field "Sales" 1,584, with 326 left out for stating none; 68 tags, none cut or off-screen; no horizontal overflow; no console error. First byte: Browse 0.1 to 0.2 s.
