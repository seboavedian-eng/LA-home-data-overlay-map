"""Tests for scripts/fetch-school-data.py.

The directory cannot be downloaded from here and your ratings table lives on
your machine, so every test builds both synthetically. The table fixture uses
the exact header and the first rows of LA_County_Scored_Public_Schools.csv, so
a column-name mismatch fails here rather than on your first real run.

Run:  python tests/test_school_data.py
"""

import csv
import importlib.util
import io
import json
import os
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location(
    "school_data", os.path.join(REPO, "scripts", "fetch-school-data.py")
)
sd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sd)

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} - {name}" + (f" :: {detail}" if detail else ""))
    if not ok:
        failures.append(name)


# --- Level assignment --------------------------------------------------------


def test_levels():
    cases = [
        ("K-5", "60", "elementary", "a plain elementary"),
        ("K-6", "60", "elementary", "K-6 is still elementary"),
        ("6-8", "62", "middle", "a plain middle school"),
        ("7-8", "63", "middle", "a junior high"),
        ("9-12", "64", "high", "a plain high school"),
        ("K-8", "60", "elementary", "a K-8 leads as elementary"),
        ("", "64", "high", "no grade span falls back to the type code"),
        ("", "62", "middle", "...and for middle too"),
    ]
    for grades, soc, expected, why in cases:
        got = sd.school_level(soc, grades)
        check(f"level: {why}", got == expected, f"{grades!r}/{soc} -> {got}, wanted {expected}")

    # The case the grade span exists for: a school that is genuinely two
    # schools, and has to appear under both switches.
    check(
        "a K-8 appears under BOTH the elementary and middle switches",
        sd.spans_levels("K-8") == ["elementary", "middle"],
        str(sd.spans_levels("K-8")),
    )
    check(
        "a 7-12 appears under both middle and high",
        sd.spans_levels("7-12") == ["middle", "high"],
        str(sd.spans_levels("7-12")),
    )
    check(
        "a 9-12 appears under high only",
        sd.spans_levels("9-12") == ["high"],
        str(sd.spans_levels("9-12")),
    )
    check(
        "grade spans written with an en dash parse the same as a hyphen",
        sd.grade_bounds("K–12") == (0, 12),
        str(sd.grade_bounds("K–12")),
    )




# --- The directory -----------------------------------------------------------


DIRECTORY_HEADER = [
    "CDSCode", "StatusType", "County", "District", "School", "Street", "City",
    "Zip", "Charter", "SOC", "GSoffered", "Latitude", "Longitude",
    "NCESDist", "NCESSchool",
]


def directory_row(cds, name, soc, grades, status="Active", district="Test Unified",
                  county="Los Angeles", lat="34.05", lon="-118.25",
                  nces_dist="0622710", nces_school="12345", charter="N",
                  street="1 Main St", city="Los Angeles", zip_code="90012"):
    return [cds, status, county, district, name, street, city,
            zip_code, charter, soc, grades, lat, lon, nces_dist, nces_school]


def make_directory(rows):
    out = io.StringIO()
    out.write("\t".join(DIRECTORY_HEADER) + "\n")
    for row in rows:
        out.write("\t".join(row) + "\n")
    return out.getvalue().encode("utf-8")




def test_directory_reading():
    data = make_directory([
        directory_row("19000000000001", "Eagle Rock Elementary", "60", "K-5"),
        directory_row("19000000000002", "Closed Elementary", "60", "K-5", status="Closed"),
        # Orange County - must not appear in an LA County file.
        directory_row("30000000000003", "Anaheim Elementary", "60", "K-5",
                      county="Orange"),
        directory_row("19000000000004", "Wilson Middle", "62", "6-8"),
        directory_row("19000000000005", "Hoover High", "64", "9-12", zip_code="90012-3456"),
    ])
    schools = sd.read_directory(data)
    check("only LA County schools are kept", len(schools) == 3, f"{len(schools)} kept")
    check("a closed school is dropped, not drawn on a building that is not a school any more",
          "19000000000002" not in schools)
    check("an Orange County school is dropped", "30000000000003" not in schools)
    check(
        "the NCES id is assembled as district+school, which is how SABS joins",
        schools["19000000000001"]["nces"] == "062271012345",
        schools["19000000000001"]["nces"],
    )
    check(
        "the address is assembled for the popup",
        "90012" in schools["19000000000001"]["address"],
        schools["19000000000001"]["address"],
    )
    check(
        "a ZIP+4 is cut to five digits, which is what your table carries",
        schools["19000000000005"]["zip5"] == "90012",
        schools["19000000000005"]["zip5"],
    )


