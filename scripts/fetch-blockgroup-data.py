#!/usr/bin/env python3
"""
One-time fetch of block-group-level Census data for LA County, saved to
js/data/bg-la-county.json for blockgroups.html to load.

Why a script instead of a live call from the page: api.census.gov sends no
Access-Control-Allow-Origin header, so a browser can never read its response
directly. This runs from your machine (normal internet access), not the page.

WHAT IT PULLS (all at block group level):
  B01001  Sex by Age            -> total population, age bands, sex split
  B03002  Hispanic/Latino by Race -> ethnicity breakdown (default source)
  B15003  Educational Attainment 25+ -> % bachelor's degree or higher
  B19013  Median household income
  B19001  Household income distribution (16 brackets)
  B19301  Per-capita income
  P2      2020 Census redistricting file -> ethnicity breakdown (alt source,
          an actual 100% count rather than a survey estimate)

WHY THESE TABLES: ACS Subject Tables (S1501, S0101) and Data Profiles are
derived products that the Census Bureau does NOT publish at block group -
only Detailed (B) tables go that deep. B01001 replaces S0101 completely;
B15003 replaces S1501 except that it has no age breakdown (education by age
is B15001, which this script probes for and reports on).

Every table is probed before use: if one isn't available at block group,
the script says so explicitly and falls back to tract level for that table
only, marking it so the page can label those numbers as tract-level.

Usage:
    python3 scripts/fetch-blockgroup-data.py
    python3 scripts/fetch-blockgroup-data.py --year 2022 --key YOUR_API_KEY
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

STATE = "06"       # California
COUNTY = "037"     # Los Angeles County
CHUNK_SIZE = 45    # Census API caps `get` at 50 variables; leave headroom.

# --- Variable definitions ---------------------------------------------------

# B01001 Sex by Age. Male 003-025, female 027-049, same age bands in order.
AGE_BANDS = {
    "under25": [3, 4, 5, 6, 7, 8, 9, 10],        # <5 through 22-24
    "age25to54": [11, 12, 13, 14, 15, 16],        # 25-29 through 50-54
    "age55plus": [17, 18, 19, 20, 21, 22, 23, 24, 25],  # 55-59 through 85+
}
B01001_TOTAL = "B01001_001E"
B01001_MALE = "B01001_002E"
B01001_FEMALE = "B01001_026E"


def b01001_variables():
    codes = {B01001_TOTAL, B01001_MALE, B01001_FEMALE}
    for offsets in AGE_BANDS.values():
        for i in offsets:
            codes.add(f"B01001_{i:03d}E")        # male
            codes.add(f"B01001_{i + 24:03d}E")   # female
    return sorted(codes)


# B03002 Hispanic or Latino Origin by Race - the same categories the rest of
# this project uses, so the two ethnicity sources stay comparable.
B03002_CATEGORIES = {
    "B03002_012E": "Hispanic or Latino",
    "B03002_003E": "White (non-Hispanic)",
    "B03002_004E": "Black (non-Hispanic)",
    "B03002_006E": "Asian (non-Hispanic)",
    "B03002_005E": "American Indian / Alaska Native (non-Hispanic)",
    "B03002_007E": "Native Hawaiian / Pacific Islander (non-Hispanic)",
    "B03002_009E": "Two or more races (non-Hispanic)",
    "B03002_008E": "Some other race (non-Hispanic)",
}
B03002_TOTAL = "B03002_001E"

# P2 (2020 Census PL 94-171). Decennial variables end in N, not E, and this
# is a full count rather than a survey estimate.
P2_CATEGORIES = {
    "P2_002N": "Hispanic or Latino",
    "P2_005N": "White (non-Hispanic)",
    "P2_006N": "Black (non-Hispanic)",
    "P2_008N": "Asian (non-Hispanic)",
    "P2_007N": "American Indian / Alaska Native (non-Hispanic)",
    "P2_009N": "Native Hawaiian / Pacific Islander (non-Hispanic)",
    "P2_011N": "Two or more races (non-Hispanic)",
    "P2_010N": "Some other race (non-Hispanic)",
}
P2_TOTAL = "P2_001N"

# B15003 Educational Attainment, population 25+.
B15003_TOTAL = "B15003_001E"
B15003_BACHELORS_PLUS = ["B15003_022E", "B15003_023E", "B15003_024E", "B15003_025E"]

B19013_MEDIAN_HH = "B19013_001E"
B19301_PER_CAPITA = "B19301_001E"

# B19001 Household income distribution: 002-017 are the 16 brackets.
B19001_TOTAL = "B19001_001E"
B19001_BRACKETS = {
    "B19001_002E": "< $10k",
    "B19001_003E": "$10-15k",
    "B19001_004E": "$15-20k",
    "B19001_005E": "$20-25k",
    "B19001_006E": "$25-30k",
    "B19001_007E": "$30-35k",
    "B19001_008E": "$35-40k",
    "B19001_009E": "$40-45k",
    "B19001_010E": "$45-50k",
    "B19001_011E": "$50-60k",
    "B19001_012E": "$60-75k",
    "B19001_013E": "$75-100k",
    "B19001_014E": "$100-125k",
    "B19001_015E": "$125-150k",
    "B19001_016E": "$150-200k",
    "B19001_017E": "$200k+",
}

GEO_PARTS = ["state", "county", "tract", "block group"]


# --- HTTP -------------------------------------------------------------------

class CensusResponseError(RuntimeError):
    """Non-JSON response body - carries the URL and a snippet for debugging."""


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=180) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as err:
        snippet = raw.strip()[:200] or "(empty response body)"
        raise CensusResponseError(f"{err}. Server sent: {snippet}\n      URL: {url}") from err


def build_url(base, variables, geo_level, key):
    params = {
        "get": ",".join(variables),
        "for": f"{geo_level}:*",
        "in": f"state:{STATE} county:{COUNTY}" + (" tract:*" if geo_level == "block group" else ""),
    }
    if key:
        params["key"] = key
    # quote_via=quote is essential: urlencode defaults to quote_plus, which
    # encodes spaces as "+". The Census API does not accept "+" in the `for`
    # and `in` clauses - it needs %20 - and answers a "+" query with an empty
    # 200 response rather than an error, so this fails silently and totally.
    return f"{base}?" + urllib.parse.urlencode(params, safe=":,*", quote_via=urllib.parse.quote)


def fetch_rows(base, variables, geo_level, key):
    """Returns {geoid: {var: raw_value}} for one chunk of variables."""
    rows = fetch_json(build_url(base, variables, geo_level, key))
    header = rows[0]
    idx = {name: i for i, name in enumerate(header)}
    parts = GEO_PARTS if geo_level == "block group" else GEO_PARTS[:3]

    out = {}
    for row in rows[1:]:
        geoid = "".join(row[idx[p]] for p in parts)
        out[geoid] = {name: row[idx[name]] for name in variables if name in idx}
    return out


def fetch_table(base, variables, key, label, prefer="block group"):
    """
    Fetch a table, chunked around the API's 50-variable cap.
    Falls back to tract level if block group isn't available for this table.
    Returns (data, geo_level_actually_used) or (None, None) if both fail.
    """
    for geo_level in ([prefer, "tract"] if prefer == "block group" else [prefer]):
        merged = {}
        try:
            for i in range(0, len(variables), CHUNK_SIZE):
                chunk = variables[i:i + CHUNK_SIZE]
                part = fetch_rows(base, chunk, geo_level, key)
                for geoid, values in part.items():
                    merged.setdefault(geoid, {}).update(values)
        except urllib.error.HTTPError as err:
            body = ""
            try:
                body = err.read().decode("utf-8", errors="replace").strip()[:200]
            except Exception:  # noqa: BLE001 - best effort only
                pass
            print(f"  {label}: not available at {geo_level} (HTTP {err.code})" + (f" - {body}" if body else ""))
            continue
        except CensusResponseError as err:
            # Non-JSON body: almost always a malformed query, so show what
            # came back and the exact URL rather than just the parse error.
            print(f"  {label}: failed at {geo_level}\n      {err}")
            continue
        except Exception as err:  # noqa: BLE001 - report and keep going
            print(f"  {label}: failed at {geo_level} ({type(err).__name__}: {err})")
            continue

        note = "" if geo_level == "block group" else "  <-- FELL BACK TO TRACT LEVEL"
        print(f"  {label}: OK at {geo_level} ({len(merged)} rows){note}")
        return merged, geo_level

    print(f"  {label}: UNAVAILABLE at both block group and tract - skipping")
    return None, None


def probe(base, variables, key, label):
    """
    Availability check only - used to answer open questions, not to fetch.

    Reports "unavailable" ONLY for an actual HTTP error from the API. Any
    other failure (network, malformed query, non-JSON body) is reported as
    inconclusive: it says nothing about whether the table exists, and
    claiming otherwise would be a wrong answer stated confidently.
    """
    try:
        fetch_rows(base, variables, "block group", key)
        print(f"  {label}: IS available at block group")
        return True
    except urllib.error.HTTPError as err:
        print(f"  {label}: is NOT available at block group (HTTP {err.code})")
        return False
    except Exception as err:  # noqa: BLE001
        print(f"  {label}: INCONCLUSIVE - the probe itself failed ({type(err).__name__}: {err})")
        return None


# --- value helpers ----------------------------------------------------------

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


def total(values, codes):
    """Sum a set of variables, treating missing/suppressed as 0."""
    return sum((to_number(values.get(c)) or 0) for c in codes)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, default=2022, help="ACS 5-year vintage (default 2022)")
    parser.add_argument("--key", default=os.environ.get("CENSUS_API_KEY", ""), help="Optional Census API key")
    args = parser.parse_args()

    acs = f"https://api.census.gov/data/{args.year}/acs/acs5"
    dec = "https://api.census.gov/data/2020/dec/pl"

    print(f"Fetching LA County block group data (ACS {args.year} 5-year + 2020 Census P2)\n")

    print("Age & sex (B01001):")
    age, age_geo = fetch_table(acs, b01001_variables(), args.key, "B01001")

    print("\nEthnicity - ACS (B03002):")
    eth_acs, eth_acs_geo = fetch_table(
        acs, [B03002_TOTAL] + list(B03002_CATEGORIES.keys()), args.key, "B03002"
    )

    print("\nEthnicity - 2020 Census (P2):")
    eth_dec, eth_dec_geo = fetch_table(
        dec, [P2_TOTAL] + list(P2_CATEGORIES.keys()), args.key, "P2"
    )

    print("\nEducational attainment (B15003):")
    edu, edu_geo = fetch_table(acs, [B15003_TOTAL] + B15003_BACHELORS_PLUS, args.key, "B15003")

    print("\nIncome (B19013 median, B19301 per capita, B19001 distribution):")
    income, income_geo = fetch_table(
        acs,
        [B19013_MEDIAN_HH, B19301_PER_CAPITA, B19001_TOTAL] + list(B19001_BRACKETS.keys()),
        args.key,
        "B19013/B19301/B19001",
    )

    # Open question worth an empirical answer: is education-by-age-bracket
    # (B15001) published at block group? If it is, a future version can show
    # bachelor's-or-higher per age band instead of just for 25+ overall.
    print("\nProbing (not used yet): education by age bracket, B15001:")
    probe(acs, ["B15001_001E"], args.key, "B15001")

    if not age:
        print("\nCould not fetch B01001 - aborting, since population is the basis for everything else.", file=sys.stderr)
        sys.exit(1)

    print("\nCompacting...")
    block_groups = {}
    for geoid, values in age.items():
        rec = {}

        rec["totalPopulation"] = to_number(values.get(B01001_TOTAL))
        rec["male"] = to_number(values.get(B01001_MALE))
        rec["female"] = to_number(values.get(B01001_FEMALE))
        for band, offsets in AGE_BANDS.items():
            codes = [f"B01001_{i:03d}E" for i in offsets] + [f"B01001_{i + 24:03d}E" for i in offsets]
            rec[band] = total(values, codes)

        # Tract-level fallbacks are keyed by the 11-char tract geoid.
        tract_geoid = geoid[:11]

        def lookup(table, table_geo):
            if not table:
                return None
            return table.get(geoid if table_geo == "block group" else tract_geoid)

        acs_eth = lookup(eth_acs, eth_acs_geo)
        if acs_eth:
            rec["ethnicityAcs"] = {
                label: to_number(acs_eth.get(code)) or 0 for code, label in B03002_CATEGORIES.items()
            }
            rec["ethnicityAcsTotal"] = to_number(acs_eth.get(B03002_TOTAL))

        dec_eth = lookup(eth_dec, eth_dec_geo)
        if dec_eth:
            rec["ethnicityDec"] = {
                label: to_number(dec_eth.get(code)) or 0 for code, label in P2_CATEGORIES.items()
            }
            rec["ethnicityDecTotal"] = to_number(dec_eth.get(P2_TOTAL))

        edu_row = lookup(edu, edu_geo)
        if edu_row:
            rec["eduTotal25plus"] = to_number(edu_row.get(B15003_TOTAL))
            rec["eduBachelorsPlus"] = total(edu_row, B15003_BACHELORS_PLUS)

        inc_row = lookup(income, income_geo)
        if inc_row:
            rec["medianHouseholdIncome"] = to_number(inc_row.get(B19013_MEDIAN_HH))
            rec["perCapitaIncome"] = to_number(inc_row.get(B19301_PER_CAPITA))
            rec["householdCount"] = to_number(inc_row.get(B19001_TOTAL))
            rec["incomeBrackets"] = {
                label: to_number(inc_row.get(code)) or 0 for code, label in B19001_BRACKETS.items()
            }

        block_groups[geoid] = rec

    payload = {
        "meta": {
            "year": args.year,
            "decennialYear": 2020,
            "state": STATE,
            "county": COUNTY,
            # Which geography each table actually came from, so the page can
            # label anything that had to fall back to tract level.
            "geoLevels": {
                "age": age_geo,
                "ethnicityAcs": eth_acs_geo,
                "ethnicityDec": eth_dec_geo,
                "education": edu_geo,
                "income": income_geo,
            },
            "sources": {
                "age": "ACS B01001 (Sex by Age)",
                "ethnicityAcs": "ACS B03002 (Hispanic or Latino Origin by Race)",
                "ethnicityDec": "2020 Census P2 (redistricting file, 100% count)",
                "education": "ACS B15003 (Educational Attainment, 25+)",
                "income": "ACS B19013 / B19301 / B19001",
            },
        },
        "blockGroups": block_groups,
    }

    out_path = os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "js", "data", "bg-la-county.json")
    )
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump(payload, fh, separators=(",", ":"))

    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    print(f"\nWrote {len(block_groups)} block groups to {out_path} ({size_mb:.1f} MB)")
    fallbacks = [k for k, v in payload["meta"]["geoLevels"].items() if v == "tract"]
    if fallbacks:
        print(f"NOTE: these came from tract level, not block group: {', '.join(fallbacks)}")
    print("Reload blockgroups.html - block group popups will now have data.")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as err:
        print(f"\nCensus API returned HTTP {err.code}: {err.reason}", file=sys.stderr)
        print(f"URL: {err.url}", file=sys.stderr)
        sys.exit(1)
