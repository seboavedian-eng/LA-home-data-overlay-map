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
is B15001, which is fetched for the 25-34 band).

Every table is tried at block group first: if one isn't available there, the
script says so explicitly and falls back to tract level for that table only,
marking it so the page can label those numbers as tract-level.

Usage:
    python3 scripts/fetch-blockgroup-data.py
    python3 scripts/fetch-blockgroup-data.py --year 2022 --key YOUR_API_KEY
"""

import argparse
import datetime
import json
import os
import re
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

# B25077: median value of owner-occupied housing units. One figure per block
# group, so it belongs on the block group card and not on a house card - it
# describes the neighbourhood, not any particular property. It is what OWNERS
# SAY their home is worth, across houses, condos and townhouses together, which
# makes it a genuinely independent second opinion on the assessor roll rather
# than a duplicate of it.
B25077_MEDIAN_VALUE = "B25077_001E"

# B08303: travel time to work, in 13 brackets. The median is interpolated from
# them, because the Census publishes no median travel time at block group.
B08303_TOTAL = "B08303_001E"
B08303_BRACKETS = [
    ("B08303_002E", 0, 5), ("B08303_003E", 5, 10), ("B08303_004E", 10, 15),
    ("B08303_005E", 15, 20), ("B08303_006E", 20, 25), ("B08303_007E", 25, 30),
    ("B08303_008E", 30, 35), ("B08303_009E", 35, 40), ("B08303_010E", 40, 45),
    ("B08303_011E", 45, 60), ("B08303_012E", 60, 90), ("B08303_013E", 90, 120),
]
# The long-commute share, which a median hides: two block groups can share a
# median while one has a tail of hour-and-a-half drives.
B08303_45_PLUS = ["B08303_011E", "B08303_012E", "B08303_013E"]

# B23025: employment status for the population 16 and over. The unemployment
# rate is against the CIVILIAN labour force, which is how it is normally
# quoted - not against everyone 16+.
B23025_TOTAL_16_PLUS = "B23025_001E"
B23025_IN_LABOR_FORCE = "B23025_002E"
B23025_CIVILIAN_LF = "B23025_003E"
B23025_EMPLOYED = "B23025_004E"
B23025_UNEMPLOYED = "B23025_005E"

# B11003: family type by presence of own children under 18. These three lines
# are the "with own children" ones under married-couple, male-householder and
# female-householder families.
B11003_TOTAL_FAMILIES = "B11003_001E"
B11003_WITH_OWN_CHILDREN = ["B11003_003E", "B11003_010E", "B11003_016E"]

# B15001: sex by age by educational attainment. Only the 25-34 block is used,
# for bachelor's-or-higher among young adults - a different signal from the
# 25-and-over figure, which is weighted by whoever has lived here longest.
# Male 25-34 runs 011-018 and female 25-34 runs 052-059, bachelor's and
# graduate being the last two of each eight.
B15001_25_34_TOTAL = ["B15001_011E", "B15001_052E"]
B15001_25_34_BACHELORS_PLUS = ["B15001_017E", "B15001_018E", "B15001_058E", "B15001_059E"]

# --- Detailed origin ---------------------------------------------------------
# B03002's eight groups answer "what race", which in LA is rarely the question:
# Armenian Glendale, Persian Westwood, Korean Koreatown and Chinese San Gabriel
# are all invisible in it. Three tables cover it, because the Census splits it
# three ways.
#
# The variable codes are NOT written out here. They were, once, and it was a
# mistake: a table's codes cannot be checked without asking the API, one wrong
# code fails the whole request, and the table was then skipped - silently, so
# the section simply never appeared on the card. The codes and their labels are
# now read from the API's own description of each table, which cannot drift.
ORIGIN_TABLES = [
    ("B03001", "originHispanic", "Hispanic origin, by specific origin"),
    ("B02015", "originAsian", "Asian population, by detailed group"),
    ("B04006", "originAncestry", "Ancestry, self-reported"),
]

# Leaves that are not an origin: the "not Hispanic" complement, and the
# catch-alls that would otherwise top every list without saying anything.
ORIGIN_SKIP = re.compile(
    r"^("
    r"not\b"              # "Not Hispanic or Latino" - the complement, not an origin
    r"|other\b"           # "Other groups", "Other Central American", ...
    r"|all other\b"
    r"|unclassified"
    r"|uncategori[sz]ed"
    r"|unreported"
    r"|unknown"
    r"|not specified"
    r"|not reported"
    r"|two or more"
    r"|some other"
    r")",
    re.IGNORECASE,
)

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


def short_label(label):
    """
    "Estimate!!Total:!!Arab:!!Lebanese" -> "Lebanese".

    The API describes each variable with its full path through the table's
    hierarchy. The last step is the group's own name; everything before it is
    the branch it hangs off.
    """
    parts = [p.strip() for p in str(label or "").split("!!") if p.strip()]
    parts = [p for p in parts if p.lower() not in ("estimate", "total", "total:")]
    if not parts:
        return None
    name = parts[-1].rstrip(":").strip()
    # B02015 spells every group "Chinese alone or in any combination"; the
    # qualifier is the same on all of them and only costs width on the card.
    name = re.sub(r"\s+alone(\s+or\s+in\s+any\s+combination)?$", "", name, flags=re.IGNORECASE)
    return name or None


def is_leaf(label):
    """A parent category's label ends in a colon; a leaf's does not."""
    return not str(label or "").rstrip().endswith(":")


def top_origin_groups(row, groups, total_code, limit=5):
    """
    The largest named groups in one row, as PERCENTAGES of that row's own total.

    Percentages rather than counts because these tables are published by tract:
    a tract's head-count divided by a block group's population is a meaningless
    number, and can exceed 100%. A share of the same tract the counts came from
    is the only honest figure, and it is what a reader wants anyway.

    Returns (ordered {label: percent}, total) or (None, None).
    """
    # Named denominator, not `total`: that is a module-level helper here, and
    # shadowing it inside a function is how the last run died.
    denominator = to_number(row.get(total_code))
    if not denominator or denominator <= 0:
        return None, None
    counts = []
    for code, label in groups.items():
        n = to_number(row.get(code))
        if n and n > 0:
            counts.append((n, label))
    if not counts:
        return None, None
    counts.sort(reverse=True)
    return (
        {label: round(100 * n / denominator, 1) for n, label in counts[:limit]},
        int(denominator),
    )


def fetch_group_variables(base, table):
    """
    {variable code: short label} for a table's LEAF estimate variables, read
    from the API's own description of the table.

    Leaves only, because a parent is the sum of its children and counting both
    would double everything. Returns {} if the description cannot be read, so
    the caller can report a skipped table rather than a mysteriously empty one.
    """
    url = f"{base}/groups/{table}.json"
    try:
        data = fetch_json(url)
    except Exception as err:  # noqa: BLE001 - reported by the caller
        print(f"  {table}: could not read its variable list ({type(err).__name__}: {err})")
        return {}
    out = {}
    for code, meta in (data.get("variables") or {}).items():
        if not re.fullmatch(r"%s_\d+E" % re.escape(table), code):
            continue
        label = meta.get("label") if isinstance(meta, dict) else None
        if not is_leaf(label):
            continue
        name = short_label(label)
        if not name or ORIGIN_SKIP.match(name):
            continue
        out[code] = name
    return out


def has_any_value(rows, variables):
    """Did the response actually carry numbers, or just a shape full of nulls?"""
    wanted = [v for v in variables if not v.endswith("_001E")]
    for values in rows.values():
        for code in wanted:
            raw = values.get(code)
            if raw not in (None, "", "null") and to_number(raw) is not None:
                return True
    return False


def fetch_table(base, variables, key, label, prefer="block group", require_values=False):
    """
    Fetch a table, chunked around the API's 50-variable cap.
    Falls back to tract level if block group isn't available for this table.
    Returns (data, geo_level_actually_used) or (None, None) if both fail.

    require_values matters for tables that are only PUBLISHED at tract level.
    The API does not refuse those at block group - it accepts the query and
    answers with nulls for every row. Treating that as success is how the
    detailed-origin tables came back "available at block group" and yielded
    nothing at all, leaving the card to report that nobody here had an
    ancestry. With require_values set, an all-empty answer is not success.
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

        if require_values and merged and not has_any_value(merged, variables):
            print(
                f"  {label}: answered at {geo_level} but every value was empty"
                " - it is not really published at this geography, trying the next one"
            )
            continue

        note = "" if geo_level == "block group" else "  <-- FELL BACK TO TRACT LEVEL"
        print(f"  {label}: OK at {geo_level} ({len(merged)} rows){note}")
        return merged, geo_level

    print(f"  {label}: UNAVAILABLE at both block group and tract - skipping")
    return None, None


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


