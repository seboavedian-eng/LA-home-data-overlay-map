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

A deliberately small page: a map, boundary toggles, environment/hazard
toggles, and a click popup.

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
population, average household size, six age bands, sex split, ethnicity
breakdown, share with a bachelor's degree or higher, median household income,
per-capita income and the household income brackets.

Four figures are picked out in bold dark green - ZIP, education, and the two
income numbers - because those are the ones people actually shop on.

Average household size comes from ACS **B25010** (the Census Bureau's own
figure: people living in households divided by occupied units). A data file
fetched before B25010 was added falls back to total population over household
count, labelled `(est.)` - that runs slightly high wherever a block group
holds group quarters such as dorms or care homes, since those residents count
in the population but live in no household. Re-run the fetch script for the
published figure.

Anything with a non-obvious denominator carries an **ⓘ**: hover, focus or tap
it for the explanation. Per-capita income, for instance, divides total income
by *every* resident including children, which is why it always sits well
below the household median.

The card on the map belongs to the map, not to the polygon under it. That
matters because the block group layer is thrown away and rebuilt whenever you
pan far enough to refetch - when the card was bound to a polygon, every one of
those rebuilds closed and reopened it, which is what made it blink out and
back in.

### Environment & hazard layers

Three extra toggles sit under the boundary ones. All three are off by
default, and each has its own legend.

| Layer | Source | Notes |
|---|---|---|
| Fire hazard zones | CAL FIRE / OSFM Fire Hazard Severity Zones, via `services.gis.ca.gov` | Moderate / High / Very High, State **and** Local Responsibility Areas merged. Loads for the visible area at zoom 9+. Blank ground is outside any mapped zone - which is not the same as "no hazard". |
| Pollution burden | CalEnviroScreen 4.0 (OEHHA), hosted ArcGIS feature layer | Census-tract polygons shaded by the CES percentile. Hover for the indicator breakdown (ozone, PM2.5, diesel PM, traffic, drinking water, pesticides, asthma). The score is **relative**: 90 means worse than 90% of California tracts, not an absolute dose. |
| Wind speed | Global Wind Atlas 3 (DTU / World Bank), CC BY 4.0 | Mean wind speed at 250 m resolution. Needs the one-time download step below, because GWA publishes rasters only. |

#### The "Awaiting Zoning" trap

The first thing that made this layer look wrong was not the record cap - it
was a sublayer called **"SRA/LRA Awaiting Zoning"**. That is a placeholder
for ground CAL FIRE has not finished re-zoning, not a hazard class, and its
polygons are enormous. Because the name contains "SRA", a match on
`/sra|lra/` pulled it in, and its features still carry an old class value, so
they were drawn *and labelled* as Very High zones. Those sublayers are now
excluded by name (`FIRE_LAYER_EXCLUDE`), and any feature whose class value
reads "awaiting" or "pending" is dropped as well.

The layer also now prefers **LA County's own Hazards service** over the
statewide one - it carries the county's adopted SRA and LRA zones for exactly
the area this app covers. Layer names are matched with underscores
normalised, so `FIRE_HAZARD_SEVERITY_ZONES_LRA` and "Fire Hazard Severity
Zones in LRA" both match one pattern.

The polygon tooltip now also shows the source sublayer and, when it differs
from the class we assigned, the raw field value - so a mismatch is visible
instead of silent.

#### Why the fire layer used to come back with holes in it

That service caps a query at **1,000 records**, and an LA-sized viewport
holds many times that in hazard polygons. When the cap is hit, ArcGIS
answers HTTP 200 with a perfectly valid *partial* result and a small
`exceededTransferLimit` flag in the body - so the map drew a fraction of the
zones as though that were all of them. Three things now handle it:

- A truncated box is **split into quarters and re-queried**, recursively, up
  to three levels deep - and only the sub-boxes that are themselves
  truncated get split further. Overlapping edges are deduplicated on the
  server's own `OBJECTID`. (Quadrant splitting rather than `resultOffset`
  paging, because every ArcGIS version supports it and older ones do not
  support pagination.)
- **Non-wildland and unzoned polygons are dropped.** The same layer carries
  "Non-Wildland/Non-Urban" and "Urban Unzoned" ground, which covers most of
  flat LA. Drawing those grey blanketed the city in a colour that meant
  nothing.
