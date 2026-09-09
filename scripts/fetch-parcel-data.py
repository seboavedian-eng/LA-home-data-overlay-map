#!/usr/bin/env python3
"""
Turn the LA County Assessor roll into a median single-family sale price per
census block group.

WHY NOT JUST USE THE CENSUS
---------------------------
ACS B25077 is the median value of *all* owner-occupied units - condos,
townhouses and detached houses blended into one self-reported, five-year
rolling number. No ACS table cross-tabs value by structure type at any
geography. The Assessor's roll is the only free source that can answer "what
does a single-family house cost here".

THE PROP 13 TRAP
----------------
Assessed value is NOT market value. A house held since 1985 carries an
assessed value near nothing, and two identical neighbours can differ tenfold
purely by how long each owner has been there. Mapping raw assessed value
produces a map of tenure, not of prices.

This script therefore uses RECORDED SALE PRICE, restricted to sales in the
last few years, which is the one figure in the roll that reflects the market.
Block groups with too few recent sales report their count so a median resting
on three houses is visible as such rather than passing for a real number.

WHAT YOU NEED
-------------
  1. From https://data.lacounty.gov (search "Assessor"), download the current
     "Assessor Parcel Data" roll as CSV.
  2. Save it as  raw-data/assessor-roll-2025.csv  in this project.
  3. Run:  python scripts/fetch-parcel-data.py

No GIS software and no shapefile: the roll carries CENTER_LAT / CENTER_LON per
parcel, so this bins parcels into block groups itself using block group
outlines pulled from the Census TIGERweb service.

Output: js/data/parcels-la-county.json
"""

import argparse
import csv
import datetime
import json
import os
import statistics
import sys
import urllib.error
import urllib.parse
import urllib.request

TIGERWEB = (
    "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer"
)
BLOCK_GROUP_LAYER = 10
STATE = "06"
COUNTY = "037"

DEFAULT_CSV = os.path.join("raw-data", "assessor-roll-2025.csv")
DEFAULT_OUT = os.path.join("js", "data", "parcels-la-county.json")

# Column names differ between roll years and between the portal's exports, so
# every field is looked up by candidate list and the script prints what it
# matched.
COLUMNS = {
    "lat": ["CENTER_LAT", "center_lat", "LATITUDE", "LAT"],
    "lon": ["CENTER_LON", "center_lon", "LONGITUDE", "LON"],
    "use_code": ["PropertyUseCode", "UseCode", "PROPERTYUSECODE", "USECODE"],
    "general_use": ["GeneralUseType", "GENERALUSETYPE"],
    "specific_use": ["SpecificUseType", "SPECIFICUSETYPE"],
    "sale_price": ["SalePrice", "SALEPRICE", "Sale_Price", "LastSalePrice"],
    "sale_date": ["RecordingDate", "RECORDINGDATE", "SaleDate", "LastSaleDate", "RecordDate"],
    "sqft": ["SQFTmain", "SqFtMain", "SQFTMAIN", "BuildingSqFt", "MainSqFt"],
    "year_built": ["YearBuilt", "YEARBUILT", "EffectiveYearBuilt"],
    "roll_total": ["Roll_TotalValue", "TotalValue", "ROLL_TOTALVALUE"],
}

# LA County use codes: the leading "01" is single-family residence. The text
# fields are checked too, because some exports carry only those.
SFR_CODE_PREFIX = "01"
SFR_TEXT = "single family"

# A sale below this is a transfer, not a market transaction: family
# quitclaims, corrections and $1 grants are all over the roll.
MIN_SALE_PRICE = 50000
# Above this, it is almost always a bulk or portfolio transfer recorded
# against one parcel.
MAX_SALE_PRICE = 50000000


class ParcelDataError(Exception):
    """A problem the user needs to act on, reported without a traceback."""


# --- Block group outlines ---------------------------------------------------


