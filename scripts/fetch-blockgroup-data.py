#!/usr/bin/env python3
"""
One-time fetch of block-group-level Census data for LA County, saved to
js/data/bg-la-county.json for blockgroups.html to load.

Why a script instead of a live call from the page: api.census.gov sends no
Access-Control-Allow-Origin header, so a browser can never read its response
directly. This runs from your machine (normal internet access), not the page.

What it pulls, per block group in LA County (state 06, county 037):
  - B04006  People Reporting Ancestry (~110 detailed ancestry categories)
  - B01003  Total population
  - B19013  Median household income
  - B19301  Per-capita income

Two Census API constraints it works around:
  - Max 50 variables per request, so the ancestry table is fetched in chunks
    and merged by GEOID.
  - The exact variable list and the human-readable ancestry names are read
    from the API's own group metadata rather than hardcoded, so this stays
    correct if the table's categories change between vintages.

Usage:
    python3 scripts/fetch-blockgroup-data.py
    python3 scripts/fetch-blockgroup-data.py --year 2022 --key YOUR_API_KEY
"""

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

STATE = "06"       # California
COUNTY = "037"     # Los Angeles County
CHUNK_SIZE = 45    # Census API caps `get` at 50 variables; leave headroom.

EXTRA_VARIABLES = {
    "B01003_001E": "totalPopulation",
    "B19013_001E": "medianHouseholdIncome",
    "B19301_001E": "perCapitaIncome",
}


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def clean_ancestry_label(label):
    """'Estimate!!Total:!!German' -> 'German'."""
    parts = [p for p in label.split("!!") if p not in ("Estimate", "Total:", "Total")]
    return parts[-1].rstrip(":").strip() if parts else label


def get_ancestry_variables(year, dataset):
    """Read B04006's variable list + labels from the API's group metadata."""
    url = f"https://api.census.gov/data/{year}/{dataset}/groups/B04006.json"
    print(f"Reading B04006 variable list from {url}")
    data = fetch_json(url)
    variables = data.get("variables", {})

    labels = {}
    for code, meta in variables.items():
        # Estimates only (skip margins of error and annotation columns).
        if not code.endswith("E") or code.endswith("EA"):
            continue
        if code == "B04006_001E":  # the universe total, handled separately
            continue
        labels[code] = clean_ancestry_label(meta.get("label", code))

    ordered = sorted(labels.keys(), key=lambda c: int(c.split("_")[1][:3]))
    print(f"  found {len(ordered)} ancestry categories")
    return ordered, labels


def fetch_variable_chunk(year, dataset, variables, key):
    """Fetch one chunk of variables for every block group in LA County."""
    params = {
        "get": ",".join(variables),
        "for": "block group:*",
        "in": f"state:{STATE} county:{COUNTY} tract:*",
    }
    if key:
        params["key"] = key
    url = f"https://api.census.gov/data/{year}/{dataset}?" + urllib.parse.urlencode(params, safe=":,*")
    rows = fetch_json(url)
    header = rows[0]
    idx = {name: i for i, name in enumerate(header)}
    geo_parts = ["state", "county", "tract", "block group"]

    out = {}
    for row in rows[1:]:
        geoid = "".join(row[idx[p]] for p in geo_parts)
        out[geoid] = {name: row[idx[name]] for name in variables if name in idx}
    return out


def to_number(raw):
    """Census uses large negative sentinels (-666666666) for 'no data'."""
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if value < 0:
        return None
    return int(value) if value.is_integer() else value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, default=2022, help="ACS 5-year vintage (default 2022)")
    parser.add_argument("--key", default=os.environ.get("CENSUS_API_KEY", ""), help="Optional Census API key")
    args = parser.parse_args()

    dataset = "acs/acs5"
    ancestry_vars, ancestry_labels = get_ancestry_variables(args.year, dataset)

    # Ancestry universe total + the population/income variables ride along in
    # the first request; ancestry categories are chunked across the rest.
    chunks = [["B04006_001E"] + list(EXTRA_VARIABLES.keys())]
    for i in range(0, len(ancestry_vars), CHUNK_SIZE):
        chunks.append(ancestry_vars[i:i + CHUNK_SIZE])

    merged = {}
    for n, chunk in enumerate(chunks, 1):
        print(f"Fetching chunk {n}/{len(chunks)} ({len(chunk)} variables)...")
        part = fetch_variable_chunk(args.year, dataset, chunk, args.key)
        for geoid, values in part.items():
            merged.setdefault(geoid, {}).update(values)

    print(f"Merged {len(merged)} block groups. Compacting...")

    block_groups = {}
    for geoid, values in merged.items():
        # Keep only non-zero ancestry counts - most block groups report only a
        # handful of the ~110 categories, so this shrinks the file a lot
        # without losing anything that would ever show in a top-5 list.
        ancestries = {}
        for code in ancestry_vars:
            count = to_number(values.get(code))
            if count:
                ancestries[code] = count

        block_groups[geoid] = {
            "ancestryTotal": to_number(values.get("B04006_001E")),
            "ancestries": ancestries,
            "totalPopulation": to_number(values.get("B01003_001E")),
            "medianHouseholdIncome": to_number(values.get("B19013_001E")),
            "perCapitaIncome": to_number(values.get("B19301_001E")),
        }

    payload = {
        "meta": {
            "year": args.year,
            "dataset": dataset,
            "state": STATE,
            "county": COUNTY,
            "source": "US Census Bureau ACS 5-year estimates (B04006, B01003, B19013, B19301)",
            "ancestryLabels": ancestry_labels,
        },
        "blockGroups": block_groups,
    }

    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "js", "data", "bg-la-county.json")
    out_path = os.path.normpath(out_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump(payload, fh, separators=(",", ":"))

    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    print(f"\nWrote {len(block_groups)} block groups to {out_path} ({size_mb:.1f} MB)")
    print("Reload blockgroups.html - the block group popups will now have data.")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as err:
        print(f"\nCensus API returned HTTP {err.code}: {err.reason}", file=sys.stderr)
        print(f"URL: {err.url}", file=sys.stderr)
        sys.exit(1)
