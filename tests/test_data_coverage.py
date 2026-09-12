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

# The three origin tables are merged into one ranking, so the fields the page
# reads are fixed names rather than one per table.
listed = re.findall(r'\(\s*"(B\d{5})"\s*,', census)
check(
    "all three detailed-origin tables are listed for fetching",
    set(listed) >= {"B03001", "B02015", "B04006"},
    ", ".join(sorted(set(listed))),
)
merged_fields = ["originTop", "originTopTotal", "originTopGeo", "originTopSource"]
unused_merged = [f for f in merged_fields if f not in census or not mentioned(f)]
check(
    "the merged ranking is written by the script and read by the page",
    not unused_merged,
    ", ".join(unused_merged) if unused_merged else ", ".join(merged_fields),
)
check(
    "the per-table origin fields are gone - one ranking, not three",
    not any(f in census for f in ("originHispanic", "originAsian", "originAncestry")),
    "the question was one top five across all three tables",
)

# Variable codes for these tables must not be written out by hand: they cannot
# be verified without asking the API, one wrong code fails the whole request,
# and the table is then skipped with nothing on the card to say so.
# B03002's eight codes stay written out - they are few, stable, and proven.
# These three are the ones with a hundred-odd codes each that cannot be checked.
hardcoded = re.findall(r'"(B03001|B02015|B04006)_\d+E"', census)
check(
    "detailed-origin variable codes are discovered, not hardcoded",
    not hardcoded,
    ", ".join(hardcoded[:5]) if hardcoded else "read from the API's own table description",
)
check(
    "a table that fails to fetch is recorded for the page to explain",
    '"originTables"' in census and "originTables" in page,
    "meta.originTables",
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

# --- No function may shadow one of its module's helpers ----------------------
# `total = ...` inside main() makes Python treat the module-level total()
# helper as a local for the WHOLE function, so an earlier call to it raises
# UnboundLocalError. It cost a ten-minute download to find out.
import ast  # noqa: E402 - kept beside the check it serves

for script in sorted(f for f in os.listdir(os.path.join(ROOT, "scripts")) if f.endswith(".py")):
    tree = ast.parse(read("scripts", script))
    helpers = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    clashes = []
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef):
            continue
        for sub in ast.walk(node):
            if isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Store) and sub.id in helpers:
                clashes.append(f"{node.name}() binds {sub.id}")
    check(
        f"{script}: no local shadows a module-level function",
        not clashes,
        "; ".join(sorted(set(clashes))) if clashes else f"{len(helpers)} helpers checked",
    )

print()
if failures:
    print(f"{len(failures)} FAILURE(S): " + ", ".join(failures))
    sys.exit(1)
print("All checks passed.")
