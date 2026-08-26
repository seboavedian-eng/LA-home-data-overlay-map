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
  URL works fine from curl/Postman/a server. `Utils.fetchJSONWithCorsFallback()`
  catches that and retries through a public CORS proxy
  (`CONFIG.CORS_PROXIES` in `js/config.js`) that fetches the URL
  server-side and re-serves it with permissive headers. This is the one
  piece of the app with a third-party runtime dependency beyond the
  primary data sources - fine for public aggregate statistics, but worth
  knowing about. If it ever becomes unreliable, the real fix is running
  this one call through your own tiny proxy instead.
- **School district boundaries moved to CDE's own ArcGIS Online org**
  (`services3.arcgis.com/.../DistrictAreas2425`, same org as the schools
  layer) after the state's `services.gis.ca.gov/.../CA_School_Districts`
  MapServer came back `500 Service ... not found` in real-browser testing
  - it's evidently been retired or restructured since it was indexed by
  search engines. The CDE org's `SchoolSites2425` was already confirmed
  working, so its `DistrictAreas2425` sibling was the safer bet.
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
That test (22 checks) covers:

- All 7 layers toggle on/off and load without a logged error.
- The Demographics popup for a ZIP shows the right population and a
  correctly-sorted, correctly-percented ethnicity breakdown.
- The Income popup shows the right median household income.
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
