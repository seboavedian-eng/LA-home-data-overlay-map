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

## The two journeys

| Journey | Starts from | Ends at |
|---|---|---|
| Check a house | An address or a Redfin / Zillow link on the landing page | House card |
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
- Test: `node tests/brickline-e2e.js` (66 checks, stubbed network, real clicks).

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
