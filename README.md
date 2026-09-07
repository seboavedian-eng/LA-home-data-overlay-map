# LA County Home Data Overlay Map

Two pages live here:

- **`blockgroups.html` - Block Group Explorer.** Toggle ZIP / census tract /
  block group boundaries independently; with block groups on, click one for
  population, age bands, sex split, ethnicity, education and income. See
  "Block Group Explorer" below - it needs a one-time data fetch before the
  popups have numbers.
- **`index.html` - the full overlay map.** ZIP demographics, income levels,
  ZIP and city boundaries, public schools and district service areas, and
  CAL FIRE fire hazard severity zones, plus an address search that pulls all
  of it into one summary table.

Everything is plain HTML/CSS/JS (Leaflet + turf.js, vendored locally in
`vendor/`) - no build tool, no server, no API keys required to get it
running.

## Running it

1. **Recommended, one time:** `bash scripts/fetch-census-data.sh` - pulls the
   Census demographics/income data this app needs and saves it locally, so
   Demographics/Income load from a local file instead of depending on a
   flaky public CORS proxy at runtime (see "Known limitations"). Needs your
   own internet access; a few seconds.
2. Because the app makes cross-origin `fetch()` calls, open it through a
   local web server rather than double-clicking the file:

```
cd LA-home-data-overlay-map
python3 -m http.server 8000
# then open http://localhost:8000/
```

Any static file server works (`npx serve`, VS Code Live Server, GitHub
Pages, etc.) - there's nothing to build. Step 1 is optional - skip it and
the app still tries live, just less reliably (see below).

## Block Group Explorer (`blockgroups.html`)

A deliberately small page: a map, three boundary toggles, and a click popup.

> **You must serve this over HTTP - double-clicking the .html file will not
> work.** On a `file://` origin, browsers block the page from reading local
> files, so the demographics data can never load. Confusingly, the map and
> all three boundary layers still work (those are `https://` requests), so
> only the popup numbers fail. The page detects this and shows a banner.

