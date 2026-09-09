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

# B01001 Sex by Age. Male variables run 003-025, female 027-049, covering the
# same 23 age brackets in the same order.
#
# Every bracket is stored individually rather than pre-summed into bands: the
# bands you want to display WILL change, and keeping the raw brackets means
# regrouping is a front-end edit instead of a full re-fetch.
B01001_BRACKETS = {
    3: "Under 5", 4: "5-9", 5: "10-14", 6: "15-17", 7: "18-19", 8: "20",
    9: "21", 10: "22-24", 11: "25-29", 12: "30-34", 13: "35-39", 14: "40-44",
    15: "45-49", 16: "50-54", 17: "55-59", 18: "60-61", 19: "62-64",
    20: "65-66", 21: "67-69", 22: "70-74", 23: "75-79", 24: "80-84", 25: "85+",
}
B01001_TOTAL = "B01001_001E"
B01001_MALE = "B01001_002E"
B01001_FEMALE = "B01001_026E"


def b01001_variables():
    codes = {B01001_TOTAL, B01001_MALE, B01001_FEMALE}
    for i in B01001_BRACKETS:
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

# --- Housing stock and commuting -------------------------------------------
# B25024 Units in structure. The share that is "1, detached" is what tells a
# dense block group of small lots apart from one holding an apartment tower -
# a distinction population density alone cannot make.
B25024_TOTAL = "B25024_001E"
B25024_CATEGORIES = {
    "B25024_002E": "1, detached",
    "B25024_003E": "1, attached",
    "B25024_004E": "2",
    "B25024_005E": "3 or 4",
    "B25024_006E": "5 to 9",
    "B25024_007E": "10 to 19",
    "B25024_008E": "20 to 49",
    "B25024_009E": "50 or more",
    "B25024_010E": "Mobile home",
    "B25024_011E": "Boat, RV, van",
}

# B25003 Tenure. Owner-occupancy rate: the standard stability proxy, and the
# thing that says whether a median household income describes owners or
# renters.
B25003_TOTAL = "B25003_001E"
B25003_OWNER = "B25003_002E"
B25003_RENTER = "B25003_003E"

# B08301 Means of transportation to work. Nearly all of it is "drove alone"
# in LA and therefore useless, with one exception: the worked-from-home line,
# which swings widely across block groups and is the closest thing to an
# occupation signal available at this geography. The walked line is the other
# keeper - near zero almost everywhere, so anywhere above a few percent is a
# genuinely walkable pocket.
B08301_TOTAL = "B08301_001E"
B08301_WFH = "B08301_021E"
B08301_WALKED = "B08301_019E"
B08301_TRANSIT = "B08301_010E"

# B25035 median year structure built, and B25034's decade bins. LA thresholds
# worth knowing: pre-1978 lead paint, pre-1980 asbestos, pre-1994 soft-story
# (pre-Northridge).
B25035_MEDIAN_YEAR = "B25035_001E"
B25034_TOTAL = "B25034_001E"
B25034_BINS = {
    "B25034_002E": "2020 or later",
    "B25034_003E": "2010 to 2019",
    "B25034_004E": "2000 to 2009",
    "B25034_005E": "1990 to 1999",
    "B25034_006E": "1980 to 1989",
    "B25034_007E": "1970 to 1979",
    "B25034_008E": "1960 to 1969",
    "B25034_009E": "1950 to 1959",
    "B25034_010E": "1940 to 1949",
    "B25034_011E": "1939 or earlier",
}
# Bins entirely before 1980, for the "old stock" share.
B25034_PRE_1980 = ["B25034_007E", "B25034_008E", "B25034_009E", "B25034_010E", "B25034_011E"]

# B25010: average household size of occupied housing units. The Census
# Bureau's own figure, so it excludes people in group quarters on both sides
# of the division - unlike dividing total population by household count.
B25010_AVG_HH_SIZE = "B25010_001E"

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


