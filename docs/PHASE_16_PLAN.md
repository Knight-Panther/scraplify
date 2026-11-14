# Phase 16 plan: the site redesign (filters, Browse, dark and light)

Three designs the owner approved as HTML mockups on 2026-11-14, to be built into the site. Kept as a tracker once building starts.

- **Status: 16A built** on branch `phase-16a-theme` (2026-11-14), its gate checked in a browser; 16B and 16C not started.
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
| ⏳ | **16A** | Theme foundation: one set of colours for every screen, dark and light, the header switch, the choice in a cookie | yes | its PR's CI, then a web-only deploy |
| ❌ | **16B** | Real estate filters v2 | yes | 16A |
| ❌ | **16C** | Browse v2 | yes | 16A |
| ❌ | **16D** | (Optional) a field for jobs.ge vacancies, guessed from the title and labelled as a guess | later | the owner's go |

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
- ✅ `web-design-guidelines` review clean (one fix: the phone menu contains its scroll). Surface-boundary review: no defect. Tests: 2,735 pass locally; ❌ CI on the PR.

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

## 16D (optional): a field for jobs.ge vacancies

jobs.ge states no field. A keyword classifier on the title could give one, using the taxonomy step's `keyword` method. It would be shown as "field guessed from the title". The owner hasn't asked for it, so it waits on the owner's go.
