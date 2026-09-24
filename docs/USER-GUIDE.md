# How to use it

## Starting it

Open a terminal in the project folder:

```
python -m http.server 8000
```

Then open <http://localhost:8000/blockgroups.html>.

If you want the paste-a-listing feature, run this instead:

```
python scripts/listing-server.py
```

Same page, plus one extra box. Needs `pip install anthropic` and your key in a
`.env` file. Everything else works either way.

**Don't double-click the HTML file.** Browsers block local data over `file://`.
The page will tell you if you do.

## The basic loop

1. Zoom in past 12. Tick **Block group borders**.
2. Click a block group. A card opens on the right with everything known about it.
3. Tick layers you care about — fire, schools, pollution.
4. Use the filters in the left pane to hide block groups that don't qualify.
5. Click a red pin to see a house. Heart it, note it, or mark it not-interested.

## The left pane

Top to bottom:

- **Filters** — hide block groups that fail a test. Income, age, ethnicity,
  price, and about 30 more. They stack.
- **Boundaries** — zip, tract, block group.
- **Environment & hazards** — fire, pollution, flood, seismic, noise, wind.
- **Aerial** — satellite imagery, parcel outlines (zoom 16+).
- **Listings** — show every house across the county, add one by address.
- **Schools** — three switches and three rating filters.
- **Density** — shade by people per square mile.
- **Data sources** — every dataset, where it came from, when it loaded.
- **Status log** — what just happened. Read this when something looks wrong.

## The cards

**Block group card** — opens when you click a polygon. Everything about the
area. Every row has an ⓘ; hover it to see exactly where the number came from
and what it does and doesn't mean. Read those — several numbers are easy to
misread.

**House card** — opens when you click a red pin. The listing, plus how its
price per square foot compares to its block group. Heart, notes, and
not-interested live here.

**Pin card** — drop a pin anywhere to get the exact-address answer: schools,
jurisdiction, zoning, commute.

## Schools

Three switches, one per level. Each draws:

- **Translucent zones** — the attendance boundary
- **Dots** — the school buildings

Turn on two and you'll see the zones overlap. That's intentional — a house is
in one elementary, one middle and one high zone at once.

**Filter by rating**: pick "at or above" and type 7. Every elementary school
under 7 leaves, and its zone goes with it. Clear brings them back.

Two things to know:

- The boundaries are from **2015-16**. It's the only county-wide source that
  exists. Confirm with the district before you offer.
- The rating is **GreatSchools'**, from your own table. Nothing is computed,
  and a school your table doesn't list has no rating.

### Adding or updating your ratings

1. Save your table as a CSV in `raw-data/school-ratings/`. It needs School
   Name, Address, City, Zip, Elementary, Middle?, High? and GreatSchools
   Rating columns.
2. Run `python scripts/fetch-school-data.py`. **Dropping the CSV in is not
   enough** - the script is what ties each row to a dot and a zone.
3. Open `raw-data/school-ratings-match-report.csv`. Rows that didn't match are
   at the top, each with the reason.
4. To fix a row, add a `CDS` column and put the school's 14-digit state code
   in it. Run the script again.
5. Reload the page.

Your Yes/No columns decide which switch a school counts under. A school marked
Elementary and Middle shows under both.

## Listings

Drop Redfin CSVs into `raw-data/redfin-listings/` and reload. No script.

To add one by hand, type the address in the left pane and hit Add.

To have a listing read for you (needs `listing-server.py`): paste the page
text into the box and hit **Read it**. Pasting the text works more reliably
than pasting the URL — Redfin and Zillow block scripts.

**Open the listings table** shows everything you've collected, sortable, with
your hearts and notes. Click a row to fly to it.

## Where your stuff is saved

Favourites, notes and not-interested marks are in your **browser's local
storage**, tied to the exact address and port.

This means:
- They survive reloads and new CSV downloads.
- They're gone if you clear site data.
- They don't follow you to another browser or machine.
- Changing the port (8000 → 8001) hides them. Change it back and they return.

## Keeping data fresh

| When | Do this |
|---|---|
| New listings | Drop CSVs in `raw-data/redfin-listings/`, reload |
| Yearly, or when the card says so | `python scripts/fetch-blockgroup-data.py` |
| Yearly | `python scripts/fetch-parcel-data.py` (needs a fresh Assessor download) |
| Yearly | `python scripts/fetch-school-data.py` |
| Once, ever | `python scripts/fetch-wind-data.py` |

The app tells you when a file is out of date. You don't have to track it.

## When something looks broken

1. Open the **status log** in the left pane. It names the URL and the error.
2. If a layer is blank, check the zoom — most need 11+ or 12+, parcels need 16.
3. If a card says a file is missing, run the script it names.
4. Hard-refresh (Ctrl-Shift-R) after installing a new version.

If the log says a service didn't answer, it's usually the publisher, not you.
