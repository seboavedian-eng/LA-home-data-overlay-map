# Ratings snapshot and app-review verification (live pages, 2026-11-03)

## How the pages were checked

### Takeaway
I fetched each page with plain `curl` on **2026-11-03**. App Store, Google Play and Capterra product pages all loaded (HTTP 200). Apple's `itunes.apple.com` lookup and RSS endpoints were refused by the session proxy (`CONNECT tunnel failed, response 403`), so I have no RSS "most recent" feed. App Store review excerpts are the **featured reviews embedded in each app page**, not a most-recent sort.

### Cited Findings
- App Store values come from the page's embedded `"ratingValue"/"reviewCount"` JSON. The update date is the newest entry under "Version History". All are US listings, e.g. [Zillow App Store](https://apps.apple.com/us/app/id310738695).
- Google Play values come from the page's star badge, the "N reviews" label and "Updated on" (`hl=en_US`), e.g. [Zillow Play](https://play.google.com/store/apps/details?id=com.zillow.android.zillowmap&hl=en_US).
- Capterra values come from the JSON-LD `aggregateRating` on `/p/<id>/<name>/reviews/`, e.g. [DealCheck Capterra](https://www.capterra.com/p/205089/DealCheck/reviews/).
- Three requests failed: `itunes.apple.com/lookup` and the RSS feed (proxy 403), Apple's `apps.apple.com/us/search` (404), and Capterra `/p/170456/DealCheck/reviews/` (404, wrong ID; the report's 205089 is correct).

### Inferences
- The excerpts are skewed toward whatever Apple and Google choose to feature. Many featured App Store reviews date from 2018–2023, so the 2025–26 excerpts below are the dated ones that happened to be shown, not a systematic sample.

### Gaps
- No App Store most-recent feed, because the RSS endpoint was blocked.

## Ratings by player: live values vs. the report's "Ratings snapshot"

