#!/usr/bin/env python3
"""
Build a 1-10 rating for every public school in LA County, plus the directory
the map needs to place and label them.

WHY NOT GREATSCHOOLS
--------------------
GreatSchools has no free API. The paid plans return rating BANDS ("above
average"), not the 1-10 number everyone actually means, and their terms
prohibit scraping the site. So this script does not pretend to reproduce their
rating - it computes its own, from the public data that GreatSchools' own test
score rating is mostly built from, and says so everywhere it is shown.

    rating = decile of (ELA + Math "percent met or exceeded standard"),
             ranked against other LA COUNTY schools AT THE SAME LEVEL

Two decisions inside that are worth stating plainly:

  * It is a RANK, not a score. A 7 means "better than roughly 60-70% of LA
    County elementary schools", not "70% of pupils can read". Ranking within
    the county rather than the state is deliberate: you are choosing between
    LA County houses, so a statewide percentile would compress every school
    you can actually buy into a narrow band.

  * Elementary, middle and high are ranked SEPARATELY. Test participation and
    difficulty differ by level, so a single pooled ranking would say more
    about which grades sit the test than about which school is better.

WHAT THIS IS NOT
----------------
Test scores track household income more tightly than they track teaching. A
school serving wealthy families scores well largely because of who enrols
there. This number is a fair summary of measured outcomes and a poor summary
of how good the teaching is, and the app says so on the card.

YOUR OWN RATINGS WIN
--------------------
Anything in raw-data/school-ratings/*.csv overrides the computed value. Two
columns, `school` and `rating`; a `district` column is used to break ties
between schools that share a name. If you look up your shortlist on
GreatSchools by hand, drop it in there and the map uses your numbers.

WHAT YOU NEED
-------------
Nothing, if the downloads work: the script fetches both files itself.

  1. CAASPP Smarter Balanced research file (the test scores)
  2. CDE public school directory (names, levels, coordinates, NCES IDs)

If a download fails - CDE moves these URLs - the script says exactly which
file to fetch and where to put it, and picks it up from raw-data/ next run.

Run:  python scripts/fetch-school-data.py
Output: js/data/schools-la-county.json
"""

import argparse
import csv
import datetime
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
import zipfile

SCHEMA_VERSION = 1
LA_COUNTY_CODE = "19"  # CDS county code for Los Angeles

DEFAULT_OUT = os.path.join("js", "data", "schools-la-county.json")
RAW_DIR = "raw-data"
OVERRIDE_DIR = os.path.join("raw-data", "school-ratings")

# CDE republishes these every year and has moved them before, so each is a
# candidate list and the script reports which one answered.
CAASPP_URLS = [
    "https://caaspp-elpac.ets.org/caaspp/researchfiles/sb_ca2025_all_csv_v1.zip",
    "https://caaspp-elpac.ets.org/caaspp/researchfiles/sb_ca2024_all_csv_v1.zip",
    "https://caaspp-elpac.ets.org/caaspp/researchfiles/sb_ca2023_all_csv_v1.zip",
]
DIRECTORY_URLS = [
    "https://www.cde.ca.gov/schooldirectory/report?rid=dl1&tp=txt&ict=Y",
    "https://www.cde.ca.gov/schooldirectory/report?rid=dl1&tp=txt",
]

# Local fallbacks, if the downloads are blocked and you fetch by hand.
CAASPP_LOCAL = os.path.join(RAW_DIR, "caaspp-sb-research-file.txt")
DIRECTORY_LOCAL = os.path.join(RAW_DIR, "pubschls.txt")

# CAASPP research file columns. Named in recent years; older files ship the
# same order without a header, which is why POSITIONS exists below.
CAASPP_COLUMNS = {
    "county": ["County Code", "CountyCode"],
    "district": ["District Code", "DistrictCode"],
    "school": ["School Code", "SchoolCode"],
    "subgroup": ["Subgroup ID", "SubgroupID", "Demographic Id", "DemographicID"],
    "grade": ["Grade"],
    "test": ["Test Id", "TestID", "Test ID"],
    "tested": ["Students with Scores", "StudentsWithScores", "Total Tested with Scores"],
    "met": [
        "Percentage Standard Met and Above",
        "PercentageStandardMetAndAbove",
        "Percent Standard Met and Above",
    ],
}