# --- Your table --------------------------------------------------------------

# The header of LA_County_Scored_Public_Schools.csv, exactly as saved.
TABLE_HEADER = "School Name,Address,City,Zip,Elementary,Middle?,High?,GreatSchools Rating"

# The rows visible in your screenshot, verbatim, plus the cases that matter.
TABLE_ROWS = [
    "Meadowlark Elementary School,3015 West Sacramento St.,Acton,93510,Yes,No,No,7",
    "iLEAD Hybrid,3720 Sierra Highway,Acton,93510,Yes,Yes,Yes,5",
    "Ilead Online,3720 Sierra Highway,Acton,93510,Yes,Yes,Yes,5",
    "Vasquez High School,33630 Red Rover Mine Road,Acton,93510,No,No,Yes,5",
    "High Desert School,3620 Antelope Woods Rd,Acton,93510,Yes,Yes,No,4",
    "Agoura High School,28545 West Driver Ave.,Agoura Hills,91301,No,No,Yes,9",
    "Willow Elementary School,29026 Laro Dr.,Agoura Hills,91301,Yes,No,No,9",
    "Sumac Elementary School,6050 North Calmfield Ave.,Agoura Hills,91301,Yes,No,No,8",
    "Yerba Buena Elementary School,6098 Reyes Adobe Road,Agoura Hills,91301,Yes,No,No,8",
    "Lindero Canyon Middle School,5844 Larboard Ln.,Agoura Hills,91301,No,Yes,No,7",
    # Same core name, same district, different schools: the old matcher's bug.
    "Eagle Rock Elementary School,2057 Fair Park Avenue,Los Angeles,90041,Yes,No,No,8",
    "Eagle Rock High School,1750 Yosemite Drive,Los Angeles,90041,No,Yes,Yes,6",
    # No such school.
    "Nowhere Elementary,1 Fake Street,Beverly Hills,90210,Yes,No,No,10",
    # A rating that is not a number.
    "Sumac Elementary School,6050 North Calmfield Ave.,Agoura Hills,91301,Yes,No,No,N/A",
    # The same school twice with a different rating.
    "Willow Elementary,29026 Laro Drive,Agoura Hills,91301,Yes,No,No,3",
    # Two schools share this address and the name fits both equally.
    "Hope Academy,500 Hope St,Los Angeles,90012,Yes,No,No,6",
    "",
]

