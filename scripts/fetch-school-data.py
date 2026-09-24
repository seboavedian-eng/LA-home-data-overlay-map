#!/usr/bin/env python3
"""
Attach YOUR GreatSchools ratings to every LA County public school the map
draws, so the three rating filters and every school popup use them.

WHERE THE RATINGS COME FROM
---------------------------
One place only: the table(s) you put in raw-data/school-ratings/*.csv. Nothing
is computed. A school your table does not list has no rating, and a rating
filter hides it - an unrated school cannot be said to have passed.

The columns this reads, by name (case and a trailing "?" do not matter):

    School Name, Address, City, Zip, Elementary, Middle?, High?, GreatSchools Rating

Optional: a `CDS` or `NCES` column, which beats every other way of matching.
Use it to pin down any row the match report says it could not place.

WHY THE STATE DIRECTORY IS STILL DOWNLOADED
-------------------------------------------
Your table says which school and what rating. The map needs to know which
DOT and which ZONE that is, and those carry the state's identifiers, not
names:

    your row  --(address + zip)-->  CDE directory  --CDS code-->  school dot
                                                   --NCES id--->  attendance zone

Matching on address + zip is what makes this reliable. Names alone are not:
"Eagle Rock Elementary" and "Eagle Rock High" are both LAUSD, and a name
matcher that ignores the level word gives them the same rating. Two schools
sharing one address (iLEAD Hybrid and iLEAD Online do) are told apart by name.

EVERY ROW IS ACCOUNTED FOR
--------------------------
The run writes raw-data/school-ratings-match-report.csv: one line per row of
your table, saying whether it matched, how, and to which state record - and
for the ones that did not, why. Nothing is dropped silently.

WHAT YOU NEED
-------------
Your table, and the CDE directory, which this script downloads itself. If the
download fails - CDE moves these URLs - the script says exactly which file to
fetch and where to put it, and picks it up from raw-data/ next run.

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

# 2: ratings come only from your table, byName maps to a LIST of schools.
SCHEMA_VERSION = 2
LA_COUNTY_CODE = "19"  # CDS county code for Los Angeles

DEFAULT_OUT = os.path.join("js", "data", "schools-la-county.json")
RAW_DIR = "raw-data"
RATINGS_DIR = os.path.join("raw-data", "school-ratings")
# Outside RATINGS_DIR on purpose: every CSV in there is read as a ratings table.
REPORT_PATH = os.path.join("raw-data", "school-ratings-match-report.csv")

# CDE republishes this and has moved it before, so it is a candidate list and
# the script reports which one answered.
DIRECTORY_URLS = [
    "https://www.cde.ca.gov/schooldirectory/report?rid=dl1&tp=txt&ict=Y",
    "https://www.cde.ca.gov/schooldirectory/report?rid=dl1&tp=txt",
]

# Local fallback, if the download is blocked and you fetch it by hand.
DIRECTORY_LOCAL = os.path.join(RAW_DIR, "pubschls.txt")

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

# Your table's columns, by candidate name. Matched after lower-casing and
# dropping a trailing "?", so "High?" and "high" are the same column.
RATING_COLUMNS = {
    "name": ["school name", "school", "name"],
    "address": ["address", "street address", "street"],
    "city": ["city"],
    "zip": ["zip", "zip code", "zipcode", "postal code"],
    "elementary": ["elementary", "elementary school", "elem"],
    "middle": ["middle", "middle school"],
    "high": ["high", "high school"],
    "rating": ["greatschools rating", "rating", "greatschools", "gs rating"],
    "cds": ["cds", "cds code", "cdscode"],
    "nces": ["nces", "nces id", "ncessch"],
}
REQUIRED_RATING_COLUMNS = ("name", "rating")
LEVELS = ("elementary", "middle", "high")


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
            # Kept apart for matching your table: see match_row().
            "city": cell("city"),
            "zip5": zip5(cell("zip")),
            "address_key": address_key(cell("street")),
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


# --- Your table --------------------------------------------------------------


def yes(value):
    return str(value or "").strip().lower() in ("yes", "y", "true", "1", "x")


def column_map(fieldnames):
    """Which of your columns is which, tolerant of case and a trailing '?'."""
    flat = {}
    for original in fieldnames or []:
        key = re.sub(r"\s+", " ", (original or "").strip().lower().rstrip("?").strip())
        flat.setdefault(key, original)
    found = {}
    for field, candidates in RATING_COLUMNS.items():
        for candidate in candidates:
            if candidate in flat:
                found[field] = flat[candidate]
                break
    return found


def read_ratings(folder=None):
    """Every row of every CSV in raw-data/school-ratings/, with its line number
    kept so the report can point you straight back at it."""
    folder = folder or RATINGS_DIR
    rows = []
    if not os.path.isdir(folder):
        return rows
    for filename in sorted(os.listdir(folder)):
        if not filename.lower().endswith(".csv"):
            continue
        path = os.path.join(folder, filename)
        with open(path, "rb") as handle:
            data = handle.read()
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            # Excel's plain "CSV (Comma delimited)" on Windows writes cp1252,
            # not UTF-8, and the first accented school name would stop the run.
            text = data.decode("cp1252", errors="replace")
            print(f"  {filename}: not UTF-8, read as Windows-1252 (Excel's default)")
        reader = csv.DictReader(io.StringIO(text, newline=""))
        columns = column_map(reader.fieldnames)
        missing = [c for c in REQUIRED_RATING_COLUMNS if c not in columns]
        if missing:
            print(
                f"  {filename}: no {' or '.join(missing)} column - skipped. "
                f"It has: {', '.join(reader.fieldnames or [])}"
            )
            continue
        has_levels = any(level in columns for level in LEVELS)
        count = 0
        for line, raw in enumerate(reader, start=2):  # line 1 is the header
            def cell(field):
                column = columns.get(field)
                return (raw.get(column) or "").strip() if column else ""

            if not any((value or "").strip() for value in raw.values() if isinstance(value, str)):
                continue  # a blank line at the end of a spreadsheet export
            rows.append({
                "file": filename,
                "line": line,
                "name": cell("name"),
                "address": cell("address"),
                "city": cell("city"),
                "zip": zip5(cell("zip")),
                "levels": [level for level in LEVELS if yes(cell(level))] if has_levels else None,
                "rating_text": cell("rating"),
                "rating": to_float(cell("rating")),
                "cds": re.sub(r"\D", "", cell("cds")),
                "nces": re.sub(r"\D", "", cell("nces")),
            })
            count += 1
        print(f"  {filename}: {count} rows")
    return rows


# --- Matching a row to a state record -----------------------------------------

DIRECTIONS = {"north": "n", "south": "s", "east": "e", "west": "w",
              "northeast": "ne", "northwest": "nw", "southeast": "se", "southwest": "sw"}
SUFFIXES = {
    "street": "st", "avenue": "ave", "av": "ave", "road": "rd", "drive": "dr",
    "boulevard": "blvd", "blv": "blvd", "lane": "ln", "place": "pl", "court": "ct",
    "circle": "cir", "highway": "hwy", "parkway": "pkwy", "terrace": "ter",
    "way": "way", "trail": "trl", "square": "sq",
}
SUFFIX_FORMS = set(SUFFIXES.values())
UNIT_WORDS = {"suite", "ste", "unit", "apt", "room", "rm", "bldg", "building"}


def zip5(value):
    digits = re.sub(r"\D", "", str(value or ""))
    return digits[:5] if len(digits) >= 5 else ""


def address_key(street):
    """(house number, set of street-name words) - the parts two spellings of
    one address agree on. "3015 West Sacramento St." and "3015 W. Sacramento
    Street" both become ("3015", {"sacramento"})."""
    text = re.sub(r"[.,]", " ", (street or "").lower())
    text = re.sub(r"#\s*\S+", " ", text)
    tokens = text.split()
    for position, token in enumerate(tokens):
        if token in UNIT_WORDS:
            tokens = tokens[:position]
            break
    if not tokens:
        return None
    number = re.match(r"\d+", tokens[0])
    if not number:
        return None
    core = set()
    for token in tokens[1:]:
        token = DIRECTIONS.get(token, SUFFIXES.get(token, token))
        if token in DIRECTIONS.values() or token in SUFFIX_FORMS:
            continue
        core.add(token)
    return number.group(0), core


