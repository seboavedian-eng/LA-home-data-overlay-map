#!/usr/bin/env python3
"""
Offline checks for scripts/fetch-blockgroup-data.py's URL construction.

These need no network, which matters: the whole script failed in the field
because every URL it built encoded spaces as "+" instead of "%20". The
Census API answers a "+" query with an empty HTTP 200 body rather than an
error, so nothing surfaced until a human read the output. A unit check on
the URL itself catches that class of bug without hitting the API at all.

Run: python3 tests/test_fetch_urls.py
"""

import importlib.util
import os
import sys

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts", "fetch-blockgroup-data.py")
spec = importlib.util.spec_from_file_location("fetch_bg", os.path.normpath(SCRIPT))
fetch_bg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch_bg)

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} - {name}" + (f" :: {detail}" if detail else ""))
    if not ok:
        failures.append(name)


ACS = "https://api.census.gov/data/2022/acs/acs5"

bg_url = fetch_bg.build_url(ACS, ["NAME", "B01001_001E"], "block group", "")
tract_url = fetch_bg.build_url(ACS, ["NAME", "B01001_001E"], "tract", "")
keyed_url = fetch_bg.build_url(ACS, ["NAME"], "block group", "abc123")

check("block group URL encodes spaces as %20, never +", "%20" in bg_url and "+" not in bg_url, bg_url)
check("tract URL encodes spaces as %20, never +", "%20" in tract_url and "+" not in tract_url, tract_url)
check("block group URL asks for the right geography", "for=block%20group:*" in bg_url, bg_url)
check(
    "block group URL nests under state, county and tract",
    "in=state:06%20county:037%20tract:*" in bg_url,
    bg_url,
)
# Note: `for=tract:*` legitimately contains "tract:*", so this has to look at
# the `in` clause specifically rather than the whole URL.
check(
    "tract URL nests under state and county only, with no tract wildcard",
    tract_url.split("&in=")[1] == "state:06%20county:037",
    tract_url.split("&in=")[1],
)
check("commas between variables stay literal", "get=NAME,B01001_001E" in bg_url, bg_url)
check("colons and asterisks stay literal", ":*" in bg_url and "%3A" not in bg_url, bg_url)
check("API key is passed through when supplied", "key=abc123" in keyed_url, keyed_url)
check("no key parameter when none is supplied", "key=" not in bg_url, bg_url)

# The variable list must stay under the API's 50-per-request cap.
b01001 = fetch_bg.b01001_variables()
check(f"B01001 chunk size stays under the API's 50-variable cap ({fetch_bg.CHUNK_SIZE})", fetch_bg.CHUNK_SIZE < 50)
check(
    "B01001 request covers male and female for every age bracket",
    len(b01001) == 3 + 2 * len(fetch_bg.B01001_BRACKETS),
    f"{len(b01001)} variables for {len(fetch_bg.B01001_BRACKETS)} brackets",
)
check(
    "all 23 B01001 age brackets are captured",
    len(fetch_bg.B01001_BRACKETS) == 23 and set(fetch_bg.B01001_BRACKETS) == set(range(3, 26)),
    sorted(fetch_bg.B01001_BRACKETS),
)
check(
    "female variables are offset 24 from male, per B01001's layout",
    all(f"B01001_{i + 24:03d}E" in b01001 for i in fetch_bg.B01001_BRACKETS),
)

# Census uses large negative sentinels for suppressed values.
check("negative sentinel values become None", fetch_bg.to_number("-666666666") is None)
check("normal values parse", fetch_bg.to_number("1234") == 1234)
check("empty values become None", fetch_bg.to_number(None) is None)



# --- Detailed origin: variable discovery -------------------------------------
# The codes for B03001, B02015 and B04006 used to be written out by hand. They
# were wrong, one bad code failed the whole request, the table was skipped, and
# the section vanished from the card without a word. They are now read from the
# API's own description of each table, so these check the parsing of that.

check(
    "a leaf's label is its own name, not the whole path",
    fetch_bg.short_label("Estimate!!Total:!!Arab:!!Lebanese") == "Lebanese",
    fetch_bg.short_label("Estimate!!Total:!!Arab:!!Lebanese"),
)
check(
    "a group directly under the total keeps its name",
    fetch_bg.short_label("Estimate!!Total:!!Armenian") == "Armenian",
    fetch_bg.short_label("Estimate!!Total:!!Armenian"),
)
check(
    "B02015's 'alone or in any combination' qualifier is trimmed",
    fetch_bg.short_label("Estimate!!Total:!!Korean alone or in any combination") == "Korean",
    fetch_bg.short_label("Estimate!!Total:!!Korean alone or in any combination"),
)
check(
    "...and the plain 'alone' form too",
    fetch_bg.short_label("Estimate!!Total:!!Chinese alone") == "Chinese",
    fetch_bg.short_label("Estimate!!Total:!!Chinese alone"),
)
check("the total itself has no name", fetch_bg.short_label("Estimate!!Total:") is None)
check(
    "a parent category is not a leaf",
    not fetch_bg.is_leaf("Estimate!!Total:!!Arab:") and fetch_bg.is_leaf("Estimate!!Total:!!Arab:!!Lebanese"),
    "parents end in a colon; counting both would double the total",
)
for junk in ("Not Hispanic or Latino", "Other groups", "Unclassified or not reported", "Two or more ancestries"):
    check(
        f"'{junk}' is kept out of the top five",
        bool(fetch_bg.ORIGIN_SKIP.match(junk)),
        "it is a complement or a catch-all, not an origin",
    )
check(
    "a real origin is not caught by that filter",
    not any(fetch_bg.ORIGIN_SKIP.match(n) for n in ("Armenian", "Iranian", "Mexican", "Korean", "Nicaraguan")),
)