STATE = [
    # cds, name, soc, grades, street (as CDE writes it), city, zip, nces school
    ("19000000000101", "Meadowlark Elementary", "60", "K-5", "3015 W. Sacramento St.", "Acton", "93510-1600", "00101"),
    ("19000000000102", "iLEAD Hybrid", "60", "K-12", "3720 Sierra Hwy.", "Acton", "93510-1234", "00102"),
    ("19000000000103", "iLEAD Online Charter", "60", "K-12", "3720 Sierra Hwy.", "Acton", "93510-1234", "00103"),
    ("19000000000104", "Vasquez High", "64", "9-12", "33630 Red Rover Mine Rd.", "Acton", "93510", "00104"),
    ("19000000000105", "High Desert", "60", "K-8", "3620 Antelope Woods Rd.", "Acton", "93510", "00105"),
    ("19000000000106", "Agoura High", "64", "9-12", "28545 W. Driver Ave.", "Agoura Hills", "91301-2800", "00106"),
    ("19000000000107", "Willow Elementary", "60", "K-5", "29026 Laro Dr.", "Agoura Hills", "91301", "00107"),
    ("19000000000108", "Sumac Elementary", "60", "K-5", "6050 N. Calmfield Ave.", "Agoura Hills", "91301", "00108"),
    ("19000000000109", "Yerba Buena Elementary", "60", "K-5", "6098 Reyes Adobe Rd.", "Agoura Hills", "91301", "00109"),
    ("19000000000110", "Lindero Canyon Middle", "62", "6-8", "5844 Larboard Ln.", "Agoura Hills", "91301", "00110"),
    ("19000000000111", "Eagle Rock Elementary", "60", "K-6", "2057 Fair Park Ave.", "Los Angeles", "90041", "00111"),
    ("19000000000112", "Eagle Rock High", "64", "9-12", "1750 Yosemite Dr.", "Los Angeles", "90041", "00112"),
    ("19000000000113", "Hope Academy East", "60", "K-5", "500 Hope St.", "Los Angeles", "90012", "00113"),
    ("19000000000114", "Hope Academy West", "60", "K-5", "500 Hope St.", "Los Angeles", "90012", "00114"),
    # Not in your table at all.
    ("19000000000115", "Unlisted Elementary", "60", "K-5", "9 Quiet Ln.", "Acton", "93510", "00115"),
]


def state_directory():
    rows = [
        directory_row(cds, name, soc, grades, street=street, city=city, zip_code=zip_code,
                      nces_school=nces, district="Test Unified")
        for cds, name, soc, grades, street, city, zip_code, nces in STATE
    ]
    return make_directory(rows)


def run_build(table_rows=None, header=TABLE_HEADER):
    """main() end to end, in a temp directory. Returns (exit code, payload, report rows)."""
    with tempfile.TemporaryDirectory() as tmp:
        ratings_dir = os.path.join(tmp, "school-ratings")
        os.makedirs(ratings_dir)
        with open(os.path.join(ratings_dir, "LA_County_Scored_Public_Schools.csv"), "w",
                  encoding="utf-8-sig", newline="") as handle:
            handle.write("\n".join([header] + (TABLE_ROWS if table_rows is None else table_rows)))
        dir_path = os.path.join(tmp, "pubschls.txt")
        with open(dir_path, "wb") as handle:
            handle.write(state_directory())
        out_path = os.path.join(tmp, "schools.json")
        report_path = os.path.join(tmp, "report.csv")
        code = sd.main(["--out", out_path, "--directory", dir_path,
                        "--ratings", ratings_dir, "--report", report_path])
        payload = None
        report = []
        if os.path.exists(out_path):
            with open(out_path, encoding="utf-8") as handle:
                payload = json.load(handle)
        if os.path.exists(report_path):
            with open(report_path, newline="", encoding="utf-8") as handle:
                report = list(csv.DictReader(handle))
    return code, payload, report


def test_address_matching():
    same = [
        ("3015 West Sacramento St.", "3015 W. Sacramento St."),
        ("3720 Sierra Highway", "3720 Sierra Hwy."),
        ("33630 Red Rover Mine Road", "33630 Red Rover Mine Rd."),
        ("6050 North Calmfield Ave.", "6050 N. Calmfield Ave."),
        ("100 Main Street, Suite 4", "100 Main St."),
    ]
    for left, right in same:
        check(f"one address written two ways matches: {left!r} = {right!r}",
              sd.same_address(sd.address_key(left), sd.address_key(right)),
              f"{sd.address_key(left)} vs {sd.address_key(right)}")
    check("a different house number is a different address",
          not sd.same_address(sd.address_key("3015 W Sacramento St"), sd.address_key("3017 W Sacramento St")))
    check("the same number on a different street is a different address",
          not sd.same_address(sd.address_key("100 Oak Ave"), sd.address_key("100 Pine Ave")))
    check("level words are kept, so Eagle Rock Elementary and Eagle Rock High differ",
          sd.name_tokens("Eagle Rock Elementary School") != sd.name_tokens("Eagle Rock High School"))


