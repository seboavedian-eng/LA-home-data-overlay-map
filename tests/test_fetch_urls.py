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

print(f"\n{len(failures) and 'FAILURES: ' + ', '.join(failures) or 'All checks passed.'}")
sys.exit(1 if failures else 0)