- ArcGIS reports its own errors with HTTP 200 and an `{error: {...}}` body,
  which used to surface as a generic parse failure. Those are now read and
  reported verbatim, group layers (which cannot be queried at all) are
  skipped, and a server that rejects `maxAllowableOffset` gets one retry
  without it.

The status log now reports, per sublayer, how many polygons arrived, how
many requests it took, whether the box had to be split, whether it is *still*
truncated, and which hazard-class values were actually seen. If the layer
still looks wrong, that log says why.

Fire and pollution are live ArcGIS REST calls with no key and no setup. Each
has a list of candidate service URLs in `BG_CONFIG.OVERLAYS`; the first one
that answers is used, and the status log names it - so if a state endpoint
moves, the fix is one line there rather than a code change.

Once pollution or wind is on, the block group card gains a matching section:
the parent tract's CalEnviroScreen score (a block group GEOID's first 11
digits are its tract), and the mean wind speed sampled at the block group's
centre.

### Hazard layers added later

| Layer | Source | Notes |
|---|---|---|
| FEMA flood zones | National Flood Hazard Layer, `hazards.fema.gov` | A/AE/V/VE is the 1% annual chance floodplain - the zone where a federally-backed mortgage requires flood insurance. A shaded X (0.2% chance) is told apart from a plain X by the `ZONE_SUBTY` field, not the zone letter. |
| Liquefaction & landslide | CA Geological Survey seismic hazard zones | CGS publishes the two as separate services, so this layer draws **both** rather than the first that answers. These mark where a site investigation is required before building - not a prediction that ground will fail. |
| Aviation noise | BTS / DOT National Transportation Noise Map | Aircraft only. **Published as a 24-hour A-weighted average (LAeq), not DNL** - so it carries no 10 dB night-time penalty and is *not* directly comparable with HUD's 65 dB DNL limit. An airport that flies at night feels worse than this number implies, which the card and legend both say. |

Noise is a raster rather than polygons, so it is drawn by asking the map
service to render each tile (`export`, with the tile's own bounding box in
Web Mercator) - no plugin needed - and the per-block-group value comes from
the same service's `identify` endpoint.

### More ACS measures on the card

`B25024` (units in structure), `B25003` (tenure), `B08301` (commute mode) and
`B25035`/`B25034` (year built) are fetched alongside the original tables, and
appear as **Housing stock** and **Work** sections plus five new filters:
detached-house share, owner-occupancy, work-from-home share, median year
built and the pre-1980 share.

Why those four: detached share is what separates a dense block group of small
lots from one holding an apartment tower, which density alone cannot do;
owner-occupancy says whether a median income describes owners or renters;
work-from-home is the closest thing to an occupation signal at this geography;
and year built carries LA's lead paint (pre-1978), asbestos (pre-1980) and
soft-story (pre-1994) thresholds.

`B25077` (owner-reported home value), `B08303` (travel time), `B23025`
(employment), `B11003` (families with own children) and `B15001` (education by
age) were probed first and all came back available at block group, so they are
now fetched and shown too - as a **Households** section, extra **Work** rows,
and a young-adult degree share under Education. Three of them are filterable:
home value, median commute and families with children.

**Detailed origin (B03001, B02015, B04006).** B03002's eight groups answer
"what race", which in LA is rarely the question - Armenian Glendale, Persian
Westwood, Korean Koreatown and Chinese San Gabriel are all invisible in it.
Three tables cover it because the Census splits it three ways, and they count
**different universes that can overlap**: a Mexican-origin person is in B03001,
a Korean one in B02015, an Armenian one in B04006, and one person can appear in
two of them. The card therefore shows three separate top-five lists, each as a
share of the block group's population, rather than one merged ranking that
would double-count. Every group in all three tables is fetched, and the top five of each is shown.

**The variable codes are not written down anywhere.** They were once, and it
was a mistake: an ACS table's codes cannot be verified without asking the API,
one wrong code fails the whole request, and the table was then skipped - so the
section simply never appeared, with nothing to say why. The script now reads
each table's variable list from the API's own description of it, keeps the leaf
categories (a parent is the sum of its children), and drops the complements and
catch-alls - "Not Hispanic or Latino", "Other groups", "Unclassified". If a
table cannot be fetched the run ends with a WARNING naming it, and the card
says which table is missing instead of showing nothing.

**These three are published at TRACT level, and shown as percentages.** The
Census does not break them down to block group. Worse, the API does not refuse
a block-group query for them - it answers with nulls for every row, which looks
exactly like success. So the fetch now treats an all-empty answer as "not
really published here" and falls through to tract.