def same_address(left, right):
    if not left or not right or left[0] != right[0]:
        return False
    # The number matched. The street must share a word, unless one side is
    # just a number, which cannot contradict anything.
    return not left[1] or not right[1] or bool(left[1] & right[1])


NAME_SYNONYMS = {"el": "elementary", "elem": "elementary", "es": "elementary",
                 "ms": "middle", "hs": "high", "sr": "senior", "jr": "junior",
                 "acad": "academy", "ctr": "center", "centre": "center", "&": "and"}
NAME_STOP = {"school", "the", "of", "and", "a"}


def name_tokens(name):
    """Unlike normalise_name, this KEEPS the level words: they are exactly what
    tells Eagle Rock Elementary from Eagle Rock High."""
    text = re.sub(r"[^a-z0-9& ]+", " ", (name or "").lower())
    tokens = {NAME_SYNONYMS.get(token, token) for token in text.split()}
    return tokens - NAME_STOP


def name_similarity(left, right):
    a, b = name_tokens(left), name_tokens(right)
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


class Directory:
    """The state records, indexed the ways a row can be matched."""

    def __init__(self, schools):
        self.schools = schools
        self.by_zip = {}
        self.by_nces = {}
        self.tokens = {cds: name_tokens(school["name"]) for cds, school in schools.items()}
        for cds, school in schools.items():
            self.by_zip.setdefault(school.get("zip5", ""), []).append(cds)
            if school.get("nces"):
                self.by_nces[school["nces"]] = cds

    def best_by_name(self, row, candidates):
        scored = sorted(
            ((name_similarity(row["name"], self.schools[cds]["name"]), cds) for cds in candidates),
            reverse=True,
        )
        if not scored:
            return None, 0.0, 0.0
        best_score, best = scored[0]
        second = scored[1][0] if len(scored) > 1 else 0.0
        return best, best_score, second