def fetch_json(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": "la-home-data-overlay-map/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_block_groups():
    """
    All LA County block group polygons from TIGERweb, paged around the
    server's record cap. Returns [(geoid, [rings])].
    """
    print("Fetching block group outlines from TIGERweb...")
    collected = {}
    offset = 0
    while True:
        params = urllib.parse.urlencode(
            {
                "where": f"STATE='{STATE}' AND COUNTY='{COUNTY}'",
                "outFields": "GEOID",
                "returnGeometry": "true",
                "outSR": "4326",
                "f": "json",
                "resultOffset": str(offset),
                "resultRecordCount": "1000",
            },
            quote_via=urllib.parse.quote,
        )
        url = f"{TIGERWEB}/{BLOCK_GROUP_LAYER}/query?{params}"
        try:
            data = fetch_json(url)
        except urllib.error.HTTPError as err:
            raise ParcelDataError(f"TIGERweb refused the block group query (HTTP {err.code}): {url}") from err
        except Exception as err:  # noqa: BLE001 - network, DNS, timeouts
            raise ParcelDataError(f"could not reach TIGERweb ({type(err).__name__}: {err})") from err

        if "error" in data:
            raise ParcelDataError(f"TIGERweb error: {data['error'].get('message')}")

        features = data.get("features", [])
        for f in features:
            geoid = (f.get("attributes") or {}).get("GEOID")
            rings = (f.get("geometry") or {}).get("rings")
            if geoid and rings:
                collected[geoid] = rings

        print(f"  {len(collected)} block groups so far...")
        if not data.get("exceededTransferLimit") or not features:
            break
        offset += len(features)

    if not collected:
        raise ParcelDataError(
            "TIGERweb returned no block groups for LA County. That usually means the layer id "
            f"({BLOCK_GROUP_LAYER}) moved - check {TIGERWEB}?f=json for the current 'Census Block Groups' id."
        )
    print(f"  {len(collected)} block groups.")
    return collected


# --- Point in polygon, with a grid index -----------------------------------
# 2.4 million parcels against 6,500 polygons is 15 billion comparisons done
# naively. The grid narrows each parcel to the handful of polygons whose
# bounding box covers its cell, which is what makes this run in minutes.

GRID = 0.01  # degrees, about 1.1 km


def ring_contains(x, y, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def ring_is_clockwise(ring):
    total = 0.0
    for i in range(len(ring) - 1):
        total += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1])
    return total >= 0


def build_index(block_groups):
    """cell -> [(geoid, bbox, outer_rings, hole_rings)]"""
    index = {}
    shapes = {}
    for geoid, rings in block_groups.items():
        # Esri winding: clockwise rings are outer, counter-clockwise are holes.
        outer = [r for r in rings if ring_is_clockwise(r)]
        holes = [r for r in rings if not ring_is_clockwise(r)]
        if not outer:
            outer = rings
            holes = []
        xs = [p[0] for r in rings for p in r]
        ys = [p[1] for r in rings for p in r]
        bbox = (min(xs), min(ys), max(xs), max(ys))
        shapes[geoid] = (bbox, outer, holes)

        for cx in range(int(bbox[0] / GRID), int(bbox[2] / GRID) + 1):
            for cy in range(int(bbox[1] / GRID), int(bbox[3] / GRID) + 1):
                index.setdefault((cx, cy), []).append(geoid)
    return index, shapes


def locate(lon, lat, index, shapes):
    for geoid in index.get((int(lon / GRID), int(lat / GRID)), ()):
        bbox, outer, holes = shapes[geoid]
        if not (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]):
            continue
        if any(ring_contains(lon, lat, r) for r in outer) and not any(
            ring_contains(lon, lat, h) for h in holes
        ):
            return geoid
    return None


# --- The roll ---------------------------------------------------------------


def find_column(header, candidates, label):
    lowered = {h.lower().strip(): h for h in header}
    for candidate in candidates:
        if candidate.lower() in lowered:
            return lowered[candidate.lower()]
    # Substring fallback: exports occasionally prefix or suffix names.
    for candidate in candidates:
        for key, original in lowered.items():
            if candidate.lower() in key:
                return original
    raise ParcelDataError(
        f"could not find the {label} column.\n"
        f"  Looked for: {', '.join(candidates)}\n"
        f"  The file has: {', '.join(sorted(header)[:40])}{' ...' if len(header) > 40 else ''}\n"
        "  If the roll renamed it, add the new name to COLUMNS in this script."
    )


def to_float(value):
    try:
        return float(str(value).replace(",", "").replace("$", "").strip())
    except (TypeError, ValueError):
        return None


def sale_year(value):
    """Recording dates appear as 20240115, 2024-01-15 or 01/15/2024."""
    text = str(value or "").strip()
    if not text:
        return None
    digits = "".join(ch for ch in text if ch.isdigit())
    if len(digits) == 8:
        # Either YYYYMMDD or MMDDYYYY - the year is whichever end looks like one.
        head, tail = digits[:4], digits[4:]
        if 1900 <= int(head) <= 2100:
            return int(head)
        if 1900 <= int(tail) <= 2100:
            return int(tail)
    if len(digits) >= 4:
        for chunk in (digits[:4], digits[-4:]):
            if 1900 <= int(chunk) <= 2100:
                return int(chunk)
    return None