# The 2015-2018 files have no header row. Field order has been stable.
CAASPP_POSITIONS = {
    "county": 0, "district": 1, "school": 2, "grade": 5,
    "test": 8, "subgroup": 4, "tested": 10, "met": 15,
}

DIRECTORY_COLUMNS = {
    "cds": ["CDSCode"],
    "name": ["School"],
    "district": ["District"],
    "status": ["StatusType"],
    "soc": ["SOC"],
    "grades": ["GSoffered", "GSserved"],
    "lat": ["Latitude"],
    "lon": ["Longitude"],
    "street": ["Street", "StreetAbr"],
    "city": ["City"],
    "zip": ["Zip"],
    "charter": ["Charter"],
    "nces_district": ["NCESDist"],
    "nces_school": ["NCESSchool"],
    "county_name": ["County"],
}

ALL_STUDENTS_SUBGROUP = "1"
ALL_GRADES = "13"
TEST_ELA = "1"
TEST_MATH = "2"

# A rating resting on a handful of test-takers is noise. CDE itself suppresses
# below 11; this is deliberately stricter, because a decile computed from 15
# children moves wildly year to year.
MIN_TESTED = 25

# A decile needs a population to be a decile. With five schools at a level,
# "rated 1 of 10" means "came last out of five", which reads as a damning
# verdict and is nearly meaningless. Below this, that level gets no ratings at
# all and the run says so.
MIN_SCHOOLS_FOR_RANKING = 20


class SchoolDataError(Exception):
    pass


# --- Small helpers -----------------------------------------------------------


def find_column(header, candidates, label):
    lowered = {h.lower().strip(): h for h in header}
    for candidate in candidates:
        if candidate.lower() in lowered:
            return lowered[candidate.lower()]
    for candidate in candidates:
        for key, original in lowered.items():
            if candidate.lower() in key:
                return original
    raise SchoolDataError(
        f"could not find the {label} column.\n"
        f"  Looked for: {', '.join(candidates)}\n"
        f"  The file has: {', '.join(sorted(header)[:40])}{' ...' if len(header) > 40 else ''}"
    )


def to_float(value):
    try:
        text = str(value).strip()
        if not text or text == "*":
            return None
        return float(text.replace("%", "").replace(",", ""))
    except (TypeError, ValueError):
        return None


def to_int(value):
    number = to_float(value)
    return int(number) if number is not None else None


def normalise_name(name):
    """School names differ across files: 'Roosevelt Elementary' vs
    'Roosevelt El' vs 'Theodore Roosevelt Elementary School'. This strips the
    parts that vary so the three files can be joined on what is left."""
    text = (name or "").lower()
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    text = re.sub(
        r"\b(elementary|elem|el|middle|mid|junior|jr|senior|sr|high|hs|school|academy|center|centre)\b",
        " ",
        text,
    )
    return re.sub(r"\s+", " ", text).strip()


def download(urls, label):
    """Try each candidate URL, report which answered."""
    problems = []
    for url in urls:
        try:
            print(f"  {label}: trying {url}")
            request = urllib.request.Request(
                url, headers={"User-Agent": "la-home-map/1.0 (personal house hunting)"}
            )
            with urllib.request.urlopen(request, timeout=180) as response:
                data = response.read()
            print(f"  {label}: got {len(data):,} bytes")
            return data
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as err:
            problems.append(f"{url}: {err}")
    raise SchoolDataError(
        f"could not download the {label}.\n  "
        + "\n  ".join(problems)
    )


# --- Level ------------------------------------------------------------------

# SOC is the CDE's "School Ownership Code" - its type. These are the codes
# that mean a regular school of each level. Grade span is used as a backstop,
# because a K-8 carries a middle-school-ish SOC in some years.
SOC_LEVELS = {
    "60": "elementary",  # Elementary School (Public)
    "61": "elementary",  # Elementary School in 1 School District
    "62": "middle",      # Intermediate/Middle
    "63": "middle",      # Junior High
    "64": "high",        # High School
    "65": "high",        # High School in 1 School District
    "66": "high",        # Continuation
    "67": "high",        # Alternative
}