def median_from_brackets(counts, n):
    """
    The median of a bracketed distribution, interpolated inside the bracket it
    falls in. The Census publishes no median travel time at block group, so it
    has to come from the 13 buckets - and picking the bucket's midpoint would
    quantise every block group in LA onto the same dozen values.

    counts is [(people, low, high)] in ascending order.
    """
    if not n:
        return None
    half = n / 2
    running = 0
    for people, low, high in counts:
        if running + people >= half and people:
            return round(low + (half - running) / people * (high - low), 1)
        running += people
    return None


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
    parser.add_argument(
        "--out",
        default=None,
        help="Where to write the JSON (default js/data/bg-la-county.json). Mainly so a test can run "
             "this end to end without overwriting your real data file.",
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

    print("\nMedian home value, owner-reported (B25077):")
    value, value_geo = fetch_table(acs, [B25077_MEDIAN_VALUE], args.key, "B25077")

    print("\nTravel time to work (B08303):")
    ttime, ttime_geo = fetch_table(
        acs, [B08303_TOTAL] + [code for code, _, _ in B08303_BRACKETS], args.key, "B08303"
    )

    print("\nEmployment status (B23025):")
    employ, employ_geo = fetch_table(
        acs,
        [B23025_TOTAL_16_PLUS, B23025_IN_LABOR_FORCE, B23025_CIVILIAN_LF, B23025_EMPLOYED, B23025_UNEMPLOYED],
        args.key,
        "B23025",
    )

    print("\nFamilies with own children under 18 (B11003):")
    families, families_geo = fetch_table(
        acs, [B11003_TOTAL_FAMILIES] + B11003_WITH_OWN_CHILDREN, args.key, "B11003"
    )

    # Detailed origin: ask the API what each table contains, then fetch it.
    origin = {}
    origin_status = {}
    for table, key, title in ORIGIN_TABLES:
        print(f"\n{title} ({table}):")
        groups = fetch_group_variables(acs, table)
        if not groups:
            origin_status[table] = "no variable list"
            print(f"  {table}: SKIPPED - could not read its variable list, so this section will be missing")
            continue
        print(f"  {table}: {len(groups)} groups to fetch")
        total_code = f"{table}_001E"
        data, geo = fetch_table(
            acs, [total_code] + sorted(groups), args.key, table, require_values=True
        )
        if not data:
            origin_status[table] = "unavailable"
            continue
        origin_status[table] = geo
        origin[key] = (data, geo, groups, total_code)

    print("\nEducation among 25-34 year olds (B15001):")
    edu_young, edu_young_geo = fetch_table(
        acs, B15001_25_34_TOTAL + B15001_25_34_BACHELORS_PLUS, args.key, "B15001"
    )

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

        val_row = lookup(value, value_geo) if value else None
        if val_row:
            rec["medianHomeValue"] = to_number(val_row.get(B25077_MEDIAN_VALUE))

        tt_row = lookup(ttime, ttime_geo) if ttime else None
        if tt_row:
            counts = [(to_number(tt_row.get(code)) or 0, lo, hi) for code, lo, hi in B08303_BRACKETS]
            workers = sum(n for n, _, _ in counts)
            rec["commuteWorkers"] = workers
            rec["commuteMedianMinutes"] = median_from_brackets(counts, workers)
            rec["commute45Plus"] = total(tt_row, B08303_45_PLUS)

        emp_row = lookup(employ, employ_geo) if employ else None
        if emp_row:
            civilian = to_number(emp_row.get(B23025_CIVILIAN_LF))
            unemployed = to_number(emp_row.get(B23025_UNEMPLOYED))
            rec["pop16Plus"] = to_number(emp_row.get(B23025_TOTAL_16_PLUS))
            rec["inLaborForce"] = to_number(emp_row.get(B23025_IN_LABOR_FORCE))
            rec["civilianLaborForce"] = civilian
            rec["unemployed"] = unemployed

        fam_row = lookup(families, families_geo) if families else None
        if fam_row:
            rec["families"] = to_number(fam_row.get(B11003_TOTAL_FAMILIES))
            rec["familiesWithChildren"] = total(fam_row, B11003_WITH_OWN_CHILDREN)

        # The five largest groups in each origin table, as counts.
        # Detailed origin. These come from the tract this block group sits in,
        # so they are stored as shares of that tract rather than head counts.
        for key, (table_data, table_geo, groups, total_code) in origin.items():
            row = lookup(table_data, table_geo)
            if not row:
                continue
            # NOT `total` - that is the name of a module-level helper this
            # function calls earlier, and binding it here makes it local for
            # the whole of main(), so the earlier call fails at run time.
            shares, group_total = top_origin_groups(row, groups, total_code)
            if not shares:
                continue
            rec[key] = shares
            rec[key + "Total"] = group_total
            rec[key + "Geo"] = table_geo

        young_row = lookup(edu_young, edu_young_geo) if edu_young else None
        if young_row:
            rec["edu25to34Total"] = total(young_row, B15001_25_34_TOTAL)
            rec["edu25to34BachelorsPlus"] = total(young_row, B15001_25_34_BACHELORS_PLUS)

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
            "schemaVersion": 8,
            # Which detailed-origin tables actually made it in. Without this the
            # page cannot tell "nobody here reported an ancestry" from "that
            # table was never fetched", and the section vanishes either way.
            "originTables": origin_status,
            # So the sidebar's data-source table can say when this was pulled.
            "generated": datetime.date.today().isoformat(),
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

    out_path = args.out or os.path.normpath(
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
    # A table that did not land is the one thing most likely to look like a
    # broken page rather than a failed fetch, so it is said last and plainly.
    missing = [t for t, status in origin_status.items() if status in ("unavailable", "no variable list")]
    placed = sum(1 for rec in block_groups.values() if any(k.startswith("origin") for k in rec))
    if missing:
        print(
            f"\nWARNING: the Detailed origin section will be missing or incomplete - "
            f"{', '.join(missing)} could not be fetched."
        )
    else:
        print(f"\nDetailed origin: {placed:,} of {len(block_groups):,} block groups have at least one group.")
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