# How much better the best name has to be than the runner-up before it is
# believed. Below this, two candidates are too close to call and the row is
# reported as ambiguous rather than guessed.
NAME_MARGIN = 0.15
NAME_ALONE = 0.6        # a name match with no address behind it must be strong
NAME_TIEBREAK = 0.25    # breaking a tie between schools at one address is easier


def match_row(row, directory):
    """Returns (cds or None, how, note)."""
    schools = directory.schools
    if row["cds"]:
        if row["cds"] in schools:
            return row["cds"], "your CDS code", ""
        return None, "", f"CDS code {row['cds']} is not an active LA County school"
    if row["nces"]:
        cds = directory.by_nces.get(row["nces"].zfill(12))
        if cds:
            return cds, "your NCES id", ""
        return None, "", f"NCES id {row['nces']} is not an active LA County school"

    in_zip = directory.by_zip.get(row["zip"], []) if row["zip"] else []
    key = address_key(row["address"])
    at_address = [cds for cds in in_zip if same_address(key, schools[cds].get("address_key"))]

    if len(at_address) == 1:
        return at_address[0], "address + zip", ""
    if len(at_address) > 1:
        best, score, second = directory.best_by_name(row, at_address)
        if score >= NAME_TIEBREAK and score - second >= NAME_MARGIN:
            return best, "address + zip, name broke the tie", ""
        names = "; ".join(schools[cds]["name"] for cds in at_address)
        return None, "", f"ambiguous: {len(at_address)} schools at this address ({names}) - add a CDS column"

    if in_zip:
        best, score, second = directory.best_by_name(row, in_zip)
        if score >= NAME_ALONE and score - second >= NAME_MARGIN:
            return best, "name + zip (address differs)", f"state address: {schools[best]['address']}"

    # Last resort: an identical name in the same city, anywhere in the county.
    city = (row["city"] or "").strip().lower()
    wanted = name_tokens(row["name"])
    same = [
        cds for cds, school in schools.items()
        if wanted and directory.tokens[cds] == wanted
        and (not city or school.get("city", "").lower() == city)
    ]
    if len(same) == 1:
        return same[0], "name + city", f"state address: {schools[same[0]]['address']}"
    if len(same) > 1:
        return None, "", f"ambiguous: {len(same)} schools called this in {row['city'] or 'the county'}"

    if not row["zip"]:
        return None, "", "no zip, and the name alone did not identify one school"
    return None, "", "no active LA County school at this address or with this name in this zip"