def grade_bounds(span):
    """Turn a grade span like 'K-5' or '9-12' into (low, high) as numbers."""
    text = (span or "").upper().replace("PRESCHOOL", "P").strip()
    if not text:
        return None
    parts = re.split(r"[-–]", text)
    def value(token):
        token = token.strip()
        if token in ("K", "P", "PK", "TK", "PS", "ADULT"):
            return 0
        digits = re.sub(r"[^0-9]", "", token)
        return int(digits) if digits else None
    low = value(parts[0])
    high = value(parts[-1]) if len(parts) > 1 else low
    if low is None or high is None:
        return None
    return low, high


def school_level(soc, grades):
    """Which of the three switches this school belongs under.

    Grade span leads and SOC is the fallback, the opposite of what seems
    natural - because the span is what a parent actually cares about, and a
    K-8 is genuinely both an elementary and a middle school. Such a school is
    returned as 'elementary' here and re-tagged as 'both' by the caller.
    """
    bounds = grade_bounds(grades)
    if bounds:
        low, high = bounds
        if high <= 6:
            return "elementary"
        if low >= 9:
            return "high"
        if low >= 6 and high <= 8:
            return "middle"
        if low <= 5 and high >= 7:
            return "elementary"  # a K-8; the caller widens this
        if low >= 7 and high >= 9:
            return "high"
    return SOC_LEVELS.get(str(soc or "").strip())


def spans_levels(grades):
    """Every level a grade span touches, for a school that straddles two."""
    bounds = grade_bounds(grades)
    if not bounds:
        return []
    low, high = bounds
    levels = []
    if low <= 5:
        levels.append("elementary")
    if low <= 8 and high >= 6:
        levels.append("middle")
    if high >= 9:
        levels.append("high")
    return levels


# --- The directory -----------------------------------------------------------


def read_directory(data):
    """CDE's public school file: names, type, grade span, coordinates."""
    text = data.decode("utf-8-sig", errors="replace") if isinstance(data, bytes) else data
    reader = csv.reader(io.StringIO(text), delimiter="\t")
    try:
        header = next(reader)
    except StopIteration:
        raise SchoolDataError("the school directory file is empty.")

    columns = {
        key: find_column(header, candidates, key)
        for key, candidates in DIRECTORY_COLUMNS.items()
    }
    index = {name: position for position, name in enumerate(header)}

    schools = {}
    skipped_closed = 0
    skipped_county = 0
    for row in reader:
        if len(row) < len(header):
            continue
        def cell(key):
            return row[index[columns[key]]].strip()

        cds = cell("cds")
        if len(cds) < 14 or cds[:2] != LA_COUNTY_CODE:
            skipped_county += 1
            continue
        # Closed and merged schools are still listed. Drawing them puts dots
        # and polygons on buildings that are not schools any more.
        if cell("status").lower() != "active":
            skipped_closed += 1
            continue

        grades = cell("grades")
        level = school_level(cell("soc"), grades)
        if not level:
            continue

        lat = to_float(cell("lat"))
        lon = to_float(cell("lon"))
        nces_school = cell("nces_school")
        nces_district = cell("nces_district")
        # SABS joins on the 12-character NCES school ID, which is the district
        # ID followed by the school ID.
        nces = (
            f"{nces_district.zfill(7)}{nces_school.zfill(5)}"
            if nces_district and nces_school
            else None
        )

        schools[cds] = {
            "cds": cds,
            "name": cell("name"),
            "district": cell("district"),
            "level": level,
            "levels": spans_levels(grades) or [level],
            "grades": grades,
            "charter": cell("charter").lower() in ("y", "yes", "1"),
            "address": ", ".join(
                part for part in [cell("street"), cell("city"), cell("zip")] if part
            ),
            "lat": lat,
            "lon": lon,
            "nces": nces,
        }

    if not schools:
        raise SchoolDataError(
            "the directory had no active LA County schools in it - the file "
            "may have changed shape, or the download returned an error page."
        )
    print(
        f"  Directory: {len(schools):,} active LA County schools "
        f"({skipped_closed:,} closed skipped, {skipped_county:,} outside the county)"
    )
    return schools