# --- The whole discovery, against a table description shaped like the real one
# This is the step that was guessed before. It runs offline against a stub of
# the API's groups endpoint, so a change to the parsing cannot quietly produce
# an empty group list again - which is what made the section disappear.
_FAKE_GROUPS = {
    "variables": {
        "B04006_001E": {"label": "Estimate!!Total:"},
        "B04006_001M": {"label": "Margin of Error!!Total:"},
        "B04006_002E": {"label": "Estimate!!Total:!!Afghan"},
        "B04006_003E": {"label": "Estimate!!Total:!!Armenian"},
        "B04006_004E": {"label": "Estimate!!Total:!!Arab:"},
        "B04006_005E": {"label": "Estimate!!Total:!!Arab:!!Lebanese"},
        "B04006_006E": {"label": "Estimate!!Total:!!Arab:!!Syrian"},
        "B04006_007E": {"label": "Estimate!!Total:!!Other groups"},
        "B04006_008E": {"label": "Estimate!!Total:!!Unclassified or not reported"},
    }
}

_original_fetch_json = fetch_bg.fetch_json
fetch_bg.fetch_json = lambda url: _FAKE_GROUPS
groups = fetch_bg.fetch_group_variables("https://example.invalid", "B04006")
fetch_bg.fetch_json = _original_fetch_json

check(
    "every leaf group is discovered, with a readable name",
    groups == {
        "B04006_002E": "Afghan",
        "B04006_003E": "Armenian",
        "B04006_005E": "Lebanese",
        "B04006_006E": "Syrian",
    },
    str(groups),
)
check("the table total is not treated as a group", "B04006_001E" not in groups)
check("margins of error are ignored", not any(c.endswith("M") for c in groups))
check("the parent 'Arab:' is skipped, its children are kept", "B04006_004E" not in groups)
check("catch-alls are dropped", "B04006_007E" not in groups and "B04006_008E" not in groups)

fetch_bg.fetch_json = lambda url: (_ for _ in ()).throw(RuntimeError("503"))
broken = fetch_bg.fetch_group_variables("https://example.invalid", "B04006")
fetch_bg.fetch_json = _original_fetch_json
check(
    "an unreadable variable list returns nothing rather than raising",
    broken == {},
    "the caller reports a skipped table instead of the run dying",
)


# --- A response can succeed and still be empty -------------------------------
# B03001, B02015 and B04006 are published at TRACT level. The API does not
# refuse them at block group: it accepts the query and answers nulls for every
# row. Treating that as success is what made the card say nobody here had an
# ancestry, for every block group in the county.
empty_rows = {"060372011001": {"B04006_001E": "1500", "B04006_002E": None, "B04006_003E": ""}}
full_rows = {"060372011001": {"B04006_001E": "1500", "B04006_002E": "120", "B04006_003E": ""}}
check(
    "a response of nothing but nulls does not count as having values",
    not fetch_bg.has_any_value(empty_rows, ["B04006_001E", "B04006_002E", "B04006_003E"]),
    "so the fetch falls through to tract level instead of stopping here",
)
check(
    "a response with even one real number does count",
    fetch_bg.has_any_value(full_rows, ["B04006_001E", "B04006_002E", "B04006_003E"]),
)
check(
    "the table total alone is not enough - it is populated even when the groups are not",
    not fetch_bg.has_any_value({"x": {"B04006_001E": "1500"}}, ["B04006_001E", "B04006_002E"]),
    "B04006_001E is excluded from the test on purpose",
)

# --- Top five, as shares of the row's own total ------------------------------
row = {
    "B04006_001E": "2000",
    "B04006_002E": "500",   # Armenian
    "B04006_003E": "300",   # Iranian
    "B04006_004E": "200",   # Italian
    "B04006_005E": "100",   # Russian
    "B04006_006E": "50",    # Greek
    "B04006_007E": "10",    # Polish - sixth, so dropped
    "B04006_008E": "0",     # zero, never shown
}
groups = {
    "B04006_002E": "Armenian", "B04006_003E": "Iranian", "B04006_004E": "Italian",
    "B04006_005E": "Russian", "B04006_006E": "Greek", "B04006_007E": "Polish",
    "B04006_008E": "Swedish",
}
shares, total = fetch_bg.top_origin_groups(row, groups, "B04006_001E")
check(
    "the top five are returned, largest first",
    list(shares) == ["Armenian", "Iranian", "Italian", "Russian", "Greek"],
    str(list(shares)),
)
check(
    "each is a percentage of the row's own total, not a head count",
    shares["Armenian"] == 25.0 and shares["Greek"] == 2.5,
    f"Armenian {shares['Armenian']}% of 2,000; Greek {shares['Greek']}%",
)
check("the sixth largest is dropped", "Polish" not in shares)
check("a group with nobody in it is not listed", "Swedish" not in shares)
check("the total comes back for the tooltip", total == 2000, str(total))
check(
    "a row with no total yields nothing rather than dividing by zero",
    fetch_bg.top_origin_groups({"B04006_001E": "0", "B04006_002E": "5"}, groups, "B04006_001E") == (None, None),
)
check(
    "a row where every group is empty yields nothing",
    fetch_bg.top_origin_groups({"B04006_001E": "2000"}, groups, "B04006_001E") == (None, None),
)

for junk in ("Other Central American", "All other Hispanic or Latino", "Uncategorized", "Unknown", "Some other race"):
    check(
        f"'{junk}' is excluded - only real origins matter",
        bool(fetch_bg.ORIGIN_SKIP.match(junk)),
    )


print(f"\n{len(failures) and 'FAILURES: ' + ', '.join(failures) or 'All checks passed.'}")
sys.exit(1 if failures else 0)