# --- Assembly ----------------------------------------------------------------


def build(directory_schools, rows):
    directory = Directory(directory_schools)
    ratings = {}          # cds -> {level: rating}
    claimed = {}          # cds -> the row that took it first
    report = []
    stats = {"rows": len(rows), "matched": 0, "unmatched": 0, "ambiguous": 0,
             "duplicate": 0, "invalid": 0, "matchedBy": {}}

    for row in rows:
        entry = {
            "file": row["file"], "line": row["line"], "school": row["name"],
            "address": row["address"], "zip": row["zip"], "rating": row["rating_text"],
            "outcome": "", "matched_by": "", "cds": "", "nces": "",
            "state_name": "", "state_address": "", "levels": "", "note": "",
        }
        report.append(entry)

        rating = row["rating"]
        if rating is None or not 1 <= rating <= 10:
            entry["outcome"] = "invalid"
            entry["note"] = f"rating {row['rating_text']!r} is not a number from 1 to 10"
            stats["invalid"] += 1
            continue

        cds, how, note = match_row(row, directory)
        entry["note"] = note
        if not cds:
            outcome = "ambiguous" if note.startswith("ambiguous") else "unmatched"
            entry["outcome"] = outcome
            stats[outcome] += 1
            continue

        school = directory_schools[cds]
        entry.update(cds=cds, nces=school.get("nces") or "", state_name=school["name"],
                     state_address=school["address"])

        if cds in claimed:
            first = claimed[cds]
            entry["outcome"] = "duplicate"
            entry["note"] = (
                f"same state school as {first['file']} line {first['line']} ({first['name']}); "
                "the first row's rating is used"
            )
            stats["duplicate"] += 1
            continue
        claimed[cds] = row

        # Your level columns decide which switches the rating counts under.
        # With no level columns at all, the state's grade span decides.
        levels = row["levels"] if row["levels"] is not None else school["levels"]
        if not levels:
            levels = school["levels"]
            entry["note"] = "; ".join(filter(None, [entry["note"], "no level marked Yes - used the state's grade span"]))
        stated = set(school["levels"])
        extra = [level for level in levels if level not in stated]
        if extra:
            entry["note"] = "; ".join(filter(None, [
                entry["note"],
                f"you marked {', '.join(extra)}; the state lists grades {school['grades'] or 'unknown'} - yours is used",
            ]))
        ratings[cds] = {level: round(rating, 1) for level in levels}
        entry["levels"] = " ".join(levels)
        entry["outcome"] = "matched"
        entry["matched_by"] = how
        stats["matched"] += 1
        stats["matchedBy"][how] = stats["matchedBy"].get(how, 0) + 1

    out = {}
    by_nces = {}
    by_name = {}
    counts = {"elementary": 0, "middle": 0, "high": 0}
    for cds, school in directory_schools.items():
        levels = list(school["levels"])
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
            by_nces[school["nces"]] = cds
        if cds in ratings:
            record["ratings"] = ratings[cds]
            record["ratingSource"] = "greatschools"
            for level in ratings[cds]:
                if level not in levels:
                    levels.append(level)
        out[cds] = record
        for level in levels:
            counts[level] = counts.get(level, 0) + 1
        key = normalise_name(school["name"])
        if key:
            # A LIST, because names collide: the page picks among them by level
            # and by distance, and gives up rather than guess when it cannot.
            by_name.setdefault(key, []).append(cds)

    return out, by_nces, by_name, counts, stats, report


