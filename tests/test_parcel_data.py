#!/usr/bin/env python3
"""
Offline checks for scripts/fetch-parcel-data.py.

The real roll is a gigabyte and cannot live in the repo, so these build small
synthetic ones and check the parts that decide whether the output number means
anything: which parcels count as single-family, which sales are real
transactions rather than family transfers, how a recording date is read, and
whether a point lands in the right block group.

Run: python3 tests/test_parcel_data.py     (no network, no download)
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.normpath(os.path.join(HERE, "..", "scripts", "fetch-parcel-data.py"))
spec = importlib.util.spec_from_file_location("fetch_parcel", SCRIPT)
fetch_parcel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch_parcel)

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} - {name}" + (f" :: {detail}" if detail else ""))
    if not ok:
        failures.append(name)


# --- Single-family detection ------------------------------------------------
# Column names as the 2025 roll writes them: spaced, not CamelCase.
cols = {
    "use_code": "Property Use Code",
    "use_type": "Property Use Type",
    "units": "Number of Units",
    "land_value": "Land Value",
    "improvement_value": "Improvement Value",
    "total_value": "Taxable Value",
    "sale_date": "Recording Date",
    "base_year": "Improvement Base Year",
    "sqft": "Square Footage",
}


def parcel(**kw):
    row = {
        "Property Use Code": "0100",
        "Property Use Type": "Single Family Residence",
        "Number of Units": "1",
        "Land Value": "600000",
        "Improvement Value": "400000",
        "Recording Date": "20240115",
    }
    row.update(kw)
    return row


check("use code 0100 counts as single family", fetch_parcel.is_single_family(parcel(), cols))
check(
    "a condo use code does not",
    not fetch_parcel.is_single_family(
        parcel(**{"Property Use Code": "0500", "Property Use Type": "Condominium"}), cols
    ),
)
check(
    "the text column alone is enough when the code is blank",
    fetch_parcel.is_single_family(parcel(**{"Property Use Code": ""}), cols),
)
check(
    "an apartment building is excluded",
    not fetch_parcel.is_single_family(
        parcel(**{"Property Use Code": "0300", "Property Use Type": "Five or more units"}), cols
    ),
)
check(
    "a parcel with several units is not single family even if coded 01xx",
    not fetch_parcel.is_single_family(parcel(**{"Number of Units": "3"}), cols),
    "duplexes and lots with a second house are not the thing being priced",
)
check(
    "a missing unit count does not disqualify a parcel",
    fetch_parcel.is_single_family(parcel(**{"Number of Units": ""}), cols),
)

# --- The Prop 13 reconstruction ---------------------------------------------
# The public roll carries no sale price. Assessed value is land + improvements,
# and it approximates the purchase price only for a recently-transferred house.
check(
    "assessed value is land plus improvements",
    fetch_parcel.assessed_value(parcel(), cols) == 1000000,
    str(fetch_parcel.assessed_value(parcel(), cols)),
)
check(
    "taxable value is used only when land and improvements are missing",
    fetch_parcel.assessed_value(
        {"Taxable Value": "993000"}, {"total_value": "Taxable Value"}
    ) == 993000,
    "taxable value has the homeowners' exemption already subtracted, so it is the fallback",
)
check(
    "the transfer year comes from the recording date",
    fetch_parcel.transfer_year(parcel(), cols) == 2024,
    str(fetch_parcel.transfer_year(parcel(), cols)),
)
check(
    "with no recording date it falls back to the base year",
    fetch_parcel.transfer_year(
        parcel(**{"Recording Date": "", "Improvement Base Year": "2022"}), cols
    ) == 2022,
)
check(
    "a parcel with neither is skipped rather than assumed recent",
    fetch_parcel.transfer_year(parcel(**{"Recording Date": ""}), cols) is None,
)
check(
    "the price-per-sqft band is wide enough for LA but excludes stale values",
    fetch_parcel.MIN_PRICE_PER_SQFT <= 100 and fetch_parcel.MAX_PRICE_PER_SQFT >= 2000,
    f"${fetch_parcel.MIN_PRICE_PER_SQFT}-${fetch_parcel.MAX_PRICE_PER_SQFT}/sqft",
)

# --- Recording dates --------------------------------------------------------
# The roll writes these three ways depending on the export.
check("YYYYMMDD parses", fetch_parcel.sale_year("20240115") == 2024, str(fetch_parcel.sale_year("20240115")))
check("ISO parses", fetch_parcel.sale_year("2023-07-02") == 2023, str(fetch_parcel.sale_year("2023-07-02")))
check("US format parses", fetch_parcel.sale_year("01/15/2022") == 2022, str(fetch_parcel.sale_year("01/15/2022")))
check("an empty date is not a year", fetch_parcel.sale_year("") is None)
check("junk is not a year", fetch_parcel.sale_year("N/A") is None)

# --- Money ------------------------------------------------------------------
check("currency formatting is stripped", fetch_parcel.to_float("$1,250,000") == 1250000.0)
check("blank is not zero", fetch_parcel.to_float("") is None)
check(
    "the transfer floor is high enough to exclude a $1 quitclaim",
    fetch_parcel.MIN_SALE_PRICE > 1000,
    f"${fetch_parcel.MIN_SALE_PRICE:,}",
)

# --- Column matching --------------------------------------------------------
header = ["AIN", "CENTER_LAT", "CENTER_LON", "PropertyUseCode", "SalePrice", "RecordingDate"]
check(
    "older CamelCase rolls still match",
    fetch_parcel.find_column(header, fetch_parcel.COLUMNS["lat"], "lat") == "CENTER_LAT",
)
check(
    "matching is case-insensitive, as exports vary",
    fetch_parcel.find_column(["center_lat"], fetch_parcel.COLUMNS["lat"], "lat") == "center_lat",
)
check(
    "the 2025 roll's spaced column names are matched",
    fetch_parcel.find_column(["Location Latitude"], fetch_parcel.COLUMNS["lat"], "lat") == "Location Latitude"
    and fetch_parcel.find_column(["Property Use Code"], fetch_parcel.COLUMNS["use_code"], "use code") == "Property Use Code"
    and fetch_parcel.find_column(["Recording Date"], fetch_parcel.COLUMNS["sale_date"], "date") == "Recording Date",
)
try:
    fetch_parcel.find_column(["Foo", "Bar"], fetch_parcel.COLUMNS["use_code"], "use code")
    check("a missing column is reported with the file's real headers", False)
except fetch_parcel.ParcelDataError as err:
    check(
        "a missing column is reported with the file's real headers",
        "Foo" in str(err) and "Property Use Code" in str(err),
        str(err).split("\n")[0],
    )

# --- Point in polygon, including holes and winding --------------------------
# Two block groups side by side, the left one with a hole punched in it - the
# Esri convention is clockwise outer ring, counter-clockwise hole.
left_outer = [[-118.30, 34.00], [-118.30, 34.10], [-118.20, 34.10], [-118.20, 34.00], [-118.30, 34.00]]
left_hole = [[-118.28, 34.02], [-118.26, 34.02], [-118.26, 34.04], [-118.28, 34.04], [-118.28, 34.02]]
right_outer = [[-118.20, 34.00], [-118.20, 34.10], [-118.10, 34.10], [-118.10, 34.00], [-118.20, 34.00]]

check("outer rings read as clockwise", fetch_parcel.ring_is_clockwise(left_outer))
check("holes read as counter-clockwise", not fetch_parcel.ring_is_clockwise(left_hole))

block_groups = {"060372011001": [left_outer, left_hole], "060372011002": [right_outer]}
index, shapes = fetch_parcel.build_index(block_groups)

check(
    "a parcel in the left block group is placed there",
    fetch_parcel.locate(-118.25, 34.05, index, shapes) == "060372011001",
    str(fetch_parcel.locate(-118.25, 34.05, index, shapes)),
)
check(
    "a parcel in the right block group is placed there, not the left",
    fetch_parcel.locate(-118.15, 34.05, index, shapes) == "060372011002",
    str(fetch_parcel.locate(-118.15, 34.05, index, shapes)),
)
check(
    "a parcel inside the hole belongs to no block group",
    fetch_parcel.locate(-118.27, 34.03, index, shapes) is None,
    str(fetch_parcel.locate(-118.27, 34.03, index, shapes)),
)
check(
    "a parcel outside the county is not forced into one",
    fetch_parcel.locate(-117.00, 34.05, index, shapes) is None,
)

# --- End to end, including the multi-year roll trap --------------------------
# The county's "rolls 2021 to present" export stacks every roll year, so one
# parcel appears once per year - the same house, revalued ~2% annually.
# Counted as-is, a 2023 sale lands in the median three times and a 2025 sale
# once, which both inflates the counts and weights the result toward older,
# cheaper sales.
import csv as _csv
import tempfile as _tempfile
import json as _json

tmp = _tempfile.mkdtemp()
csv_path = os.path.join(tmp, "roll.csv")
out_path = os.path.join(tmp, "out.json")

FIELDS = [
    "AIN", "Roll Year", "Property Use Code", "Property Use Type", "Number of Units",
    "Land Value", "Improvement Value", "Recording Date", "Square Footage",
    "Location Latitude", "Location Longitude", "Year Built",
]


def row(ain, roll, land, imp, lat=34.05, lon=-118.25, recorded="20240115", sqft="1500", use="0100"):
    return {
        "AIN": ain, "Roll Year": roll, "Property Use Code": use,
        "Property Use Type": "Single Family Residence" if use.startswith("01") else "Condominium",
        "Number of Units": "1",
        "Land Value": land, "Improvement Value": imp, "Recording Date": recorded,
        "Square Footage": sqft, "Location Latitude": lat, "Location Longitude": lon,
        "Year Built": "1955",
    }


with open(csv_path, "w", newline="", encoding="utf-8") as fh:
    writer = _csv.DictWriter(fh, fieldnames=FIELDS)
    writer.writeheader()
    # One house, three roll years, trending up. Only the newest should count.
    writer.writerow(row("111", "2023", "500000", "500000"))
    writer.writerow(row("111", "2024", "510000", "510000"))
    writer.writerow(row("111", "2025", "520000", "520000"))
    # A second house in the same block group, one roll year.
    writer.writerow(row("222", "2025", "1000000", "1000000"))
    # A condo: excluded by use code.
    writer.writerow(row("333", "2025", "400000", "400000", use="0500"))
    # A long-held house: recorded in 1994, so not a recent transfer.
    writer.writerow(row("444", "2025", "60000", "40000", recorded="19940301"))
    # A house in the second block group.
    writer.writerow(row("555", "2025", "300000", "300000", lat=34.05, lon=-118.15))

# The polygons the parcels are binned into, standing in for TIGERweb.
fetch_parcel.fetch_block_groups = lambda: {
    "060372011001": [left_outer],
    "060372011002": [right_outer],
}

argv = sys.argv
sys.argv = ["fetch-parcel-data.py", "--csv", csv_path, "--out", out_path, "--years", 3 and "3"]
try:
    fetch_parcel.main()
finally:
    sys.argv = argv

with open(out_path, encoding="utf-8") as fh:
    result = _json.load(fh)

bg1 = result["blockGroups"].get("060372011001", {})
bg2 = result["blockGroups"].get("060372011002", {})

check(
    "a parcel repeated across roll years counts once, not three times",
    bg1.get("saleCount") == 2,
    f"saleCount={bg1.get('saleCount')} (two houses: AIN 111 and 222)",
)
check(
    "the newest roll year's value is the one kept",
    # AIN 111 -> 1,040,000 (2025 row), AIN 222 -> 2,000,000; median of the two.
    bg1.get("medianSalePrice") == 1520000,
    f"median={bg1.get('medianSalePrice')} - the 2025 row for AIN 111 is $1,040,000, not the 2023 row's $1,000,000",
)
check("the condo is excluded", bg1.get("saleCount") != 3)
check(
    "a house last sold in 1994 is not treated as a recent transfer",
    bg1.get("saleCount") == 2,
)
check("the second block group is kept separate", bg2.get("saleCount") == 1, str(bg2))
check(
    "the payload records what the number actually is",
    "Proposition 13" in result["meta"]["note"],
    result["meta"].get("basis"),
)

print(f"\n{len(failures) and 'FAILURES: ' + ', '.join(failures) or 'All checks passed.'}")
sys.exit(1 if failures else 0)