class CensusKeyRequired(RuntimeError):
    """The API rejected the request for want of an API key."""


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=180) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as err:
        # The API answers a keyless request with an HTML "Missing Key" page,
        # not a JSON error - so this has to be sniffed out of the body.
        # There is no point retrying other tables or geographies: every
        # request will get the same page.
        if "missing key" in raw.lower() or "invalid key" in raw.lower():
            raise CensusKeyRequired(raw) from err
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
        except CensusKeyRequired:
            raise  # no point trying other tables - every request needs the key
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
    except CensusKeyRequired:
        raise
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


KEY_FILE = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "census-api-key.txt")
)

KEY_HELP = f"""
{'=' * 70}
A Census API key is required.
{'=' * 70}

The Census Bureau now rejects keyless requests to api.census.gov, so this
script cannot fetch anything until you have one. Keys are free and issued
immediately.

  1. Request one at: https://api.census.gov/data/key_signup.html
     (organization can be anything, e.g. "personal project")
  2. Check your email for the key - a long string of letters and numbers.
     You may need to click an activation link in that email.
  3. Either save it once, so you never have to pass it again:

         Put the key on a single line in:
         {KEY_FILE}

     ...or pass it on the command line each time:

         python scripts\\fetch-blockgroup-data.py --key YOUR_KEY_HERE

Then re-run this script.
{'=' * 70}
"""


