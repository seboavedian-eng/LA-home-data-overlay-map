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

THE PUBLIC ROLL HAS NO SALE PRICE COLUMN
----------------------------------------
It carries assessed values, a recording date and a base year - and no sale
amount. So the market figure has to be reconstructed, and Proposition 13 is
what makes that possible:

    A change of ownership resets a property's base year value to its full
    cash value - in practice, the purchase price - and from then on that
    value may rise only about 2% a year.

So for a parcel that changed hands RECENTLY, the assessed value IS
approximately the price it sold for. The same rule that makes assessed value
useless for a long-held house makes it a good proxy for a freshly-sold one.

This script therefore takes assessed value (land + improvements) for parcels
whose deed was recorded in the last few years, which is as close to recent
sale price as the free data goes. Two guards keep stale values out: a price
floor, and a plausibility band on price per square foot - an excluded
transfer (inter-spousal, some parent-child) records a new deed without
triggering reassessment, and shows up as a 2024 recording carrying a 1970s
value.

Block groups report the number of sales behind their median, so one resting
on three houses is visible as such rather than passing for a market rate.

WHAT YOU NEED
-------------
  1. From https://data.lacounty.gov (search "Assessor"), download the
     "Assessor Parcel Data" roll as CSV. The multi-year export (rolls 2021 to
     present) is fine - it stacks every roll year, so one parcel appears once
     per year, and this script keeps only each parcel's newest row.
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
# The per-sale detail behind each count. Kept in its own file because it is
# two orders of magnitude larger than the summary, and the page only needs it
# if someone actually clicks a number.
DEFAULT_SALES_OUT = os.path.join("js", "data", "parcel-sales-la-county.json")

# Column names differ between roll years and between the portal's exports, so
# every field is looked up by candidate list and the script prints what it
# matched.
COLUMNS = {
    "lat": ["Location Latitude", "CENTER_LAT", "center_lat", "LATITUDE", "LAT"],
    "lon": ["Location Longitude", "CENTER_LON", "center_lon", "LONGITUDE", "LON"],
    "use_code": ["Property Use Code", "PropertyUseCode", "UseCode", "PROPERTYUSECODE", "USECODE"],
    "use_type": ["Property Use Type", "SpecificUseType", "GeneralUseType", "Classification"],
    "land_value": ["Land Value", "LandValue", "Roll_LandValue"],
    "improvement_value": ["Improvement Value", "ImprovementValue", "Roll_ImpValue"],
    "total_value": ["Total Value", "TotalValue", "Roll_TotalValue", "Taxable Value", "TaxableValue"],
    "sale_date": ["Recording Date", "RecordingDate", "RECORDINGDATE", "SaleDate", "LastSaleDate"],
    "base_year": ["Improvement Base Year", "Land Base Year", "ImpBaseYear", "LandBaseYear"],
    "sqft": ["Square Footage", "SQFTmain", "SqFtMain", "BuildingSqFt", "MainSqFt"],
    "year_built": ["Year Built", "YearBuilt", "Effective Year", "EffectiveYearBuilt"],
    "units": ["Number of Units", "Units", "UnitsCount"],
    "ain": ["AIN", "Assessor ID", "APN", "ParcelID"],
    # Not present in the 2021-2025 export. Kept so a future roll that carries
    # lot area is picked up without a code change.
    "lot_sqft": ["Lot Size", "LotSizeSqFt", "Land Square Footage", "LandSqFt", "Shape__Area"],
    "roll_year": ["Roll Year", "RollYear", "TaxYear"],
    # For the per-sale detail table.
    "address": ["Property Location", "PropertyLocation", "Situs Address", "SitusAddress", "Address"],
    "exemption": ["Total Exemption", "TotalExemption", "Home Owners Exemption"],
    "total_only": ["Total Value", "TotalValue"],
}

# LA County use codes: the leading "01" is single-family residence. The text
# column is checked too, because some exports carry only that.
SFR_CODE_PREFIX = "01"
SFR_TEXT = "single family"

