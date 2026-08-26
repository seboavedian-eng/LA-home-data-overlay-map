# LA County Home Data Overlay Map

A single-page, no-build-step map of LA County that overlays public GIS/Census
data: ZIP code demographics, income levels, ZIP and city boundaries, public
schools and district service areas, and CAL FIRE fire hazard severity zones.
Search an address to get all of it pulled into one summary table.

Everything is plain HTML/CSS/JS (Leaflet + turf.js, vendored locally in
`vendor/`) - no build tool, no server, no API keys required to get it
running.

## Running it

Because the app makes cross-origin `fetch()` calls, open it through a local
web server rather than double-clicking the file:

```
cd LA-home-data-overlay-map
python3 -m http.server 8000
# then open http://localhost:8000/
```

Any static file server works (`npx serve`, VS Code Live Server, GitHub
Pages, etc.) - there's nothing to build.

## What each layer is, and where the data comes from

| Layer | Source | Notes |
|---|---|---|
| Zip Code Borders | US Census TIGERweb, 2020 ZCTAs (`tigerweb.geo.census.gov`) | ZCTAs, not USPS ZIP boundaries - this is what Census demographic/income data is actually published against, so it lines up exactly with the Demographics/Income layers. |
| City Borders | LA County Dept. of Public Works GIS (`dpw.gis.lacounty.gov`) | Legal incorporated-city boundaries. |
| Demographics | US Census ACS 5-year estimates, table B03002 (race/Hispanic-or-Latino origin), `api.census.gov` | Click a ZIP for the full ethnicity breakdown + population. |
| Income Levels | US Census ACS 5-year estimates, tables B19013/B19301/B17001, `api.census.gov` | Median household income, per-capita income, poverty rate. |
| Fire Hazard Zones | CAL FIRE Fire Hazard Severity Zones, State + Local Responsibility Area (`services.gis.ca.gov`) | Moderate / High / Very High. |
| Schools | CA Dept. of Education, official School Sites 2024-25 layer (`services3.arcgis.com`) | Point locations, level, district, address. |
| School District Boundaries | CA Dept. of Education school district areas, via CA state GIS (`services.gis.ca.gov`) | Elementary/high/unified district service areas - see caveat below. |
| Address search | US Census Bureau Geocoder (`geocoding.geo.census.gov`) | Free, no key, US addresses. Drives the summary table via spatial joins against every layer above. |

All ACS figures are 2022 5-year estimates (`js/config.js` -> `ACS_YEAR`),
the most recent vintage at time of writing. Bump that constant when a newer
release comes out.

### Known limitations (please read)

- **No GreatSchools ratings.** GreatSchools.com does not offer a free
  self-serve API - real access requires an approved partner agreement. Since
  I can't fabricate a rating, the Schools layer instead links each school
  out to the official [CA School Dashboard](https://www.caschooldashboard.org/),
  which is free, public, and arguably more rigorous (state-vetted
  accountability indicators rather than a third-party score). If you do get
  GreatSchools API access, it's a single new layer module to add.
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
(same JSON structure, same field names, real LA County coordinates). That
test (19 checks) covers:

- All 7 layers toggle on/off and load without a logged error.
- The Demographics popup for a ZIP shows the right population and a
  correctly-sorted, correctly-percented ethnicity breakdown.
- The Income popup shows the right median household income.
- Searching an address returns the right ZIP, city, population, income,
  fire hazard zone, and a schools list correctly sorted nearest-first.
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
vendor/leaflet/         Leaflet 1.9.4, vendored (no CDN dependency)
vendor/turf/            turf.js 6.5.0, vendored (no CDN dependency)
```

## Optional: raise the Census API rate limit

The Census API works anonymously at low volume. For heavier use, get a free
key at https://api.census.gov/data/key_signup.html and paste it into
`CONFIG.CENSUS_API_KEY` in `js/config.js`.