### Takeaway
The big-portal numbers mostly **Confirm**. There are four **Corrections**: Redfin App Store count (1.65M, not 156K), Regrid App Store count (8,913), BiggerPockets Play (2.9★ exists, report said n/f) and ComeHome (the report's App Store listing could not be matched). Several values the report marked n/f now exist: DealCheck App Store, PropStream and PropertyRadar on both stores, Zillow, Redfin and BiggerPockets on Play, and Redfin and RentCast on Capterra. Mashvisor, AirDNA, RentCast, NeighborhoodScout and First Street have no findable US consumer app.

### Cited Findings
Values were seen 2026-11-03. "Report" is the report's value. Status: C = Confirmed, X = Corrected (or filled in where the report had n/f), NF = Not found.

| Player | App Store (rating, count, last update) | Google Play (rating, reviews, last update) | Capterra (rating, reviews) |
|---|---|---|---|
| Zillow | 4.8, 7,240,854, 2026-11-03 — **C** (report 4.8 ~7.2M) [AS](https://apps.apple.com/us/app/id310738695) | 4.8, 1.68M, Nov 2, 2026, 50M+ downloads — **X** (report n/f) [Play](https://play.google.com/store/apps/details?id=com.zillow.android.zillowmap&hl=en_US) | no consumer listing searched; Capterra search shows only "Zillow Rental Manager" / "Zillow 3D Home" — **NF** [search](https://www.capterra.com/search/?query=zillow) |
| Redfin | 4.8, **1,650,568**, 2026-10-29 — **X** (report "156K unverified") [AS](https://apps.apple.com/us/app/id327962480) | 4.7, 175K, Oct 28, 2026 — **X** (report n/f) [Play](https://play.google.com/store/apps/details?id=com.redfin.android&hl=en_US) | **4.6 (22)** — **X** (report "page exists, n/f") [Capterra](https://www.capterra.com/p/210572/Redfin/reviews/) |
| Realtor.com | 4.8, 1,087,443, 2026-10-30 — **C** (~1.1M) [AS](https://apps.apple.com/us/app/id336698281) | 4.7, 570K, Oct 30, 2026 — **C** (~569K) [Play](https://play.google.com/store/apps/details?id=com.move.realtor&hl=en_US) | **NF** (no product on Capterra search) [search](https://www.capterra.com/search/?query=realtor.com) |
| DealCheck | **4.8, 1,748**, 2026-09-26 — **X** (report n/f) [AS](https://apps.apple.com/us/app/id1001869134) | 4.7, 1.19K, Sep 26, 2026 — **C** [Play](https://play.google.com/store/apps/details?id=com.fortnofffinancial.dealcheck_rentals&hl=en_US) | 4.8 (39) — **C** [Capterra](https://www.capterra.com/p/205089/DealCheck/reviews/) |
| Mashvisor | **NF** (web/App Store search found no Mashvisor app) | **NF** (Play search "mashvisor real estate" returns no Mashvisor app) [Play search](https://play.google.com/store/search?q=mashvisor%20real%20estate&c=apps&hl=en_US) | **NF** [search](https://www.capterra.com/search/?query=mashvisor) |
| BiggerPockets | 4.7, 1,398, 2026-10-27 — **C** (~1.4K) [AS](https://apps.apple.com/us/app/id6736392302) | **2.9, 633**, Oct 27, 2026, 100K+ — **X** (report n/f) [Play](https://play.google.com/store/apps/details?id=com.biggerpockets.bp_android&hl=en_US) | **NF** [search](https://www.capterra.com/search/?query=biggerpockets) |
| Rentometer | listing exists (id6756412739), **no rating shown**, 2026-08-13 — **NF** for rating [AS](https://apps.apple.com/us/app/id6756412739) | 3.2, 9, Aug 12, 2026, 1K+ — **C** [Play](https://play.google.com/store/apps/details?id=com.rentometer.rentestimates&hl=en_US) | **NF** [search](https://www.capterra.com/search/?query=rentometer) |
| RentCast | **NF** | **NF** (Play search returns only Zillow/Trulia apps) [Play search](https://play.google.com/store/search?q=rentcast&c=apps&hl=en_US) | **5.0 (1)** — **X** (report n/f) [Capterra](https://www.capterra.com/p/230351/RentCast/reviews/) |
| AirDNA | **NF** | **NF** (Play search returns Airbnb/Vrbo/airlines) [Play search](https://play.google.com/store/search?q=airdna&c=apps&hl=en_US) | 1.3 (3) — **C** [Capterra](https://www.capterra.com/p/10018589/AirDNA/reviews/) |
| PropStream | **3.1, 179**, 2026-10-27 — **X** (report n/f) [AS](https://apps.apple.com/us/app/id1499247691) | **3.5, 158**, Oct 23, 2026, 50K+ — **X** [Play](https://play.google.com/store/apps/details?id=com.propstream&hl=en_US) | live page has no aggregateRating in its markup — **NF**. A search snippet claimed "4.5 from 4,479", which I could not see on the page; don't use it. [Capterra](https://www.capterra.com/p/207196/PropStream/reviews/) |
| PropertyRadar | **4.4, 52**, 2026-10-28 — **X** (report "listing exists, n/f") [AS](https://apps.apple.com/us/app/id730602196) | **3.6, 126**, Oct 23, 2026, 10K+ — **X** [Play](https://play.google.com/store/apps/details?id=com.propertyradar.app&hl=en_US) | no aggregateRating on page — **NF** (a search snippet said "0 user reviews") [Capterra](https://www.capterra.com/p/230568/PropertyRadar/reviews/) |
| HouseCanary / ComeHome | **NF / X**: report's "69 ratings, last update 2022" could not be matched. The only US "comehome!" listing (id1094481965) is an unrelated Italian social-events app (4.9, 12) [AS](https://apps.apple.com/us/app/id1094481965) | **NF**: `com.housecanary.housecanary` returns 404 (listing appears removed; a search engine still indexes it) [Play](https://play.google.com/store/apps/details?id=com.housecanary.housecanary&hl=en_US) | **NF** [search](https://www.capterra.com/search/?query=housecanary) |
| NeighborhoodScout | **NF** (n/a confirmed) | **NF** | **NF** [search](https://www.capterra.com/search/?query=neighborhoodscout) |
| First Street | **NF** | **NF**: Play "First Street" (`com.ask.firststreet`) is by **CBRE Inc.**, not First Street Technology [Play](https://play.google.com/store/apps/details?id=com.ask.firststreet&hl=en_US) | **NF** |
| Regrid | 4.8, **8,913**, 2026-10-13 — **X** (report 7.9K–8.6K) [AS](https://apps.apple.com/us/app/id1338927298) | 4.8, 6.15K, Oct 9, 2026, 500K+ — **C** [Play](https://play.google.com/store/apps/details?id=com.loveland.pr&hl=en_US) | **NF** [search](https://www.capterra.com/search/?query=regrid) |
| Symbium | n/a (web) — **C** | n/a — **C** (Play search shows no Symbium) | **NF** [search](https://www.capterra.com/search/?query=symbium) |

### Inferences
- BiggerPockets is 4.7★ on iOS (new app, Dec 2024) but **2.9★ on Android**. The featured Android reviews are 2019–2020 login and crash complaints about the old app.
- PropStream (3.1/3.5) and PropertyRadar (Play 3.6) score much lower in the stores than on Trustpilot or G2. That points to app quality (driving-for-dollars, navigation) more than data.
- The report's sentence "store pages blocked here" (sources table, and the Limits section saying the App Store and Play "could not be opened") is now outdated.

### Gaps
- Capterra ratings for PropStream and PropertyRadar: the page renders without a machine-readable aggregate and I could not see a count in the text.
- The ComeHome iOS app the report cited (69 ratings) could not be identified, because I had no App ID and Apple search was unavailable.

## Dated review excerpts (2025–2026 where shown) and checks on the report's app-review claims

### Takeaway
Most quoted App Store and Play claims I could see **Confirm**: DealCheck "not actually solds", BiggerPockets "removed keyword notifications", Regrid "all owners" and "Network request failed". Several others were **Not found** on the first page of featured reviews. Recent Play complaints cluster on redesigns that broke saved searches, filters and loading (Zillow, Realtor.com, Redfin). Recent praise is for speed and comparison (DealCheck), property lines (Regrid) and lead-finding (PropertyRadar).

### Cited Findings
**Zillow**
- Complaint, 1★, Jul 29, 2026 (Play): saved searches "are no longer limited to the areas I need to search in, or the commute distance I set from work… pretty much worthless". This is consistent with the report's Unstar "broke the Commute" claim. [Play](https://play.google.com/store/apps/details?id=com.zillow.android.zillowmap&hl=en_US)
- Complaint, 1★, Sep 18, 2026 (Play): "constantly sends you house types that you are not interested in without a way to filter them out… a year and a half… nothing has changed." [Play](https://play.google.com/store/apps/details?id=com.zillow.android.zillowmap&hl=en_US)
- Complaint, 2★, 2025-03-23 (App Store): app re-recommends the same apartments; "no way to report to Zillow that you are being ignored". [AS](https://apps.apple.com/us/app/id310738695)
- Praise: no dated 2025–26 praise among the featured reviews. The featured 5★ reviews are 2018/2021 agent testimonials.

**Redfin**
- Complaint, 3★, May 20, 2026 (Play): "Super glitchy… 0 results on a general search… sort by price, they aren't in order." [Play](https://play.google.com/store/apps/details?id=com.redfin.android&hl=en_US)
- Mixed, 3★, Jul 31, 2026 (Play): "good for a broad selection of choices", but "hide" does not stick and for-sale notifications keep coming. [Play](https://play.google.com/store/apps/details?id=com.redfin.android&hl=en_US)
- Praise, Capterra review headed Mar 16, 2025: "user-friendly and very easy to navigate for specific features/filters". The pairing of date and text is inferred from page order. [Capterra](https://www.capterra.com/p/210572/Redfin/reviews/)
- Report claims "pushy" and "updated more often" (Capterra): **Not found** in the first page of reviews.

**Realtor.com**
- Complaint, 1★, 2025-12-01 (App Store): "Blank map for months… freeze, lag or close altogether." [AS](https://apps.apple.com/us/app/id336698281)
- Complaint, 1★, Sep 13, 2026 (Play): "doesn't load properly… doesn't apply the changes made or uses the save search features." [Play](https://play.google.com/store/apps/details?id=com.move.realtor&hl=en_US)
- Complaint, 1★, Aug 25, 2026 (Play): saved searches default to "relevance"; "so many adds I immediately get bumped to an offsite website". Complaint, 2★, May 15, 2026: "gone from consumer based to commercial based." [Play](https://play.google.com/store/apps/details?id=com.move.realtor&hl=en_US)
- This supports the report's Trustpilot-sourced "buggy" and "maps are bad" claims with store evidence. I found no 2025–26 praise in the featured reviews.

**DealCheck**
- Report claim "returning comps that are not actually solds": **Confirmed**. It sits inside a **5★** review dated 2025-04-11 ("Overall Highly Recommend… worth it to just work around the data issues… customer service is great"). The report presents it as a plain complaint; it is a caveat within praise. [AS](https://apps.apple.com/us/app/id1001869134)
- Praise, 5★, 2025-04-23 (App Store): "I use this app to analyze every single deal… rentals BRRRs… run comps." [AS](https://apps.apple.com/us/app/id1001869134)
- Praise, 5★, Jun 7, 2025 (Play): "Even without precise numbers… invaluable for sorting them by cash flow, price." [Play](https://play.google.com/store/apps/details?id=com.fortnofffinancial.dealcheck_rentals&hl=en_US)
- Complaint, Capterra review headed Mar 24, 2025: "Can't add a total or average sqft for the building… you have to currently add sq ft per unit." This supports the report's "not every line item customisable" claim; the date pairing is inferred. [Capterra](https://www.capterra.com/p/205089/DealCheck/reviews/)
- Report claims "fancy excel spreadsheet Wizard" and "delete a few properties when I hit the limit": **Not found** among the featured reviews. They may sit deeper in the see-all list.

**BiggerPockets**
- Report claim "redesign removed keyword notifications": **Confirmed**, 3★, 2026-10-08: "removed keyword notifications which is how alot of people utilize BP… forces you… each and every time you open the app." [AS](https://apps.apple.com/us/app/id6736392302)
- Praise, 5★, 2026-10-23: "The old app needed a refresh… Now I feel inspired to open it." Praise, 5★, 2025-11-20: "BP changed my life." [AS](https://apps.apple.com/us/app/id6736392302)
- Note: one featured 5★ "review" (2025-01-09, "Please Give Us Feedback!") is written in BiggerPockets' own voice ("Our mobile app is back!"). [AS](https://apps.apple.com/us/app/id6736392302)
- Play excerpts shown are 2019–2020 only (login failures, crashes). [Play](https://play.google.com/store/apps/details?id=com.biggerpockets.bp_android&hl=en_US)

**Rentometer**
- Complaint, 1★, Mar 6, 2026 (Play): "more time logging in… error messages over & over." Praise, 5★, Mar 3, 2026: "Thank you for fixing the layout issue… works PERFECTLY!" Complaint, 1★, Jun 29, 2025 (a tenant): "YOUR ESTIMATE IS RIDICULOUS AND SUPER HIGH! LANDLORD'S ARE RAISING RENT BY WHAT YOU ARE POSTING!" [Play](https://play.google.com/store/apps/details?id=com.rentometer.rentestimates&hl=en_US)

**PropStream**
- Complaint, 1★, Jul 16, 2026 (Play): "you can't cancel your membership online and you have to email or call… In 2026, that is unacceptable." This supports the report's billing pain point. [Play](https://play.google.com/store/apps/details?id=com.propstream&hl=en_US)
- Praise, 5★, Jul 18, 2026 (Play): "newest update looks amazing… modern and clean". The same reviewer adds that the comps "map feature doesn't work… just shows me a random Google maps screen." [Play](https://play.google.com/store/apps/details?id=com.propstream&hl=en_US)
- Complaint, 1★, 2024-03-22 (App Store): driving-for-dollars "Since day ONE I have not been able to effectively use this feature." [AS](https://apps.apple.com/us/app/id1499247691)

**PropertyRadar**
- Praise, 5★, 2025-12-12 (App Store): "my secret weapon in marketing to real estate owners… helped my family become financially free." [AS](https://apps.apple.com/us/app/id730602196)
- Complaint, 3★, Jun 22, 2026 (Play): on Android, opening a list means "I have to close out the entire app just to see the list again." [Play](https://play.google.com/store/apps/details?id=com.propertyradar.app&hl=en_US)
- Complaint, 3★, 2024-11-12 (App Store): can't build a driving route from a whole list; "tutorial videos… so outdated." [AS](https://apps.apple.com/us/app/id730602196)
- Report claim "rates raised mid term" (single App Store review via Real Estate Skills): **Not found** among the featured reviews.

**Regrid**
- Report claim "very comprehensive… all owners when there are multiple owners": **Confirmed**, 5★, 2023-11-07. **Date correction:** the review is from 2023, not undated or recent. [AS](https://apps.apple.com/us/app/id1338927298)
- Report claim "draw a boundary… saves time": **Confirmed** in substance in the same 2023-11-07 review and in a 2024-08-22 review ("boundary-drawing feature is a game-changer"). [AS](https://apps.apple.com/us/app/id1338927298)
- Report claim "Network request failed": **Confirmed**, Play, Jun 13, 2022, inside a 5★ review. **Date correction:** 2022. [Play](https://play.google.com/store/apps/details?id=com.loveland.pr&hl=en_US)
- Report claims "20+ feet off", "homes list old owners" and "rarely obviously wrong": **Not found** among the featured reviews.
- Recent praise, 5★, Feb 15, 2026 (Play): "use it almost daily as a Realtor… the lines are not exact… same lines from GIS… can be off somewhat." Praise, 5★, 2026-01-17 (App Store): construction worker uses it to find the right house. [Play](https://play.google.com/store/apps/details?id=com.loveland.pr&hl=en_US); [AS](https://apps.apple.com/us/app/id1338927298)
- Complaint (older), 3★, 2021-07-25 (App Store): update makes it "useless unless you give them $99 per year to use public information". This supports the report's paywall claim, dated 2021. [AS](https://apps.apple.com/us/app/id1338927298)

### Inferences
- Several report claims carry "date n/f" where the live page gives a date, and two of those are 2022–2023 rather than recent (Regrid). The report's "(date n/f)" tags for these should be updated.
- The 2026 portal complaints on Play match the "redesign broke saved searches/filters" theme from Unstar, so that claim now has first-party support.

### Gaps
- Mashvisor, AirDNA, RentCast, NeighborhoodScout, First Street and Symbium have no store reviews to excerpt, and their Capterra pages have 0–3 reviews with no visible text.
- AirDNA's Capterra report of being "charged again a year after cancelling" was cited to capterra.ca and was not rechecked; the US page shows 1.3 (3) with no text extracted.
- Capterra date-to-text pairing is inferred from page order (the date header precedes reviewer details and the quote), so treat those dates as medium confidence.
