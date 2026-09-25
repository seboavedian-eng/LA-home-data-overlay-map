# CLAUDE.md

Personal LA County house-hunting tool. One user, runs locally, no backend.
`blockgroups.html` is the whole app; `index.html` is an older, simpler page.

Read `docs/` before proposing anything big — `PRD.md` (what's built, what's
blocked), `DATA-FLOW.md` (every source), `DECISIONS.md` (why things are the way
they are), `USER-GUIDE.md`.

## Run it

```
python -m http.server 8000          # then open /blockgroups.html
python scripts/listing-server.py    # same, plus the paste-a-listing endpoint
```

Never open the HTML directly — `file://` blocks the local data reads.

## Test it

Always run both browser suites before saying something works.

```
node tests/blockgroups-e2e.js     # ~368 checks, real Chromium
node tests/mock-e2e.js            # ~24 checks
python3 tests/test_fetch_urls.py
python3 tests/test_parcel_data.py
python3 tests/test_wind_grid.py
python3 tests/test_data_coverage.py
python3 tests/test_compaction.py
python3 tests/test_listing_server.py
python3 tests/test_school_data.py
python3 tests/test_webmap_convert.py
```

Tests stub every network call, so green means the code is right — not that a
publisher is up.

## Data files are gitignored, on purpose

`js/data/*.json` and `raw-data/` are built on the user's machine. Do not commit
them: a stale or synthetic file silently overwriting a real one has already
happened once here.

| Script | Builds | Needs |
|---|---|---|
| `fetch-blockgroup-data.py` | `bg-la-county.json` (23 ACS tables) | Census key |
| `fetch-parcel-data.py` | `parcels-*.json`, `parcel-sales-*.json` | Assessor roll CSV (~3 GB) |
| `fetch-school-data.py` | `schools-la-county.json` (ratings) | nothing, self-downloads |
| `fetch-wind-data.py` | `wind-*.json` | a GeoTIFF |
| `convert-arcgis-webmap.py` | `school-zones-local.json` | a saved webmap JSON |

`CENSUS_SCHEMA` in `js/blockgroups.js` is currently **9**. Bump it whenever the
fetch script's output shape changes — the app tells the user their file is
stale by comparing against it.

## Conventions that are load-bearing

- **Every card row cites its source.** `cardRow()` refuses a row with no tip,
  and `test_data_coverage.py` fails if a fetched field never reaches a card.
- **Never hardcode a service URL or a field name.** Both go in candidate lists
  in `BG_CONFIG`; the app tries each and logs which answered. Publishers rename
  and move things constantly.
- **The status log is the diagnostic surface.** Anything that fails says which
  URL and which error, and keeps the rest of the page working.
- **No CDNs.** Leaflet, MapLibre and Turf are vendored in `vendor/`.
- **Degrade, never crash.** One dead source must not take down the page.

## Gotchas that cost real time

- **Draw order is paint order on ONE canvas.** `restack()` re-sorts it after
  every redraw: area fills < school zones < boundaries < block groups <
  school dots < parcels < selected lot. Never give a vector layer its own
  pane to get it on top (see the next point); give it `interactive: false`
  if it must sit above the block groups without stealing their clicks.

- **`preferCanvas` + a vector layer with its own pane** creates a *second*
  canvas covering the whole map that hit-tests only its own layers and swallows
  every other click. Listing pins are DOM markers (`L.marker` + `divIcon`) for
  this reason. 218 tests once passed while the map was completely unusable.
- **Tests must use real mouse clicks** where hit-testing matters.
  `layer.fire("click")` bypasses the DOM and hides exactly that class of bug.
- **ArcGIS reports errors with HTTP 200** and an `{error:{...}}` body. Check
  the body, not the status.
- **A successful Census response can be entirely null.** Tract-only tables are
  accepted at block-group level and answered with nulls, so success is
  "returned values", not "returned 200".
- **Python: binding a name anywhere in a function makes it local everywhere in
  that function.** A local `total` shadowed a module-level `total()` helper and
  killed a run after a ten-minute download. `test_compaction.py` has a static
  check for this.
- **localStorage is per-origin including the port.** Switching 8000 → 8001
  hides the user's favourites and notes.
- **Assessed value ≠ sale price**, except just after a sale (Prop 13 resets the
  base year). That reset is what makes the price estimate possible; see
  `fetch-parcel-data.py`'s header.

## Don't do these

- Don't scrape GreatSchools — no free API, terms forbid it. The user's own
  table in `raw-data/school-ratings/` is the ONLY ratings source; nothing is
  computed. Match rows by address + zip, never by name alone (names collide).
- Don't hand-digitise attendance boundaries from written descriptions. One slip
  puts a house in the wrong school zone.
- Don't commit `.env` (the API key) or anything in `js/data/` or `raw-data/`.
- Don't claim a live layer works from a test run — the sandbox can't reach the
  GIS hosts, so only the user can confirm.

## Open items waiting on the user

1. Status-log lines after clicking a house (jurisdiction / zoning / historic /
   parcel) and after ticking Zoning, Historic districts and Parcel outlines —
   none of these endpoints, Glendale's included, has been verified against a
   real browser. The log names the field each service was read from.
2. Glendale zoning Table 30.11-B — every route to ecode360 is egress-blocked.
3. Checking `gusd.net/8439_3` against the Glendale zones to date them.

Next build items, in value order: sewer distance + county easement layers (need
nothing), zone rules (blocked on #2), shortlist export.