That makes the denominator the whole point: a tract's head count over a block
group's population is meaningless and routinely exceeds 100%. The figures are
therefore stored as **shares of the tract they came from**, computed when the
file is built, and the card labels them `(tract)` and says so in the tooltip.
Every block group inside a tract shows the same figures - this describes the
neighbourhood around a block group, not the block group itself.

**Median commute is interpolated, not published.** The Census gives no median
travel time at block group, only B08303's thirteen bands, so the median is
found inside whichever band it falls in. Taking the band's midpoint instead
would quantise every block group in LA onto the same dozen values.

**Owner-reported home value is not a rival to the assessor figures.** B25077
covers houses, condos and townhouses together and is what owners *say* their
home is worth; the roll's prices are single-family only and are assessed
values at transfer. Where the two disagree sharply, that is usually a block
group of long-held homes whose assessed values are frozen well below market -
which is information, not an error.

### Optional: home prices from the Assessor roll

ACS `B25077` is the median value of *all* owner-occupied units - condos,
townhouses and houses blended into one self-reported number, and no ACS table
cross-tabs value by structure type at any geography. For a single-family
figure the only free source is the LA County Assessor.

1. At [data.lacounty.gov](https://data.lacounty.gov) search **Assessor** and
   download the **Assessor Parcel Data** roll as **CSV** (not the shapefile or
   geodatabase - you don't need parcel geometry). The multi-year export
   (rolls 2021 to present) is fine: it stacks every roll year, so one parcel
   appears once per year, and the script keeps only each parcel's newest row.
2. Save it as `raw-data/assessor-roll-2025.csv`.
3. Run:

```
# Windows
python scripts\fetch-parcel-data.py

# macOS / Linux
python3 scripts/fetch-parcel-data.py
```

It pulls LA County block group outlines from TIGERweb, bins each parcel by its
`CENTER_LAT`/`CENTER_LON`, and writes `js/data/parcels-la-county.json`.

**The public roll has no sale price column** - it carries assessed values, a
recording date and a base year, and no sale amount. Proposition 13 is what
makes the number recoverable anyway:

> A change of ownership resets a property's assessed value to its purchase
> price, and from then on it may rise only about 2% a year.

So for a house that changed hands *recently*, assessed value ≈ what it sold
for. The same rule that makes assessed value useless for a long-held house
makes it a good proxy for a freshly-sold one - which is why only parcels
transferred in the last three years count (`--years` to change).

Four guards keep the number honest: single-family use codes only (`01xx`, or
the text column, and never more than one unit); nothing under $50,000, which
is a transfer rather than a sale; a price-per-square-foot plausibility band,
because an *excluded* transfer (inter-spousal, some parent-child) records a
new deed without triggering reassessment and shows up as a 2024 recording
carrying a 1970s value; and each block group reports **how many sales its
median rests on**, with fewer than three flagged as thin on the card.

The run prints the use codes it kept and dropped, so the "01xx means single
family" assumption can be checked against your own file rather than taken on
trust, plus the 5th/95th percentile of the block group medians so an
implausible tail is visible immediately.

**Click any sales count** to see the individual transfers behind it: address,
recording date, floor area, year built, and the assessed land and improvement
values with the exemption that nets them to the total. Those rows live in a
second file, `js/data/parcel-sales-la-county.json`, which the page fetches
only when a count is first clicked - it is far larger than the summary and
most sessions never open it.

**The card shows a year-by-year table**, not a single number: median, 10th and
90th percentile, median $/ft² of building area, sales, and turnover (that
year's sales as a share of the block group's single-family stock). Percentiles
appear only where a year had at least five sales - a spread drawn from three
is just the cheapest and dearest of three. The county-wide median for each
year sits underneath, so you can see whether a block group moves with the
market or against it.

**The multi-year export is what makes a year-by-year table possible.** A roll
carries one value per parcel - its most recent transfer - so a house that sold
in 2021 and again in 2024 shows only the 2024 sale in the 2025 roll. But roll
year N records the transfers known at that point, so the 2022 roll still
carries that 2021 sale. Stacking the years recovers transactions a single roll
would have overwritten. Each sale is taken from the **earliest** roll year that
knows about it, which is the one closest to the price actually paid.

The most recent year is always short: sales are recorded in the following
year's roll, so 2025 sales will not appear until the 2026 roll exists.

**Deduplication matters on the multi-year export.** A house that sold in 2023
appears in the 2023, 2024 and 2025 rolls; one that sold in 2025 appears once.
Counted as-is that inflates every count and quietly weights each median toward
older, cheaper sales, so parcels are deduplicated on `AIN` with the newest
roll year winning.

Read each year's figure as a *level* for that year rather than as today's
asking price.

**No `$/lot ft²`.** The county's roll export carries building square footage
but no lot size, land area or acreage - the column simply is not there. Lot
area lives only in the parcel *geometry* (the ~2 GB shapefile/geodatabase),
where it is a field on each polygon. The script already looks for a lot column
and will use it if a future export carries one.

### Optional: listings for sale (Redfin)

1. On redfin.com, search with your filters, switch to the **table view**,
   scroll to the bottom of the table and click **Download All**. Redfin caps a
   download at 350 homes and hides the button under 20 results, so pull one
   file per neighbourhood.
2. Save the files into `raw-data/redfin-listings/` **keeping their
   `redfin_YYYYMMDDHHMMSS.csv` names** - the timestamp in the filename is the
   only record of when the snapshot was true, and the page reads it.
3. Reload the page. That is the whole procedure.

**There is no script to run and nothing to re-run.** The page lists the folder
over HTTP, parses whatever CSVs are in it, and works out which homes fall
inside the block group you selected by testing their coordinates against that
polygon. Add a file, delete a file, drop in a fresher download - reload and
it is picked up. (This is why the page has to be served by
`python -m http.server` rather than opened as a `file://` URL: a folder needs
a server to be listable.)

Select a block group and its listings appear as dots; click one for the house
card, which stays open alongside the block group card so both can be read at
once.

**Days on market is a listing date, not the number in the file.** The
days-on-market column in an export is only true on the day it was downloaded -
by tomorrow it is a day short. The page subtracts it from the download time to
get the date the home was listed, and counts forward from there.

Lot size is here too, which the assessor roll lacks - so listings show
**$/ft² of lot** as well as of floor area.

#### What you decide about a house

The house card carries three things that are yours rather than Redfin's:

* **In your list since** - the first download of yours the home appeared in.
* **Remove** - for a home that has sold or been withdrawn. Its dot disappears.
  If a download made *after* you removed it still contains the home, it comes
  back on its own: a sale usually shows up as a listing that simply stops
  appearing, so anything still being published is still for sale.
* **Not interested** - asks why in one line, records it, greys the dot out and
  shows the reason above the price the next time you open the card. The
  buttons then become **Remove** and **Interested**, so you can change your
  mind.

These live in the browser's `localStorage` under `la-home-map.listings.v1`,
because a page served off disk cannot write files back to it. They survive
reloads and re-downloads, and they are per-browser: they do not travel to
another machine, and clearing site data clears them.

### Optional: commute times

Put a free [OpenRouteService](https://openrouteservice.org/dev/#/signup) key
(no credit card, 2,500 requests/day) in `ors-api-key.txt` in the project root.
Type a destination in the sidebar, drop a pin, and the card shows the drive.

**The time shown is free-flow, and the page says so.** No genuinely free
router models traffic, and in LA that is the difference between 30 minutes and
75. If you want real rush-hour numbers, Mapbox's `driving-traffic` profile
does model traffic on a free tier - but it requires a credit card, and it is a
one-line swap in `BG_CONFIG` when you want it.

### Optional: wind data (one-time, about two minutes)

The Global Wind Atlas has no tile service and no WMS - it publishes GeoTIFF
downloads only - so there is nothing a browser can toggle on directly. One
script converts a downloaded GeoTIFF into the small JSON grid the page draws:

1. Open https://globalwindatlas.info and zoom to Los Angeles County.
2. Choose **Mean wind speed** at the height you want. 100 m is the GWA
   default; 10 m or 50 m is closer to what a house actually feels.
3. Download the GeoTIFF for a custom area covering the county (roughly
   -119.0 to -117.5 longitude, 32.7 to 34.9 latitude).
4. Run:

```
pip install numpy tifffile

# Windows
python scripts\fetch-wind-data.py C:\path\to\downloaded.tif --height "50 m"

# macOS / Linux
python3 scripts/fetch-wind-data.py ~/Downloads/downloaded.tif --height "50 m"
```

That writes `js/data/wind-la-county.json` (around 200 KB) and the Wind
toggle starts working on the next reload. Skip this and everything else on
the page still works; the Wind toggle just reports that the file is missing.

`numpy` and `tifffile` are pip-installable wheels on Windows -
deliberately not rasterio/GDAL, which need a compiler or conda.

### Drop a pin

The address box finds an address and drops a pin on it. To go the other way -
click a spot, get the address - press **Drop a pin**, then click the map.
It is an armed mode rather than an always-on behaviour because a plain map
click already means "select this block group"; while the mode is armed the
block group click handler stands down, and the mode disarms itself after one
drop (Escape cancels). The pin popup shows the reverse-geocoded street
address, the coordinates, and the wind speed there if wind data is loaded.

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
  which turned out to be published at block group after all, so the card also
  carries the 25-34 degree share.

**Age bands are 0-24 / 25-54 / 55+, not 0-25 / 25-55.** B01001's own
brackets break exactly at 25 and 55, so these are the natural boundaries and
nothing is double-counted.

**Anything that isn't available at block group is labeled.** The fetch script
tries each table at block group first, falls back to tract level only where it
must, records
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

### Basemap

The Block Group Explorer draws its basemap from **OpenFreeMap**'s Positron
style as vector tiles, through MapLibre GL (both vendored in `vendor/`, no
CDN). OpenFreeMap needs no API key, no signup, and sets no request limits.

This replaced Esri's Light Gray Canvas raster tiles for a concrete reason:
that service only publishes tiles to zoom 16, so the map went soft exactly
where a single block group fills the screen. Vector tiles are drawn at
whatever zoom you are at, so the map is sharp to zoom 20.

CARTO's Positron - the obvious alternative - started requiring an API key in
August 2026, which is the "API KEY REQUIRED" watermark you may have seen on
other maps.

Esri's raster tiles are still there as a fallback and take over automatically
if WebGL is unavailable (older machines, some remote desktops) or OpenFreeMap
cannot be reached - it is donation-funded and single-maintainer, so that is a
real scenario. The fallback sets `maxNativeZoom: 16`, so past zoom 16 it
upscales its last real tile rather than going blank. Either way the status
log says which basemap you got and why.

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

### The wind converter is tested without a wind file

`tests/test_wind_grid.py` builds synthetic GeoTIFFs carrying the same
georeferencing tags the Global Wind Atlas writes, then checks the conversion
against values computable by hand: that row 0 is the north edge and not the
south, that the output is clipped to the overlap with LA County rather than
to the requested box, that negative sentinels become nulls instead of
negative wind speeds, and that a projected or ungeoreferenced file is
rejected with an actionable message. No GWA download is needed to run it.

## Keeping it consistent

Two rules are enforced by tests rather than remembered.

**Every card row goes through one helper, and the helper requires a source.**
`cardRow(label, value, tip)` will not let a row be built without an explanation
of where its number came from - a missing one is reported to the console and
the "no page errors" test fails. Rows used to be hand-written in forty-one
places, which is exactly why explanations kept getting left off. Section and
sub headings go through `sectionLabel` / `subLabel` the same way.

**Every field we fetch has to reach a card.** `tests/test_data_coverage.py`
reads what the fetch scripts emit and fails if the page never mentions it. This
caught five fields that were being computed, written to disk and silently never
shown. Add a column to a data file without wiring it up and the test tells you.

```
python3 tests/test_data_coverage.py
```

## Project layout

```
blockgroups.html      Block Group Explorer page (see above)
js/blockgroups.js      ...its map, toggles, viewport loading and popup
css/blockgroups.css    ...its styles
scripts/fetch-blockgroup-data.py   One-time block-group ACS fetch
scripts/fetch-wind-data.py         One-time Global Wind Atlas GeoTIFF -> JSON grid
scripts/fetch-parcel-data.py       One-time Assessor roll -> per-year prices and sales
raw-data/redfin-listings/          Drop Redfin CSV exports here - the page reads them directly

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
vendor/maplibre/        MapLibre GL 5.24 + maplibre-gl-leaflet, vendored - the vector basemap
scripts/fetch-census-data.sh   One-time local Census data snapshot (see "Running it")
```

## Optional: raise the Census API rate limit

The Census API works anonymously at low volume. For heavier use, get a free
key at https://api.census.gov/data/key_signup.html and paste it into
`CONFIG.CENSUS_API_KEY` in `js/config.js`.