REPORT_COLUMNS = ["file", "line", "outcome", "school", "address", "zip", "rating", "levels",
                  "matched_by", "state_name", "state_address", "cds", "nces", "note"]


def write_report(report, path):
    # Problems first: the rows you need to act on should not be at line 900.
    order = {"unmatched": 0, "ambiguous": 1, "invalid": 2, "duplicate": 3, "matched": 4}
    ordered = sorted(report, key=lambda e: (order.get(e["outcome"], 9), e["file"], e["line"]))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=REPORT_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(ordered)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=DEFAULT_OUT, help="Output JSON path")
    parser.add_argument("--directory", default=None, help="Local CDE pubschls.txt")
    parser.add_argument("--ratings", default=None, help=f"Folder of rating CSVs (default {RATINGS_DIR})")
    parser.add_argument("--report", default=REPORT_PATH, help="Where to write the match report")
    args = parser.parse_args(argv)
    ratings_dir = args.ratings or RATINGS_DIR

    print("Attaching your GreatSchools ratings to LA County schools.\n")

    print(f"Your ratings ({ratings_dir}/):")
    rows = read_ratings(ratings_dir)
    if not rows:
        print(
            f"\nNo ratings found. Put your table in {ratings_dir}/ as a CSV with at least\n"
            "'School Name' and 'GreatSchools Rating' columns (Address, Zip and the\n"
            "Elementary / Middle? / High? columns make the match reliable), then run this again.",
            file=sys.stderr,
        )
        return 1

    try:
        print("\nDirectory (CA Dept of Education public schools):")
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
    except SchoolDataError as err:
        print(f"\nCould not build the school data: {err}", file=sys.stderr)
        print(
            "\nTo fetch the directory by hand:\n"
            f"  https://www.cde.ca.gov/ds/si/ds/pubschls.asp\n"
            f"  Save the tab-delimited file as {DIRECTORY_LOCAL}, then run this script again.",
            file=sys.stderr,
        )
        return 1

    schools, by_nces, by_name, counts, stats, report = build(directory, rows)
    rated = sum(1 for s in schools.values() if "ratings" in s)
    files = sorted({row["file"] for row in rows})

    payload = {
        "meta": {
            "generated": datetime.date.today().isoformat(),
            "schemaVersion": SCHEMA_VERSION,
            "county": "Los Angeles",
            "ratingBasis": (
                "GreatSchools rating (1-10), from your own table in raw-data/school-ratings/ "
                f"({', '.join(files)}). Nothing is computed; a school the table does not list is unrated."
            ),
            "ratingFiles": files,
            "counts": counts,
            "rated": rated,
            "match": stats,
            "sources": [
                "Your table: " + ", ".join(files),
                "CA Dept of Education, Public Schools and Districts (pubschls) - to place each row",
            ],
        },
        "schools": schools,
        "byNces": by_nces,
        "byName": by_name,
    }

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))
    write_report(report, args.report)

    size = os.path.getsize(args.out)
    print(f"\nWrote {args.out} ({size / 1024:.0f} KB)")
    print(f"  {len(schools):,} active schools: {counts['elementary']:,} elementary, "
          f"{counts['middle']:,} middle, {counts['high']:,} high; {rated:,} carry your rating")
    print(f"\nYour {stats['rows']:,} rows:")
    print(f"  {stats['matched']:,} matched")
    for how, count in sorted(stats["matchedBy"].items(), key=lambda pair: -pair[1]):
        print(f"      {count:,} by {how}")
    for outcome in ("unmatched", "ambiguous", "duplicate", "invalid"):
        if stats[outcome]:
            print(f"  {stats[outcome]:,} {outcome}")
    print(f"\nEvery row, and why: {args.report}")
    if stats["unmatched"] or stats["ambiguous"]:
        print("  To fix a row, add a CDS column to your table and put the school's 14-digit code in it.")
    print("\nReload the page. The three school switches will use this file.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