# Below this, a "sale" is a transfer rather than a market transaction: family
# quitclaims, corrections and $1 grants are all over the roll. It also catches
# the excluded transfers described above, which keep their old base value.
MIN_SALE_PRICE = 50000
# Above this it is almost always a bulk or portfolio transfer recorded against
# one parcel.
MAX_SALE_PRICE = 50000000
# A recently-transferred house should price somewhere in this range per square
# foot. Outside it, the parcel almost certainly kept an old base year value
# through an excluded transfer, so its "price" is decades stale.
MIN_PRICE_PER_SQFT = 100
MAX_PRICE_PER_SQFT = 3000


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
    text = str(row.get(cols.get("use_type"), "") or "").lower()
    if not (code.startswith(SFR_CODE_PREFIX) or SFR_TEXT in text):
        return False
    # A single-family parcel holds one unit. Where the roll says otherwise -
    # a duplex miscoded, or a lot with a second house on it - it is not the
    # thing being priced here.
    units = to_float(row.get(cols.get("units"))) if cols.get("units") else None
    return units is None or units <= 1


def assessed_value(row, cols):
    """
    Land + improvements: the property's full assessed value.

    Not "Taxable Value", which has exemptions already subtracted - the
    homeowners' exemption alone knocks $7,000 off and would bias every
    owner-occupied house downwards.
    """
    land = to_float(row.get(cols["land_value"])) if cols.get("land_value") else None
    imp = to_float(row.get(cols["improvement_value"])) if cols.get("improvement_value") else None
    if land is not None or imp is not None:
        return (land or 0) + (imp or 0)
    return to_float(row.get(cols["total_value"])) if cols.get("total_value") else None


def transfer_year(row, cols):
    """When this parcel's current value was set - by deed, else by base year."""
    year = sale_year(row.get(cols["sale_date"])) if cols.get("sale_date") else None
    if year:
        return year
    base = to_float(row.get(cols.get("base_year"))) if cols.get("base_year") else None
    return int(base) if base and 1900 < base < 2100 else None


def percentile(sorted_values, fraction):
    """Nearest-rank percentile. Small samples, so no interpolation games."""
    if not sorted_values:
        return None
    i = min(len(sorted_values) - 1, max(0, int(round(fraction * (len(sorted_values) - 1)))))
    return sorted_values[i]