def read_key_file():
    """A saved key means this doesn't have to be passed on every run."""
    try:
        with open(KEY_FILE) as fh:
            return fh.read().strip()
    except OSError:
        return ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, default=2022, help="ACS 5-year vintage (default 2022)")
    parser.add_argument(
        "--key",
        default=os.environ.get("CENSUS_API_KEY", "") or read_key_file(),
        help="Census API key (required). Also read from CENSUS_API_KEY or census-api-key.txt",
    )
    args = parser.parse_args()

    if not args.key:
        print(KEY_HELP, file=sys.stderr)
        sys.exit(2)

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

    print("\nHousing stock - units in structure (B25024):")
    structure, structure_geo = fetch_table(acs, [B25024_TOTAL] + list(B25024_CATEGORIES.keys()), args.key, "B25024")

    print("\nTenure - owner vs renter (B25003):")
    tenure, tenure_geo = fetch_table(acs, [B25003_TOTAL, B25003_OWNER, B25003_RENTER], args.key, "B25003")

    print("\nCommute mode, for the work-from-home share (B08301):")
    commute, commute_geo = fetch_table(
        acs, [B08301_TOTAL, B08301_WFH, B08301_WALKED, B08301_TRANSIT], args.key, "B08301"
    )

    print("\nYear structure built (B25035 median, B25034 decades):")
    built, built_geo = fetch_table(
        acs, [B25035_MEDIAN_YEAR, B25034_TOTAL] + list(B25034_BINS.keys()), args.key, "B25035/B25034"
    )

    print("\nAverage household size (B25010):")
    hhsize, hhsize_geo = fetch_table(acs, [B25010_AVG_HH_SIZE], args.key, "B25010")

    # Open question worth an empirical answer: is education-by-age-bracket
    # (B15001) published at block group? If it is, a future version can show
    # bachelor's-or-higher per age band instead of just for 25+ overall.
    print("\nProbing (not used yet): education by age bracket, B15001:")
    probe(acs, ["B15001_001E"], args.key, "B15001")

    # Open availability questions. The tables above either came back at block
    # group or fell back to tract, and the log above says which. These are the
    # ones not fetched at all, probed so the answer is on the record rather
    # than guessed at.
    print("\nProbing (not used yet): commute TIME, B08303:")
    probe(acs, ["B08303_001E"], args.key, "B08303")
    print("\nProbing (not used yet): employment status, B23025:")
    probe(acs, ["B23025_001E"], args.key, "B23025")
    print("\nProbing (not used yet): household type with own children, B11003:")
    probe(acs, ["B11003_001E"], args.key, "B11003")
    print("\nProbing (not used yet): median home value, B25077:")
    probe(acs, ["B25077_001E"], args.key, "B25077")

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
        # Male + female per bracket, keyed by B01001's own bracket index.
        rec["ageBrackets"] = {
            str(i): total(values, [f"B01001_{i:03d}E", f"B01001_{i + 24:03d}E"])
            for i in B01001_BRACKETS
        }

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

        st_row = lookup(structure, structure_geo) if structure else None
        if st_row:
            rec["structureTotal"] = to_number(st_row.get(B25024_TOTAL))
            rec["structureUnits"] = {
                label: to_number(st_row.get(code)) or 0 for code, label in B25024_CATEGORIES.items()
            }

        ten_row = lookup(tenure, tenure_geo) if tenure else None
        if ten_row:
            rec["tenureTotal"] = to_number(ten_row.get(B25003_TOTAL))
            rec["ownerOccupied"] = to_number(ten_row.get(B25003_OWNER))
            rec["renterOccupied"] = to_number(ten_row.get(B25003_RENTER))

        com_row = lookup(commute, commute_geo) if commute else None
        if com_row:
            rec["workersTotal"] = to_number(com_row.get(B08301_TOTAL))
            rec["workedFromHome"] = to_number(com_row.get(B08301_WFH))
            rec["walkedToWork"] = to_number(com_row.get(B08301_WALKED))
            rec["transitToWork"] = to_number(com_row.get(B08301_TRANSIT))

        built_row = lookup(built, built_geo) if built else None
        if built_row:
            rec["medianYearBuilt"] = to_number(built_row.get(B25035_MEDIAN_YEAR))
            rec["yearBuiltTotal"] = to_number(built_row.get(B25034_TOTAL))
            rec["yearBuiltPre1980"] = total(built_row, B25034_PRE_1980)
            rec["yearBuiltBins"] = {
                label: to_number(built_row.get(code)) or 0 for code, label in B25034_BINS.items()
            }

        hh_row = lookup(hhsize, hhsize_geo) if hhsize else None
        if hh_row:
            rec["avgHouseholdSize"] = to_number(hh_row.get(B25010_AVG_HH_SIZE))

        block_groups[geoid] = rec

    payload = {
        "meta": {
            # Bumped when the record shape changes, so the page can tell a
            # stale data file from a missing one and say which it is.
            "schemaVersion": 4,
            "ageBracketLabels": {str(k): v for k, v in B01001_BRACKETS.items()},
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
                "householdSize": hhsize_geo,
                "structure": structure_geo,
                "tenure": tenure_geo,
                "commute": commute_geo,
                "yearBuilt": built_geo,
            },
            "sources": {
                "age": "ACS B01001 (Sex by Age)",
                "ethnicityAcs": "ACS B03002 (Hispanic or Latino Origin by Race)",
                "ethnicityDec": "2020 Census P2 (redistricting file, 100% count)",
                "education": "ACS B15003 (Educational Attainment, 25+)",
                "income": "ACS B19013 / B19301 / B19001",
                "householdSize": "ACS B25010 (Average Household Size of Occupied Housing Units)",
                "structure": "ACS B25024 (Units in Structure)",
                "tenure": "ACS B25003 (Tenure)",
                "commute": "ACS B08301 (Means of Transportation to Work)",
                "yearBuilt": "ACS B25035 / B25034 (Year Structure Built)",
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
    except CensusKeyRequired:
        # Reported as guidance, not a stack trace: the key is the whole fix.
        print(KEY_HELP, file=sys.stderr)
        print("(The key you supplied was rejected, or none was supplied.)", file=sys.stderr)
        sys.exit(2)
    except urllib.error.HTTPError as err:
        print(f"\nCensus API returned HTTP {err.code}: {err.reason}", file=sys.stderr)
        print(f"URL: {err.url}", file=sys.stderr)
        sys.exit(1)
