#!/usr/bin/env python3
"""
Every field we bother to fetch must actually reach a card.

This exists because the same failure kept happening: a value computed in a
fetch script, written into the data file, and never rendered - B15001's degree
share, the renter-occupied count, the build-decade bins, beds and baths on a
sale, a listing's lastSeen. None of them broke anything, so nothing complained.
The data was just quietly absent from the page.

So the rule is checked rather than remembered: if a script emits a field, the
page has to mention it. Add a field without wiring it up and this fails.

Run: python3 tests/test_data_coverage.py
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

failures = []


def check(name, ok, detail=""):
    print(("PASS - " if ok else "FAIL - ") + name + (f" :: {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
        return fh.read()


page = read("js", "blockgroups.js")


def mentioned(field):
    """The page refers to this field somewhere - as .field or "field"."""
    return re.search(r"\.%s\b|[\"']%s[\"']" % (re.escape(field), re.escape(field)), page) is not None


# --- Block group demographics ------------------------------------------------
census = read("scripts", "fetch-blockgroup-data.py")
census_fields = sorted(set(re.findall(r'rec\["([A-Za-z0-9]+)"\]', census)))
check(
    "the census script emits a recognisable set of fields",
    len(census_fields) >= 30,
    f"{len(census_fields)} fields",
)
unused = [f for f in census_fields if not mentioned(f)]
check(
    "every block group field the census script writes reaches the page",
    not unused,
    ", ".join(unused) if unused else f"all {len(census_fields)} used",
)

# Fields written through a variable key (the detailed-origin tables) are named
# at the call site instead, so they are listed explicitly.
dynamic = re.findall(r'top_groups\([^,]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*"([A-Za-z0-9]+)"', census)
check("the detailed-origin tables are wired up", len(dynamic) == 3, ", ".join(dynamic))
unused_dynamic = [f for f in dynamic if not mentioned(f)]
check(
    "every detailed-origin field reaches the page",
    not unused_dynamic,
    ", ".join(unused_dynamic) if unused_dynamic else "all used",
)

# --- Parcel prices -----------------------------------------------------------
parcel = read("scripts", "fetch-parcel-data.py")
parcel_fields = ["medianSalePrice", "saleCount", "thin", "sfhTotal", "years", "medianPricePerSqft"]
unused_parcel = [f for f in parcel_fields if not mentioned(f)]
check(
    "every parcel summary field reaches the page",
    not unused_parcel,
    ", ".join(unused_parcel) if unused_parcel else "all used",
)

per_year = ["p10", "p90", "ppsf", "turnover"]
unused_year = [f for f in per_year if not mentioned(f)]
check(
    "every per-year price figure reaches the page",
    not unused_year,
    ", ".join(unused_year) if unused_year else "all used",
)

# --- The sales detail table --------------------------------------------------
# Rows are arrays, so a column is "used" when its index is read.
columns = re.search(r'"columns":\s*\[(.*?)\]', parcel, re.DOTALL)
if not columns:
    columns = re.search(r'"columns":\s*\[(.*?)\],', parcel.replace("\n", " "))
names = re.findall(r'"([a-zA-Z]+)"', columns.group(1)) if columns else []
check("the sales file declares its columns", len(names) >= 8, ", ".join(names))
unrendered = [f"{i} ({n})" for i, n in enumerate(names) if f"r[{i}]" not in page]
check(
    "every column of the sales file is rendered in the sales table",
    not unrendered,
    ", ".join(unrendered) if unrendered else f"all {len(names)} rendered",
)

# --- Listings ----------------------------------------------------------------
block = re.search(r"listings\.push\(\{(.*?)\n      \}\);", page, re.DOTALL)
listing_fields = re.findall(r"^\s{8}([a-zA-Z]+)[,:]", block.group(1), re.MULTILINE) if block else []
check("the listing parser has a recognisable shape", len(listing_fields) >= 15, f"{len(listing_fields)} fields")
unused_listing = [f for f in listing_fields if not re.search(r"listing\.%s\b" % f, page)]
check(
    "every listing field parsed out of a Redfin export is used",
    not unused_listing,
    ", ".join(unused_listing) if unused_listing else f"all {len(listing_fields)} used",
)

# --- Rows are built one way --------------------------------------------------
raw_rows = page.count('<tr><td class="k">')
check(
    "card rows are built through the one helper, not by hand",
    raw_rows == 1,
    f"{raw_rows} raw row template(s) - only cardRow's own should remain",
)
raw_labels = page.count('class="section-label"')
check(
    "section headings go through their helper too",
    raw_labels == 1,
    f"{raw_labels} raw label template(s)",
)
check(
    "the row helper requires a source",
    "was built without a source explanation" in page,
    "cardRow reports a missing tip",
)

print()
if failures:
    print(f"{len(failures)} FAILURE(S): " + ", ".join(failures))
    sys.exit(1)
print("All checks passed.")