def summarise(prices, ppsf, sfh_total, min_for_spread=5):
    prices = sorted(prices)
    row = {"n": len(prices), "median": round(statistics.median(prices))}
    # A 10th and 90th percentile drawn from three sales is just the smallest
    # and largest of three, dressed up as a distribution. Only report the
    # spread once there are enough sales for it to mean anything.
    if len(prices) >= min_for_spread:
        row["p10"] = round(percentile(prices, 0.10))
        row["p90"] = round(percentile(prices, 0.90))
    if ppsf:
        row["ppsf"] = round(statistics.median(sorted(ppsf)), 1)
    if sfh_total:
        row["turnover"] = round(100 * len(prices) / sfh_total, 2)
    return row


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--csv", default=DEFAULT_CSV, help="Assessor roll CSV")
    parser.add_argument("--out", default=DEFAULT_OUT, help="Output JSON path")
    parser.add_argument("--sales-out", default=DEFAULT_SALES_OUT, help="Per-sale detail JSON path")
    parser.add_argument(
        "--from-year",
        type=int,
        default=2021,
        help="Earliest transfer year to report (default 2021, the earliest roll in the county's export)",
    )
    parser.add_argument("--min-sales", type=int, default=3, help="Pooled medians under this are flagged thin")
    args = parser.parse_args()

    if not os.path.exists(args.csv):
        raise ParcelDataError(
            f"no roll at {args.csv}.\n"
            "  Download 'Assessor Parcel Data' as CSV from https://data.lacounty.gov (search 'Assessor'),\n"
            f"  save it as {DEFAULT_CSV}, or pass --csv with its path."
        )

    block_groups = fetch_block_groups()
    index, shapes = build_index(block_groups)

    print(f"\nReading {args.csv} (transfers from {args.from_year} onwards)...")

    # AIN -> block group, so a parcel is located once no matter how many roll
    # years it appears in. This doubles as the denominator: every distinct
    # single-family parcel seen, sold or not.
    ain_geoid = {}
    sfh_total = {}

    # (AIN, recording date) -> one transaction. The multi-year export carries
    # the same sale in several roll years, revalued about 2% each time, so the
    # EARLIEST roll year is kept: it is closest to the sale and least trended.
    transactions = {}

    read = sfr_rows = 0
    unplaced = 0
    stale = 0
    use_code_kept = {}
    use_code_dropped = {}

    with open(args.csv, newline="", encoding="utf-8-sig", errors="replace") as fh:
        reader = csv.DictReader(fh)
        header = reader.fieldnames or []
        cols = {}
        for key in ("lat", "lon", "use_code", "sale_date"):
            cols[key] = find_column(header, COLUMNS[key], key.replace("_", " "))
        for key in (
            "use_type", "land_value", "improvement_value", "total_value",
            "base_year", "sqft", "year_built", "units", "ain", "roll_year", "lot_sqft",
            "address", "exemption", "total_only",
        ):
            try:
                cols[key] = find_column(header, COLUMNS[key], key)
            except ParcelDataError:
                cols[key] = None  # optional

        if cols.get("land_value") and cols.get("improvement_value"):
            print("  Value basis: Land Value + Improvement Value")
        elif cols.get("total_value") and "taxable" not in cols["total_value"].lower():
            print(f"  Value basis: {cols['total_value']} (land and improvement columns not present)")
        elif cols.get("total_value"):
            print(
                f"  Value basis: {cols['total_value']} - WARNING: exemptions are already subtracted from this\n"
                "    column, so owner-occupied homes read about $7,000 low. Prefer a roll export that\n"
                "    carries Land Value and Improvement Value."
            )
        if not (cols.get("land_value") or cols.get("improvement_value") or cols.get("total_value")):
            raise ParcelDataError(
                "found no value column at all (land, improvement or total).\n"
                f"  The file has: {', '.join(sorted(header))}\n"
                "  Without one there is nothing to take a median of."
            )
        if not cols.get("ain"):
            raise ParcelDataError(
                "found no parcel id column (AIN).\n"
                "  Without it the same parcel cannot be recognised across roll years, and every count\n"
                "  would be inflated several times over."
            )
        if not cols.get("lot_sqft"):
            print("  Lot size: not in this export, so $/lot-sqft is omitted (see README).")
        print("  Matched columns: " + ", ".join(f"{k}={v}" for k, v in cols.items() if v))

        for row in reader:
            read += 1
            if read % 500000 == 0:
                print(f"    {read:,} rows read, {len(transactions):,} transactions, {len(ain_geoid):,} parcels located...")

            code = str(row.get(cols["use_code"], "") or "").strip()[:4]
            if not is_single_family(row, cols):
                use_code_dropped[code] = use_code_dropped.get(code, 0) + 1
                continue
            sfr_rows += 1
            use_code_kept[code] = use_code_kept.get(code, 0) + 1

            ain = str(row.get(cols["ain"]) or "").strip()
            if not ain:
                continue

            # Locate the parcel once, then reuse for every roll year it
            # appears in - the expensive part is the point-in-polygon.
            if ain in ain_geoid:
                geoid = ain_geoid[ain]
            else:
                lat = to_float(row.get(cols["lat"]))
                lon = to_float(row.get(cols["lon"]))
                geoid = None
                if lat is not None and lon is not None and 32 < lat < 36 and -120 < lon < -116:
                    geoid = locate(lon, lat, index, shapes)
                ain_geoid[ain] = geoid
                if geoid:
                    sfh_total[geoid] = sfh_total.get(geoid, 0) + 1
                else:
                    unplaced += 1
            if geoid is None:
                continue

            price = assessed_value(row, cols)
            if price is None or price < MIN_SALE_PRICE or price > MAX_SALE_PRICE:
                continue
            year = transfer_year(row, cols)
            if year is None or year < args.from_year:
                continue

            sqft_value = to_float(row.get(cols["sqft"])) if cols.get("sqft") else None
            if sqft_value and sqft_value > 200:
                ppsf = price / sqft_value
                if ppsf < MIN_PRICE_PER_SQFT or ppsf > MAX_PRICE_PER_SQFT:
                    stale += 1
                    continue

            roll = to_float(row.get(cols.get("roll_year"))) or 0
            recorded = str(row.get(cols["sale_date"]) or "").strip()
            key = (ain, recorded)
            existing = transactions.get(key)
            if existing is None or roll < existing[0]:
                detail = {
                    "address": str(row.get(cols["address"]) or "").strip() if cols.get("address") else "",
                    "recorded": recorded,
                    "sqft": sqft_value,
                    "land": to_float(row.get(cols["land_value"])) if cols.get("land_value") else None,
                    "improvement": to_float(row.get(cols["improvement_value"])) if cols.get("improvement_value") else None,
                    "exemption": to_float(row.get(cols["exemption"])) if cols.get("exemption") else None,
                    "total": to_float(row.get(cols["total_only"])) if cols.get("total_only") else None,
                    "yearBuilt": to_float(row.get(cols["year_built"])) if cols.get("year_built") else None,
                }
                transactions[key] = (roll, price, sqft_value, geoid, year, detail)

    def top_codes(counter):
        return ", ".join(f"{code or '(blank)'}: {n:,}" for code, n in sorted(counter.items(), key=lambda kv: -kv[1])[:6])

    print(f"\n  Use codes KEPT as single-family: {top_codes(use_code_kept) or 'none'}")
    print(f"  Use codes dropped (top few):     {top_codes(use_code_dropped) or 'none'}")
    if stale:
        print(f"  {stale:,} transfers dropped as stale values (excluded transfers, no reassessment)")

    if not transactions:
        raise ParcelDataError(
            f"read {read:,} rows and found {sfr_rows:,} single-family rows, but no usable transfers.\n"
            "  The matched columns and use codes are printed above - check them against the file."
        )

    # --- Aggregate: per block group, per year --------------------------------
    by_bg = {}
    county_year_prices = {}
    sales_rows = {}
    for roll, price, sqft_value, geoid, year, detail in transactions.values():
        # Rows are arrays, not objects: repeating seven key names across a
        # quarter of a million sales triples the file for no information.
        # The order is declared in the file's meta.
        sales_rows.setdefault(geoid, {}).setdefault(str(year), []).append(
            [
                detail["address"],
                detail["recorded"],
                detail["sqft"],
                detail["land"],
                detail["improvement"],
                detail["exemption"],
                detail["total"] if detail["total"] is not None else round(price),
                detail["yearBuilt"],
            ]
        )

        bucket = by_bg.setdefault(geoid, {})
        entry = bucket.setdefault(year, {"prices": [], "ppsf": []})
        entry["prices"].append(price)
        if sqft_value and sqft_value > 200:
            entry["ppsf"].append(price / sqft_value)
        county_year_prices.setdefault(year, []).append(price)

    records = {}
    for geoid, per_year in by_bg.items():
        total_parcels = sfh_total.get(geoid, 0)
        all_prices = []
        all_ppsf = []
        years_out = {}
        for year, entry in sorted(per_year.items()):
            years_out[str(year)] = summarise(entry["prices"], entry["ppsf"], total_parcels)
            all_prices.extend(entry["prices"])
            all_ppsf.extend(entry["ppsf"])

        pooled = summarise(all_prices, all_ppsf, total_parcels)
        records[geoid] = {
            # Pooled across every year, kept under the old names so the map's
            # filters and the card's headline number keep working.
            "medianSalePrice": pooled["median"],
            "saleCount": pooled["n"],
            "thin": pooled["n"] < args.min_sales,
            "sfhTotal": total_parcels,
            "years": years_out,
        }
        if "ppsf" in pooled:
            records[geoid]["medianPricePerSqft"] = pooled["ppsf"]

    county_by_year = {
        str(year): {"n": len(prices), "median": round(statistics.median(prices))}
        for year, prices in sorted(county_year_prices.items())
    }

    payload = {
        "meta": {
            "schemaVersion": 2,
            "source": "LA County Assessor parcel roll (assessed value at last transfer)",
            "basis": "assessed-at-transfer",
            "sourceFile": os.path.basename(args.csv),
            "salesFrom": args.from_year,
            "generated": datetime.date.today().isoformat(),
            "minSalePrice": MIN_SALE_PRICE,
            "hasLotSize": bool(cols.get("lot_sqft")),
            "countyByYear": county_by_year,
            "note": (
                "Per-year medians of assessed value for single-family parcels whose deed was "
                f"recorded that year, from {args.from_year} on. Proposition 13 resets a "
                "property's assessed value to its purchase price on sale, so for the year it "
                "changed hands the two are approximately the same figure. The county's "
                "multi-year roll export is what makes a year-by-year table possible at all: "
                "each roll year records the transfers known at that point, so stacking them "
                "recovers sales that a single roll would have overwritten."
            ),
        },
        "blockGroups": records,
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))

    sales_payload = {
        "meta": {
            "schemaVersion": 1,
            "columns": ["address", "recorded", "sqft", "land", "improvement", "exemption", "total", "yearBuilt"],
            "source": payload["meta"]["source"],
            "generated": payload["meta"]["generated"],
            "note": (
                "One row per single-family transfer, behind the counts in the summary file. "
                "Values are the assessed land and improvement figures set at that transfer; "
                "exemption is what is subtracted from them to reach the taxable value, so "
                "land + improvement - exemption is what the county taxes."
            ),
        },
        "byBlockGroup": sales_rows,
    }
    with open(args.sales_out, "w", encoding="utf-8") as fh:
        json.dump(sales_payload, fh, separators=(",", ":"))

    medians = sorted(r["medianSalePrice"] for r in records.values())

    def pct(p):
        return medians[min(len(medians) - 1, int(len(medians) * p))]

    print(f"\nWrote {args.out} ({os.path.getsize(args.out) / 1024:.0f} KB)")
    print(f"Wrote {args.sales_out} ({os.path.getsize(args.sales_out) / 1024 / 1024:.1f} MB, loaded only when a count is clicked)")
    print(f"  {read:,} rows read, {sfr_rows:,} single-family rows")
    print(f"  {len(ain_geoid):,} distinct single-family parcels, {len(transactions):,} distinct transfers since {args.from_year}")
    print(f"  {len(records):,} block groups have at least one transfer")
    if unplaced:
        print(f"  {unplaced:,} parcels fell outside every LA County block group (county edge, bad coordinates)")
    print("\n  Transfers per year, county-wide (2025 is short because those sales land in the 2026 roll):")
    for year, row in county_by_year.items():
        print(f"    {year}: {row['n']:>7,} transfers, median ${row['median']:,}")
    print(
        f"\n  Median of the block group medians: ${pct(0.5):,}"
        f"  (5th pct ${pct(0.05):,}, 95th pct ${pct(0.95):,})"
    )
    print(f"  Full range ${medians[0]:,} to ${medians[-1]:,} - check the tails look like real LA prices")
    print(
        "\nNote: values are as assessed in the roll year nearest the sale, so they sit within"
        "\na percent or two of the actual price (Prop 13 trends a base value up ~2% a year)."
    )
    print("\nReload blockgroups.html - the card gains a year-by-year Home prices table.")


if __name__ == "__main__":
    try:
        main()
    except ParcelDataError as err:
        print(f"\nCould not build the parcel data: {err}\n", file=sys.stderr)
        sys.exit(1)