def test_your_table():
    code, payload, report = run_build()
    check("the script runs end to end on your table's exact header", code == 0, f"exit {code}")
    if not payload:
        check("...and writes the file", False)
        return
    schools = payload["schools"]

    def rating(cds, level):
        return (schools[cds].get("ratings") or {}).get(level)

    check("a row matches by address + zip despite 'West' vs 'W.' and 'St.'",
          rating("19000000000101", "elementary") == 7, str(schools["19000000000101"].get("ratings")))
    check("THE BUG: Eagle Rock Elementary keeps its own 8",
          rating("19000000000111", "elementary") == 8, str(schools["19000000000111"].get("ratings")))
    check("...and Eagle Rock High keeps its own 6, rather than both sharing whichever came last",
          rating("19000000000112", "high") == 6, str(schools["19000000000112"].get("ratings")))
    check("iLEAD Hybrid and iLEAD Online share an address; the name tells them apart",
          schools["19000000000102"].get("ratings") and schools["19000000000103"].get("ratings"),
          f"{schools['19000000000102'].get('ratings')} / {schools['19000000000103'].get('ratings')}")
    check("your Yes/No columns decide the levels: High Desert counts under elementary and middle",
          set(schools["19000000000105"]["ratings"]) == {"elementary", "middle"},
          str(schools["19000000000105"].get("ratings")))
    check("...and a level you did not mark gets no rating: Meadowlark is elementary only",
          set(schools["19000000000101"]["ratings"]) == {"elementary"},
          str(schools["19000000000101"].get("ratings")))
    check("a level you marked that the state span disagrees with still counts - your table is the truth",
          set(schools["19000000000112"]["ratings"]) == {"middle", "high"},
          str(schools["19000000000112"].get("ratings")))
    check("a school your table does not list has NO rating - nothing is computed",
          "ratings" not in schools["19000000000115"], str(schools["19000000000115"].get("ratings")))
    check("the duplicate row does not overwrite the first: Willow stays 9",
          rating("19000000000107", "elementary") == 9, str(schools["19000000000107"].get("ratings")))
    check("a rating of N/A does not wipe the good Sumac row",
          rating("19000000000108", "elementary") == 8, str(schools["19000000000108"].get("ratings")))
    check("a rated school says the number is GreatSchools', from your table",
          schools["19000000000101"].get("ratingSource") == "greatschools")
    check("two schools at one address that the name cannot separate are left unrated, not guessed",
          "ratings" not in schools["19000000000113"] and "ratings" not in schools["19000000000114"])

    meta = payload["meta"]
    check("the meta names the rating basis as GreatSchools, from your file",
          "GreatSchools" in meta["ratingBasis"] and "LA_County_Scored_Public_Schools.csv" in meta["ratingBasis"],
          meta["ratingBasis"][:90])
    check("nothing in the output mentions a computed rating", "CAASPP" not in json.dumps(meta))
    check("the schema is 2, so the page can tell a pre-GreatSchools file apart",
          meta["schemaVersion"] == 2, str(meta["schemaVersion"]))
    check("byName maps to a LIST, so a name shared by two schools is not silently one of them",
          all(isinstance(v, list) for v in payload["byName"].values()))
    check("the NCES index is built, which is how a zone finds its school",
          payload["byNces"].get("062271000111") == "19000000000111")

    # --- The report ---
    outcomes = {}
    for entry in report:
        outcomes.setdefault(entry["outcome"], []).append(entry)
    check("the report has one line per row of your table (blank lines aside)",
          len(report) == len([r for r in TABLE_ROWS if r]), f"{len(report)} lines")
    check("the report puts the rows you must act on first",
          report and report[0]["outcome"] in ("unmatched", "ambiguous"), report[0]["outcome"] if report else "")
    check("a row with no such school is reported as unmatched, with a reason",
          any(e["school"] == "Nowhere Elementary" and e["note"] for e in outcomes.get("unmatched", [])),
          str([(e["school"], e["note"]) for e in outcomes.get("unmatched", [])]))
    check("the Hope Academy row is reported as ambiguous and names both candidates",
          any("Hope Academy East" in e["note"] and "Hope Academy West" in e["note"]
              for e in outcomes.get("ambiguous", [])),
          str([e["note"] for e in outcomes.get("ambiguous", [])]))
    check("the N/A rating is reported as invalid", len(outcomes.get("invalid", [])) == 1)
    check("the second Willow row is reported as a duplicate of the first",
          len(outcomes.get("duplicate", [])) == 1 and "line" in outcomes["duplicate"][0]["note"])
    check("a matched row names the state school it landed on, so you can eyeball it",
          any(e["state_name"] == "Eagle Rock High" for e in outcomes.get("matched", [])))
    check("...and the state span disagreeing with your Yes/No is noted, not hidden",
          any("yours is used" in e["note"] for e in outcomes.get("matched", [])))