# --- The test scores ---------------------------------------------------------


def read_caaspp(data):
    """Percent met-or-exceeded in ELA and Math, per school, all students."""
    if isinstance(data, bytes) and data[:2] == b"PK":
        archive = zipfile.ZipFile(io.BytesIO(data))
        names = [n for n in archive.namelist() if n.lower().endswith((".txt", ".csv"))]
        if not names:
            raise SchoolDataError("the CAASPP zip had no data file in it.")
        # The all-entities file is the big one.
        name = max(names, key=lambda n: archive.getinfo(n).file_size)
        print(f"  CAASPP: reading {name} from the zip")
        text = archive.read(name).decode("utf-8-sig", errors="replace")
    else:
        text = data.decode("utf-8-sig", errors="replace") if isinstance(data, bytes) else data

    sample = text[:4000]
    delimiter = "^" if sample.count("^") > sample.count(",") else ","
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    try:
        first = next(reader)
    except StopIteration:
        raise SchoolDataError("the CAASPP file is empty.")

    # A header row has non-numeric first cell; an old file starts with a code.
    has_header = not re.fullmatch(r"\d+", (first[0] or "").strip())
    if has_header:
        columns = {
            key: first.index(find_column(first, candidates, key))
            for key, candidates in CAASPP_COLUMNS.items()
        }
        print(f"  CAASPP: header found, {delimiter!r}-delimited")
    else:
        columns = dict(CAASPP_POSITIONS)
        print(f"  CAASPP: no header, using known field order, {delimiter!r}-delimited")
        reader = io.StringIO(text)
        reader = csv.reader(reader, delimiter=delimiter)

    scores = {}
    rows = 0
    for row in reader:
        rows += 1
        if len(row) <= max(columns.values()):
            continue
        def cell(key):
            return (row[columns[key]] or "").strip()

        if cell("county") != LA_COUNTY_CODE:
            continue
        if cell("subgroup") != ALL_STUDENTS_SUBGROUP:
            continue
        if cell("grade") != ALL_GRADES:
            continue
        school_code = cell("school")
        # School code 0000000 is a district or county total, not a school.
        if not school_code or school_code == "0000000":
            continue
        test = cell("test")
        if test not in (TEST_ELA, TEST_MATH):
            continue
        met = to_float(cell("met"))
        tested = to_int(cell("tested"))
        if met is None or not tested:
            continue

        cds = f"{cell('county')}{cell('district').zfill(5)}{school_code.zfill(7)}"
        entry = scores.setdefault(cds, {})
        entry["ela" if test == TEST_ELA else "math"] = met
        entry["tested"] = max(entry.get("tested", 0), tested)

    print(f"  CAASPP: {rows:,} rows read, {len(scores):,} LA County schools with scores")
    if not scores:
        raise SchoolDataError(
            "no LA County school scores were found. The file may be a different "
            "year's layout - check the first few lines and add the column names "
            "to CAASPP_COLUMNS."
        )
    return scores


# --- Ratings -----------------------------------------------------------------


def decile_ratings(values):
    """Rank values into 1-10, where 10 is best.

    Ties share a rating. Written against the sorted position rather than the
    value range on purpose: proficiency percentages bunch up, and cutting the
    RANGE into ten would put most schools in three bands.
    """
    if not values:
        return {}
    ordered = sorted(values.items(), key=lambda pair: pair[1])
    total = len(ordered)
    ratings = {}
    previous_value = None
    previous_rating = None
    for position, (key, value) in enumerate(ordered):
        if previous_value is not None and abs(value - previous_value) < 1e-9:
            ratings[key] = previous_rating
            continue
        rating = int(position * 10 / total) + 1
        rating = min(10, max(1, rating))
        ratings[key] = rating
        previous_value = value
        previous_rating = rating
    return ratings


