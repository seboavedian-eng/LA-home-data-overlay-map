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
cols = {"use_code": "PropertyUseCode", "specific_use": "SpecificUseType"}
check(
    "use code 0100 counts as single family",
    fetch_parcel.is_single_family({"PropertyUseCode": "0100", "SpecificUseType": ""}, cols),
)
check(
    "a condo use code does not",
    not fetch_parcel.is_single_family({"PropertyUseCode": "0500", "SpecificUseType": "Condominium"}, cols),
)
check(
    "the text field alone is enough when the code is missing",
    fetch_parcel.is_single_family({"PropertyUseCode": "", "SpecificUseType": "Single Family Residence"}, cols),
)
check(
    "an apartment building is excluded",
    not fetch_parcel.is_single_family({"PropertyUseCode": "0300", "SpecificUseType": "Five or more units"}, cols),
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
    "columns are found by exact name",
    fetch_parcel.find_column(header, fetch_parcel.COLUMNS["lat"], "lat") == "CENTER_LAT",
)
check(
    "matching is case-insensitive, as exports vary",
    fetch_parcel.find_column(["center_lat"], fetch_parcel.COLUMNS["lat"], "lat") == "center_lat",
)
try:
    fetch_parcel.find_column(["Foo", "Bar"], fetch_parcel.COLUMNS["sale_price"], "sale price")
    check("a missing column is reported with the file's real headers", False)
except fetch_parcel.ParcelDataError as err:
    check(
        "a missing column is reported with the file's real headers",
        "Foo" in str(err) and "SalePrice" in str(err),
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

print(f"\n{len(failures) and 'FAILURES: ' + ', '.join(failures) or 'All checks passed.'}")
sys.exit(1 if failures else 0)