def test_match_fallbacks():
    directory = sd.Directory(sd.read_directory(state_directory()))
    base = {"file": "t.csv", "line": 2, "city": "Agoura Hills", "levels": None,
            "rating_text": "8", "rating": 8.0, "cds": "", "nces": ""}
    cds, how, _ = sd.match_row({**base, "name": "Yerba Buena Elementary School",
                                "address": "999 Somewhere Else Rd", "zip": "91301"}, directory)
    check("a school that moved buildings still matches on a strong name in the same zip",
          cds == "19000000000109" and "name" in how, f"{cds} {how}")
    cds, how, _ = sd.match_row({**base, "name": "Sumac Elementary", "address": "", "zip": ""}, directory)
    check("a row with no address or zip falls back to name + city", cds == "19000000000108", f"{cds} {how}")
    cds, how, _ = sd.match_row({**base, "name": "Anything", "address": "", "zip": "",
                                "cds": "19000000000104"}, directory)
    check("a CDS column beats every other way of matching", cds == "19000000000104" and "CDS" in how)
    cds, _, note = sd.match_row({**base, "name": "Anything", "address": "", "zip": "",
                                 "cds": "19999999999999"}, directory)
    check("a CDS code that is not a school says so", cds is None and "not an active" in note, note)


def test_no_table():
    code, payload, _ = run_build(table_rows=[], header="")
    check("with no ratings table the script stops and says what to do, rather than writing an empty file",
          code == 1 and payload is None, f"exit {code}")
    code, payload, _ = run_build(header="Name Of School,Score")
    check("a table without a school or rating column is skipped, not misread", code == 1, f"exit {code}")


def test_excel_encoding():
    """Excel's plain "CSV (Comma delimited)" writes Windows-1252, not UTF-8."""
    with tempfile.TemporaryDirectory() as tmp:
        with open(os.path.join(tmp, "excel.csv"), "wb") as handle:
            handle.write((TABLE_HEADER + "\nLos Niños Elementary,1 Main St,Los Angeles,90012,Yes,No,No,6\n")
                         .encode("cp1252"))
        rows = sd.read_ratings(tmp)
    check("a table saved by Excel as Windows-1252 is read, accents and all",
          len(rows) == 1 and rows[0]["name"] == "Los Niños Elementary",
          str([r["name"] for r in rows]))


def test_nothing_is_computed():
    source = open(os.path.join(REPO, "scripts", "fetch-school-data.py"), encoding="utf-8").read()
    check("the script no longer downloads or computes test-score ratings",
          "caaspp" not in source.lower() and "decile" not in source.lower())


def main():
    test_levels()
    test_directory_reading()
    test_address_matching()
    test_your_table()
    test_match_fallbacks()
    test_no_table()
    test_excel_encoding()
    test_nothing_is_computed()
    print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'All school-data checks passed.'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