def read_overrides():
    """Your own ratings, which beat anything computed here."""
    overrides = {}
    if not os.path.isdir(OVERRIDE_DIR):
        return overrides
    for filename in sorted(os.listdir(OVERRIDE_DIR)):
        if not filename.lower().endswith(".csv"):
            continue
        path = os.path.join(OVERRIDE_DIR, filename)
        with open(path, newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames:
                continue
            lowered = {name.lower().strip(): name for name in reader.fieldnames}
            name_key = lowered.get("school") or lowered.get("name")
            rating_key = lowered.get("rating") or lowered.get("greatschools")
            district_key = lowered.get("district")
            if not name_key or not rating_key:
                print(f"  Overrides: {filename} has no school/rating columns - skipped")
                continue
            count = 0
            for row in reader:
                rating = to_float(row.get(rating_key))
                name = (row.get(name_key) or "").strip()
                if rating is None or not name:
                    continue
                key = normalise_name(name)
                district = normalise_name(row.get(district_key) or "") if district_key else ""
                overrides[(key, district)] = round(rating, 1)
                count += 1
            print(f"  Overrides: {count} ratings from {filename}")
    return overrides


def match_override(school, overrides):
    if not overrides:
        return None
    key = normalise_name(school["name"])
    district = normalise_name(school["district"])
    return overrides.get((key, district)) or overrides.get((key, ""))


# --- Assembly ----------------------------------------------------------------


def build(directory, scores, overrides):
    # Join scores onto the directory, and work out the proficiency each
    # school's rating will be ranked on.
    proficiency = {}
    for cds, school in directory.items():
        entry = scores.get(cds)
        if not entry:
            continue
        parts = [entry[key] for key in ("ela", "math") if key in entry]
        if not parts or (entry.get("tested") or 0) < MIN_TESTED:
            continue
        school["ela"] = round(entry.get("ela"), 1) if "ela" in entry else None
        school["math"] = round(entry.get("math"), 1) if "math" in entry else None
        school["tested"] = entry.get("tested")
        proficiency[cds] = sum(parts) / len(parts)

    # Rank within level. A school spanning two levels is ranked in each, so a
    # K-8 gets an elementary rating and a middle rating that are both fair
    # against their own peers.
    ratings_by_level = {}
    unranked_levels = []
    for level in ("elementary", "middle", "high"):
        subset = {
            cds: value
            for cds, value in proficiency.items()
            if level in directory[cds]["levels"]
        }
        if len(subset) < MIN_SCHOOLS_FOR_RANKING:
            ratings_by_level[level] = {}
            if subset:
                unranked_levels.append(f"{level} ({len(subset)} schools)")
            continue
        ratings_by_level[level] = decile_ratings(subset)

    out = {}
    by_nces = {}
    by_name = {}
    counts = {"elementary": 0, "middle": 0, "high": 0}
    rated = 0
    overridden = 0

    for cds, school in directory.items():
        levels = school["levels"]
        ratings = {}
        for level in levels:
            value = ratings_by_level.get(level, {}).get(cds)
            if value is not None:
                ratings[level] = value

        override = match_override(school, overrides)
        if override is not None:
            for level in levels:
                ratings[level] = override
            overridden += 1

        record = {
            "name": school["name"],
            "district": school["district"],
            "levels": levels,
            "grades": school["grades"],
            "address": school["address"],
            "lat": school["lat"],
            "lon": school["lon"],
        }
        if school.get("charter"):
            record["charter"] = True
        if school.get("nces"):
            record["nces"] = school["nces"]
        if ratings:
            record["ratings"] = ratings
            rated += 1
        if override is not None:
            record["ratingSource"] = "yours"
        for key in ("ela", "math", "tested"):
            if school.get(key) is not None:
                record[key] = school[key]

        out[cds] = record
        for level in levels:
            counts[level] = counts.get(level, 0) + 1
        if school.get("nces"):
            by_nces[school["nces"]] = cds
        key = normalise_name(school["name"])
        if key:
            # A name collision keeps the first; the NCES index is the reliable
            # join and this is only the fallback.
            by_name.setdefault(key, cds)

    return out, by_nces, by_name, counts, rated, overridden, unranked_levels


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=DEFAULT_OUT, help="Output JSON path")
    parser.add_argument("--caaspp", default=None, help="Local CAASPP research file")
    parser.add_argument("--directory", default=None, help="Local CDE pubschls.txt")
    args = parser.parse_args(argv)

    print("Building LA County school ratings.\n")

    try:
        print("Directory (CA Dept of Education public schools):")
        local_directory = args.directory or (
            DIRECTORY_LOCAL if os.path.exists(DIRECTORY_LOCAL) else None
        )
        if local_directory:
            print(f"  Using local file {local_directory}")
            with open(local_directory, "rb") as handle:
                directory_data = handle.read()
        else:
            directory_data = download(DIRECTORY_URLS, "directory")
        directory = read_directory(directory_data)

        print("\nTest scores (CAASPP Smarter Balanced):")
        local_caaspp = args.caaspp or (CAASPP_LOCAL if os.path.exists(CAASPP_LOCAL) else None)
        if local_caaspp:
            print(f"  Using local file {local_caaspp}")
            with open(local_caaspp, "rb") as handle:
                caaspp_data = handle.read()
        else:
            caaspp_data = download(CAASPP_URLS, "CAASPP research file")
        scores = read_caaspp(caaspp_data)

        print("\nYour own ratings:")
        overrides = read_overrides()
        if not overrides:
            print(f"  None found. Drop CSVs in {OVERRIDE_DIR}/ to override any of these.")

    except SchoolDataError as err:
        print(f"\nCould not build the school data: {err}", file=sys.stderr)
        print(
            "\nTo fetch the files by hand:\n"
            f"  1. Directory: https://www.cde.ca.gov/ds/si/ds/pubschls.asp\n"
            f"     Save the tab-delimited file as {DIRECTORY_LOCAL}\n"
            f"  2. Test scores: https://caaspp-elpac.ets.org/caaspp/ResearchFileListSB\n"
            f"     Save the 'All Student Groups' research file as {CAASPP_LOCAL}\n"
            "  Then run this script again.",
            file=sys.stderr,
        )
        return 1

    schools, by_nces, by_name, counts, rated, overridden, unranked = build(directory, scores, overrides)

    payload = {
        "meta": {
            "generated": datetime.date.today().isoformat(),
            "schemaVersion": SCHEMA_VERSION,
            "county": "Los Angeles",
            "ratingBasis": (
                "Decile of CAASPP percent met-or-exceeded (ELA and Math averaged), "
                "ranked against other LA County schools at the same level. 10 is best. "
                "This is not the GreatSchools rating."
            ),
            "minTested": MIN_TESTED,
            "minSchoolsForRanking": MIN_SCHOOLS_FOR_RANKING,
            "unrankedLevels": unranked,
            "counts": counts,
            "rated": rated,
            "overridden": overridden,
            "sources": [
                "CA Dept of Education, Public Schools and Districts (pubschls)",
                "CAASPP Smarter Balanced research file, all student groups",
            ],
        },
        "schools": schools,
        "byNces": by_nces,
        "byName": by_name,
    }

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))

    size = os.path.getsize(args.out)
    print(f"\nWrote {args.out} ({size / 1024:.0f} KB)")
    print(f"  {len(schools):,} schools: {counts['elementary']:,} elementary, "
          f"{counts['middle']:,} middle, {counts['high']:,} high")
    print(f"  {rated:,} carry a rating; {len(schools) - rated:,} have too few test-takers "
          f"(under {MIN_TESTED}) or no scores")
    if overridden:
        print(f"  {overridden:,} use YOUR rating instead of the computed one")
    if unranked:
        print(
            f"  No ratings for {', '.join(unranked)} - too few schools to rank into "
            f"deciles (need {MIN_SCHOOLS_FOR_RANKING})"
        )
    print("\nReload the page. The three school switches will use this file.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