**Step 0 - get a Census API key.** The Census Bureau rejects keyless
requests to `api.census.gov`, so this is mandatory, not an optimization.
Keys are free and issued immediately from
https://api.census.gov/data/key_signup.html. Save it on one line in
`census-api-key.txt` in the project root and the script picks it up
automatically (that filename is gitignored, so the key won't get committed).

**Step 1 - fetch the data** (once; needed before popups show any numbers):

```
# Windows
python scripts\fetch-blockgroup-data.py

# macOS / Linux
python3 scripts/fetch-blockgroup-data.py
```

If you'd rather not save the key to a file, pass it per run with
`--key YOUR_KEY`, or set a `CENSUS_API_KEY` environment variable.

**Step 2 - serve the folder and open it through localhost.** On Windows,
double-click **`start-map.bat`** and skip the rest of this step - it starts
the server and opens the page for you. Otherwise:

```
# Windows
python -m http.server 8000

# macOS / Linux
python3 -m http.server 8000
```

Then open **http://localhost:8000/blockgroups.html** (not the file path).

Step 1 is one-time - the data file stays on disk. Day to day you only need
step 2, and the server has to stay running the whole time you're using the
map (it's a web server, not an installer).

Step 1 pulls block-group-level data for LA County into
`js/data/bg-la-county.json` - ACS `B01001`, `B03002`, `B15003`, `B19013`,
`B19001`, `B19301`, plus `P2` from the 2020 Census. It has to run from your
machine rather than from the page, because api.census.gov sends no CORS
headers (see "Known limitations"). The boundary toggles work without it;
only the popup numbers depend on it. Add `--year 2023` to change vintage, or
`--key YOUR_KEY` for a Census API key.

The script prints exactly what it found, per table - which geography level
each one came back at, and whether anything had to fall back to tract. If a
table you expect isn't available at block group, that output is the
authoritative answer.

**What it shows on click:** census tract and block group number, total
population, age split (0-24 / 25-54 / 55+), sex split, ethnicity breakdown,
share with a bachelor's degree or higher, median household income and
per-capita income.

**Ethnicity has two selectable sources** (radio buttons in the sidebar):

| | B03002 (default) | P2 |
|---|---|---|
| Source | ACS 5-year estimate | 2020 Census redistricting file |
| Nature | Survey sample, modeled | Actual 100% count |
| Currency | Rolling 5-year window | Fixed at April 2020 |

Neither is strictly better - B03002 is more current, P2 is more precise -
so the toggle lets you compare. Everything else on the page stays put when
you switch.

**Why B-tables and not the Subject tables you might expect.** ACS Subject
Tables (`S0101` age/sex, `S1501` education) and Data Profiles are derived
products that the Census Bureau does **not** publish at block group - only
Detailed (B) tables go that deep. So:

- `S0101` → **B01001** (Sex by Age). Complete replacement.
- `S1501` → **B15003** (Educational Attainment, 25+). Gives "bachelor's or
  higher," but **not broken out by age bracket** - that cross-tab is B15001,
  which the fetch script probes for and reports on, since it's unlikely to be
  published at block group either.

**Age bands are 0-24 / 25-54 / 55+, not 0-25 / 25-55.** B01001's own
brackets break exactly at 25 and 55, so these are the natural boundaries and
nothing is double-counted.

**Anything that isn't available at block group is labeled.** The fetch script
probes each table, falls back to tract level only where it must, records
which geography each table came from, and the UI marks those numbers
"tract-level" rather than passing them off as block group data.

**Performance note:** LA County has ~2,500 tracts and ~6,500 block groups, so
those two layers load only for the visible map area, and only above a minimum
zoom (11 for tracts, 12 for block groups). Panning refetches on a short
debounce. ZIP boundaries are only ~300 features county-wide, so they load in
one go.

**Geography availability, for reference:** ACS data is never published at the
Census *block* level - it's a sample survey, and block-level detail would be
neither statistically reliable nor disclosure-safe. Block group is the
smallest ACS geography, and is 5-year-estimates only. (Ancestry also isn't a
decennial Census question, so block-level ancestry doesn't exist from any
source.)

## What each layer is, and where the data comes from (`index.html`)

| Layer | Source | Notes |
|---|---|---|
| Zip Code Borders | US Census TIGERweb, 2020 ZCTAs (`tigerweb.geo.census.gov`) | ZCTAs, not USPS ZIP boundaries - this is what Census demographic/income data is actually published against, so it lines up exactly with the Demographics/Income layers. |
| City Borders | LA County Dept. of Public Works GIS (`dpw.gis.lacounty.gov`) | Legal incorporated-city boundaries. |
| Demographics | US Census ACS 5-year estimates, table B03002 (race/Hispanic-or-Latino origin), `api.census.gov` | Click a ZIP for the full ethnicity breakdown + population. |
| Income Levels | US Census ACS 5-year estimates, tables B19013/B19301/B17001, `api.census.gov` | Median household income, per-capita income, poverty rate. |
| Fire Hazard Zones | CAL FIRE Fire Hazard Severity Zones, State + Local Responsibility Area (`services.gis.ca.gov`) | Moderate / High / Very High. |
| Schools | CA Dept. of Education, official School Sites 2024-25 layer (`services3.arcgis.com`) | Point locations, level, district, address. |
| School District Boundaries | CA Dept. of Education, official District Areas 2024-25 layer (`services3.arcgis.com`) | Elementary/high/unified district service areas - see caveat below. |
| Address search | US Census Bureau Geocoder (`geocoding.geo.census.gov`) | Free, no key, US addresses. Drives the summary table via spatial joins against every layer above. |

All ACS figures are 2022 5-year estimates (`js/config.js` -> `ACS_YEAR`),
the most recent vintage at time of writing. Bump that constant when a newer
release comes out.

### Known limitations (please read)

- **No GreatSchools ratings.** GreatSchools.com does not offer a free
  self-serve API - real access requires an approved partner agreement. Since
  I can't fabricate a rating, every school links out to a Google search for
  "`<school name> greatschools rating`" instead. If you do get GreatSchools
  API access, it's a single new layer module to add.
- **School "zones" = district boundaries, not attendance boundaries.**
  California doesn't publish a single statewide API for parcel-level school
  attendance boundaries (the exact streets zoned to one specific
  elementary school). What's shown is district-level service areas
  (e.g. "LA Unified"), which is the finest grain available as one public,
  county-wide data source. Getting true per-school attendance boundaries
  would mean pulling each district's own GIS data individually (LAUSD alone
  has one) - doable as a follow-up if you want a specific district.
- **Field names are read defensively.** Government ArcGIS services
  occasionally rename fields between releases. `Utils.pickField()` matches
  by substring against a list of likely candidates rather than one hard-coded
  exact name, so a minor schema drift degrades gracefully (a blank field)
  instead of breaking the layer.
- **ArcGIS queries request `f=json`, not `f=geojson`, and convert client-side.**
  The `f=geojson` convenience format is opt-in per ArcGIS Server instance,
  and a few of the government services here (Census TIGERweb, LA County
  DPW) never had it turned on - requesting it anyway returns an error,
  which is what made the Zip/City/Demographics/Income layers fail outright
  in the first hand-off. Native Esri JSON (`f=json`) is supported
  everywhere, so `js/utils.js` now converts it to GeoJSON itself, including
  correctly nesting holes inside multi-ring polygons - the older
  server-side geojson converters some of these services do have are known
  to mishandle that case, which was contributing to the messy look on the
  Fire Hazard layer (the other contributor was drawing a border on every
  one of the thousands of adjacent hazard polygons - that layer is now
  rendered borderless, fill only).
- **`api.census.gov` doesn't send CORS headers**, so a direct browser
  `fetch()` to it fails outright ("Failed to fetch") even though the same
  URL works fine from curl/Postman/a server - no amount of client-side code
  can fix that, it's a gap in that specific API. The original fix attempt
  was a public CORS proxy fallback; in real-browser testing, *both*
  configured proxies turned out to be unreliable too (one blocked outright,
  the other returning `403`) - proxies like these are commonly blocked by
  ad blockers, privacy extensions, or the proxy's own rate limiting, so
  this isn't specific to one setup. The real fix is
  `scripts/fetch-census-data.sh` (see "Running it"): a one-time local
  snapshot that Demographics/Income load from directly, same-origin, no
  CORS involved at all. The proxy fallback in `Utils.fetchJSONWithCorsFallback()`
  still exists as a last resort if you skip that script, but don't rely on it.
- **School district boundaries: exact live service name unconfirmed.** The
  state's own `services.gis.ca.gov/.../CA_School_Districts` MapServer came
  back `500 Service ... not found` in real-browser testing - it's evidently
  been retired or restructured since it was indexed by search engines. My
  next guess, CDE's own ArcGIS Online org's `DistrictAreas2425` (same org as
  the already-confirmed-working `SchoolSites2425` schools layer), turned out
  not to exist either (`400 Invalid URL`). `getDistrictsGeoJSON()` in
  `js/datastore.js` now tries a short list of plausible names in order
  (`DistrictAreas2425Locale`, `DistrictAreas2425`, `DistrictAreas2324`,
  `DistrictAreas2122` - see `CONFIG.DISTRICTS_SERVER_CANDIDATES`) and uses
  whichever one actually responds. If none do, the status log will say so
  by name.
- **Fire Hazard Zones: still being tracked down.** The data source is
  confirmed correct - it's the same official CAL FIRE Fire Hazard Severity
  Zone dataset (`services.gis.ca.gov/.../Fire_Severity_Zones`) that CAL
  FIRE's own public viewer app uses. Two contributing rendering bugs are
  fixed (server-side geojson conversion mangling multi-ring/hole polygons;
  a border drawn on every one of the thousands of adjacent polygons), and a
  diagnostic now logs whether the live hazard-class field name is actually
  being matched (`js/datastore.js` -> `getFireHazardGeoJSON`). If it still
  looks off after those fixes, the status log line for "fire" plus a
  screenshot is what's needed to pin down what's left - I can't view this
  layer myself from where this was built (see the network-sandbox note
  below).
- **This was built and tested from a network-sandboxed environment.** The
  coding sandbox this was built in only allows outbound access to a small
  allowlist (package registries, Anthropic's own APIs) - every GIS/Census
  host above returned `EGRESS_BLOCKED` when called directly from that
  container, both via `curl` and via the fetch tool. That's an environment
  policy, not a defect in the endpoints. **The page itself runs entirely in
  your own browser**, which has normal internet access, so this doesn't
  affect you day-to-day - it only affected how this was verified. See
  "How this was tested" below for what that verification actually covered.

## How this was tested

Every endpoint URL and field/table schema above was confirmed via
documentation search rather than a live call (see the limitation above). To
still verify the actual application logic - the ArcGIS layer-id discovery,
the Census bulk-query join, the point-in-polygon spatial joins, the
choropleths, the popups, and the address-search summary table - it was run
through a headless-browser (Playwright) test that intercepts each external
request and returns a fixture response shaped exactly like the real API
(native Esri JSON with correctly-wound rings, real LA County coordinates).
That test (24 checks) covers:

- All 7 layers toggle on/off and load without a logged error.
- The Demographics popup for a ZIP shows the right population and a
  correctly-sorted, correctly-percented ethnicity breakdown.
- The Income popup shows the right median household income.
- The districts fetch's first candidate URL is made to fail exactly like
  the real dead URL did, and the test confirms it falls through to the next
  candidate rather than just failing outright.
- A local Census snapshot file is dropped in, api.census.gov is blocked
  entirely, and the test confirms Demographics loads from the local file
  with zero network call to Census or any proxy.
- A fire-hazard polygon built with a real hole in it is converted so that a
  point inside the hole is correctly excluded and a point elsewhere in the
  same polygon is correctly included - this is the specific multi-ring bug
  class that caused the Fire Hazard layer's stray-line rendering.
- The Census ACS call is deliberately made to fail exactly like its
  real-world CORS block does, and the test confirms the CORS-proxy fallback
  actually engages and Demographics/Income still load.
- Searching an address returns the right ZIP, city, population, income,
  fire hazard zone, and a schools list correctly sorted nearest-first, each
  with a distinct per-school GreatSchools search link (not one shared URL).
- No uncaught JS errors anywhere in the flow.

The test lives in `tests/` (`fixtures.js` + `mock-e2e.js`) and isn't part of
the app itself. To re-run it:

```
cd tests
npm install
npx playwright install chromium   # first time only
npm test
```

What that test **can't** confirm is that the live services still return data
in the exact shape my fixtures assume (a government service could rename a
field, or a URL could move). **First real use, please do one pass with your
own eyes**: load the page, toggle each layer, and run one address search,
and let me know if anything comes back empty - most likely fix is a one-line
field-name or layer-id tweak in `js/config.js` or `js/datastore.js`.

## Project layout

```
blockgroups.html      Block Group Explorer page (see above)
js/blockgroups.js      ...its map, toggles, viewport loading and popup
css/blockgroups.css    ...its styles
scripts/fetch-blockgroup-data.py   One-time block-group ACS fetch

index.html
css/style.css
js/config.js         All external endpoint URLs, Census variable codes, LA County bbox
js/utils.js           fetch wrapper, ArcGIS layer-id discovery, formatting helpers
js/datastore.js        Cached fetches shared across layers (one Census call, one ZCTA call, etc.)
js/map.js             Map init + the sidebar layer-toggle registry
js/layers/*.js         One file per toggleable layer
js/geocode.js          Census geocoder wrapper
js/summary.js          Address-search spatial joins + summary table rendering
js/main.js             Bootstraps everything
js/data/                Local ACS snapshot lives here once you run the fetch script (see below)
vendor/leaflet/         Leaflet 1.9.4, vendored (no CDN dependency)
vendor/turf/            turf.js 6.5.0, vendored (no CDN dependency)
scripts/fetch-census-data.sh   One-time local Census data snapshot (see "Running it")
```

## Optional: raise the Census API rate limit

The Census API works anonymously at low volume. For heavier use, get a free
key at https://api.census.gov/data/key_signup.html and paste it into
`CONFIG.CENSUS_API_KEY` in `js/config.js`.