def is_single_family(row, cols):
    code = str(row.get(cols["use_code"], "") or "").strip()
    if code.startswith(SFR_CODE_PREFIX):
        return True
    specific = str(row.get(cols.get("specific_use"), "") or "").lower()
    return SFR_TEXT in specific


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--csv", default=DEFAULT_CSV, help="Assessor roll CSV")
    parser.add_argument("--out", default=DEFAULT_OUT, help="Output JSON path")
    parser.add_argument("--years", type=int, default=3, help="How many years of sales to keep")
    parser.add_argument("--min-sales", type=int, default=3, help="Block groups with fewer sales are still written, but flagged")
    args = parser.parse_args()

    if not os.path.exists(args.csv):
        raise ParcelDataError(
            f"no roll at {args.csv}.\n"
            "  Download 'Assessor Parcel Data' as CSV from https://data.lacounty.gov (search 'Assessor'),\n"
            f"  save it as {DEFAULT_CSV}, or pass --csv with its path."
        )

    block_groups = fetch_block_groups()
    index, shapes = build_index(block_groups)

    cutoff = datetime.date.today().year - args.years
    print(f"\nReading {args.csv} (keeping single-family sales from {cutoff} onwards)...")

    sales = {}
    per_sqft = {}
    years = {}
    read = kept = 0
    unplaced = 0

    with open(args.csv, newline="", encoding="utf-8-sig", errors="replace") as fh:
        reader = csv.DictReader(fh)
        header = reader.fieldnames or []
        cols = {}
        for key in ("lat", "lon", "use_code", "sale_price", "sale_date"):
            cols[key] = find_column(header, COLUMNS[key], key.replace("_", " "))
        for key in ("specific_use", "sqft", "year_built"):
            try:
                cols[key] = find_column(header, COLUMNS[key], key)
            except ParcelDataError:
                cols[key] = None  # optional
        print("  Matched columns: " + ", ".join(f"{k}={v}" for k, v in cols.items() if v))

        for row in reader:
            read += 1
            if read % 250000 == 0:
                print(f"  {read:,} rows read, {kept:,} usable sales so far...")

            if not is_single_family(row, cols):
                continue
            price = to_float(row.get(cols["sale_price"]))
            if price is None or price < MIN_SALE_PRICE or price > MAX_SALE_PRICE:
                continue
            year = sale_year(row.get(cols["sale_date"]))
            if year is None or year < cutoff:
                continue
            lat = to_float(row.get(cols["lat"]))
            lon = to_float(row.get(cols["lon"]))
            if lat is None or lon is None or not (32 < lat < 36) or not (-120 < lon < -116):
                continue

            geoid = locate(lon, lat, index, shapes)
            if geoid is None:
                unplaced += 1
                continue

            kept += 1
            sales.setdefault(geoid, []).append(price)
            sqft = to_float(row.get(cols["sqft"])) if cols.get("sqft") else None
            if sqft and sqft > 200:
                per_sqft.setdefault(geoid, []).append(price / sqft)
            built = to_float(row.get(cols["year_built"])) if cols.get("year_built") else None
            if built and 1800 < built < 2100:
                years.setdefault(geoid, []).append(built)

    if not kept:
        raise ParcelDataError(
            f"read {read:,} rows but found no usable single-family sales.\n"
            "  Most likely the use-code or sale-price column is named something this script does not know.\n"
            "  The matched columns are printed above - check them against the file and update COLUMNS."
        )

    records = {}
    for geoid, prices in sales.items():
        record = {
            "medianSalePrice": round(statistics.median(prices)),
            "saleCount": len(prices),
            "thin": len(prices) < args.min_sales,
        }
        if geoid in per_sqft:
            record["medianPricePerSqft"] = round(statistics.median(per_sqft[geoid]), 1)
        if geoid in years:
            record["medianYearBuiltSold"] = int(statistics.median(years[geoid]))
        records[geoid] = record

    all_medians = sorted(r["medianSalePrice"] for r in records.values())
    payload = {
        "meta": {
            "schemaVersion": 1,
            "source": "LA County Assessor parcel roll (recorded sale prices)",
            "sourceFile": os.path.basename(args.csv),
            "salesFrom": cutoff,
            "generated": datetime.date.today().isoformat(),
            "minSalePrice": MIN_SALE_PRICE,
            "note": (
                "Median RECORDED SALE PRICE of single-family parcels sold since "
                f"{cutoff}. Not assessed value: under Proposition 13 an assessed "
                "value reflects how long the owner has held the house, not what it "
                "is worth."
            ),
        },
        "blockGroups": records,
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))

    thin = sum(1 for r in records.values() if r["thin"])
    print(f"\nWrote {args.out} ({os.path.getsize(args.out) / 1024:.0f} KB)")
    print(f"  {read:,} rows read, {kept:,} single-family sales kept since {cutoff}")
    print(f"  {len(records):,} block groups have at least one sale")
    print(f"  {thin:,} of those rest on fewer than {args.min_sales} sales and are flagged as thin")
    if unplaced:
        print(f"  {unplaced:,} sales fell outside every LA County block group (county edge, bad coordinates)")
    print(
        f"  median of the block group medians: ${all_medians[len(all_medians) // 2]:,}"
        f" (range ${all_medians[0]:,} to ${all_medians[-1]:,})"
    )
    print("\nReload blockgroups.html - the card gains a Home prices section.")


if __name__ == "__main__":
    try:
        main()
    except ParcelDataError as err:
        print(f"\nCould not build the parcel data: {err}\n", file=sys.stderr)
        sys.exit(1)
