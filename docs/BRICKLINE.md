# Brickline pilot page

`brickline.html` is the version you put in front of other people. It runs on
the same data and lookups as the explorer (`blockgroups.html`), which stays
exactly as it was.

## Run it

```
python scripts/listing-server.py      # then open http://localhost:8000/brickline.html
```

Use the listing server, not plain `http.server`. It is what saves sign-ups to
`raw-data/leads.jsonl`. Without it, sign-ups are kept only in that browser, and
Data status says so.

## Finding a neighbourhood: filters like AllTrails

- Filter pills run along the top of the map: **All** · Commute · Street · Homes · Education · Income · Household · Age mix · (Schools, personal mode).
- A pill opens its own small panel with that question's controls. "Show N areas" closes it; a click elsewhere closes it too.
- An active pill shows its value ("35 min to work", "Bachelor's 40%+") with an ×, which clears only that filter. "Reset" clears them all.
- **All** opens the guided eight questions in the left panel ("Start the questions" on the landing page does the same). Only one of the two shows at a time.
- The left panel is the live list: "Explore areas · N areas fit", sort and direction, "Email me this list", and "Show all areas on the map".
- The commute box suggests places and workplaces as you type, not only street addresses.

## The map, and what a click does

- Neighbourhoods are block group outlines, shaded by street busyness, drawn only from zoom 12 in (`BG_CONFIG.MIN_ZOOM.blockGroup`). Zoomed out, nothing; a click there zooms in.
- Once you've answered, only the areas that fit are drawn, on every screen; the rest are left off the map and can't be clicked. "Show all areas" brings them back (answers kept). Reset sits next to Edit answers.
- A searched neighbourhood, city or zip: only its block groups are drawn, inside a dashed blue border. The × on its chip clears it.
- Selecting an area zooms the map so it fills about a quarter of it (`AREA_SHARE` in app.js).
- "On this map" in the layer panel says what each line and box is: lot, buildings, main-house setback line (dashed), ADU open spot (green).
- The ADU open spot already excludes existing buildings. The card also gives a likely footprint: the open spot, capped by remaining lot coverage beyond the 800 sq ft state law guarantees (unverified for Glendale).

| You click | What happens |
|---|---|
| An area, with nothing selected | Selects it (a preview on the questions screen; the area card elsewhere) |
| Inside the selected area | Opens the house card for that point |
| Inside another area | Selects that one instead |
| Outside every area | Clears the selection (from a card, back to the questions) |

Six map layers, upper right, all off until switched on: fire, flood, landslide & liquefaction, noise, air quality, wind.

## The search box

One box for an address, a neighbourhood, a city or a zip, with suggestions as you type.

| You type | It suggests / does | From |
|---|---|---|
| A name ("silv") | Neighbourhoods, communities, cities | County Countywide Statistical Areas, then city boundaries (`BG_CONFIG.PLACES`) |
| Five digits | That zip code | Census TIGERweb ZCTA |
| A street address | Address matches (after a short pause) | Nominatim, the explorer's geocoder |
| A Redfin / Zillow link | The house | Address read from the link |

A place's block groups are those whose Census interior point is inside its border. **Not yet verified live:** which county layer answers for names is in Data status.

## The two journeys

| Journey | Starts from | Ends at |
|---|---|---|
| I have a place in mind | An address, neighbourhood, city or zip on the landing page | House card, or a place card listing its block groups |
| Find a neighbourhood | "Start the questions" | Shortlist → area card → house card |

### The eight questions

| # | Question | Data behind it |
|---|---|---|
| 1 | Commute (up to 3), minutes, rush hour | OpenRouteService isochrone; straight-line circle if there's no key |
| 2 | How busy a street | People per sq mi, the explorer's density bands |
| 3 | Houses vs apartments | B25024, share detached |
| 4 | Education | B15003, bachelor's+ (▲ county average) |
| 5 | Income | B19013 (▲ county average) |
| 6 | Household size, from / to | B25010 |
| 7 | Age mix, off by default | B01001, three shares summing to 100 |
| 8 | School ratings | Nearest school per level; your own GreatSchools table only |

The email step comes before results and has "Skip for now".

### The cards

- **Area card**, with these tabs:
  - Summary: tiles, an automatic summary, why the area matched, homes for sale;
  - People;
  - Money & work;
  - Safety & environment;
  - Schools;
  - Sales & prices;
  - Data.
- **House card**:
  - "This house" group: Summary, and Lot & building. Lot & building runs in this order: the building, things to know, room to build, zoning, rules to follow.
  - "The neighbourhood" group: the same tabs as the area card.
- Clicking anywhere on the map from an area or a house checks the lot at that point.

## Going online

See `docs/DEPLOY.md`: build the package with `scripts/build-public-site.py`, run it with `server/brickline_server.py` on Render. On the public site the email step really sends the visitor their shortlist (top 10 areas and a link that reopens their answers) and sends you a copy.

## Personal vs public mode

| Data | Shown when |
|---|---|
| GreatSchools ratings (your table) | Personal mode only |
| Redfin exports (homes for sale) | Personal mode only |
| Everything else | Always |

- Personal mode is on for `localhost`, `127.x` and `100.x` (Tailscale).
- `?mode=public` or `?mode=personal` overrides it.
- Put the page on a public host and both personal-use sources drop out on their own.

## What gets recorded

`POST /api/lead` appends one JSON line to `raw-data/leads.jsonl` (gitignored).

| kind | When |
|---|---|
| `lead` | The email step, with the answers |
| `search` | Results shown (email if given) |
| `alert` | "Email me when one lists" on an empty area |
| `report_request` | "Get the report" on a house card |

## How it's built

- `js/brickline/app.js` is all of it: the questions, the cards and the map drawing.
- Every lookup goes through `BlockGroupApp.engine`, the explorer's own code.
  - So service URLs, field fallbacks and the zone rules are never copied.
- The page sets `window.BLOCKGROUPS_HEADLESS = true` before loading `js/blockgroups.js`.
  - That stops the explorer from building its own map into this page.
- Block group centres and land areas come from TIGERweb, one query of about 6,500 rows.
  - They're cached in localStorage (`brickline.bgIndex.v1`).
- Test: `node tests/brickline-e2e.js` (130 checks, stubbed network, real clicks).

## Known limits

| Limit | Why |
|---|---|
| Shops and cafés question is "coming soon" | Needs OpenStreetMap places data |
| Street level (crime, lights, pavement) is "coming soon" | No source wired yet |
| Schools in the finder are nearest, not assigned | Attendance zones cut across blocks |
| Zone rules only for Glendale | Each city needs its code chapter transcribed |
| The summary is templated, not AI | Fair housing: it describes the place, never the people |
| Rush hour is free-flow × 1.7 | OpenRouteService has no live traffic |
| Live services unverified from the sandbox | Only a real browser can confirm them |
