"""Tests for scripts/fetch-school-data.py.

The two input files cannot be downloaded from here, so every test builds them
synthetically. That is not a weakness of the test: the interesting failures in
this script are all shape failures - a level assigned from the wrong field, a
district total counted as a school, a decile computed over five schools - and
a synthetic file exercises those precisely.

Run:  python tests/test_school_data.py
"""

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


# --- Name matching -----------------------------------------------------------


def test_name_matching():
    same = [
        ("Roosevelt Elementary", "Theodore Roosevelt Elementary School"),
        ("Eagle Rock El", "Eagle Rock Elementary"),
        ("Hoover High School", "Hoover High"),
    ]
    for left, right in same:
        check(
            f"the same school written two ways matches: {left!r} = {right!r}",
            sd.normalise_name(left) in sd.normalise_name(right)
            or sd.normalise_name(right) in sd.normalise_name(left),
            f"{sd.normalise_name(left)!r} vs {sd.normalise_name(right)!r}",
        )
    check(
        "two genuinely different schools do not collapse together",
        sd.normalise_name("Lincoln Elementary") != sd.normalise_name("Jefferson Elementary"),
    )


# --- Deciles -----------------------------------------------------------------


def test_deciles():
    values = {f"s{i}": float(i) for i in range(100)}
    ratings = sd.decile_ratings(values)
    check("a decile rating never falls outside 1-10", set(ratings.values()) <= set(range(1, 11)),
          str(sorted(set(ratings.values()))))
    check("the worst school rates 1", ratings["s0"] == 1, str(ratings["s0"]))
    check("the best school rates 10", ratings["s99"] == 10, str(ratings["s99"]))
    check(
        "the ranking is even - ten schools per band over a hundred",
        all(list(ratings.values()).count(band) == 10 for band in range(1, 11)),
        str({band: list(ratings.values()).count(band) for band in range(1, 11)}),
    )

    # The reason this ranks positions rather than cutting the value range:
    # proficiency percentages bunch up, and cutting the range would put almost
    # everything in one band.
    bunched = {f"s{i}": 40.0 + i * 0.1 for i in range(50)}
    bunched["outlier"] = 95.0
    ratings = sd.decile_ratings(bunched)
    spread = len(set(ratings.values()))
    check(
        "bunched scores still spread across the bands, rather than collapsing",
        spread >= 8,
        f"{spread} distinct ratings among 51 bunched schools",
    )

    tied = {"a": 50.0, "b": 50.0, "c": 90.0}
    ratings = sd.decile_ratings(tied)
    check("schools with identical scores get identical ratings",
          ratings["a"] == ratings["b"], f"{ratings}")
    check("an empty set of scores is not a crash", sd.decile_ratings({}) == {})


# --- The two input files, end to end ----------------------------------------


DIRECTORY_HEADER = [
    "CDSCode", "StatusType", "County", "District", "School", "Street", "City",
    "Zip", "Charter", "SOC", "GSoffered", "Latitude", "Longitude",
    "NCESDist", "NCESSchool",
]


def directory_row(cds, name, soc, grades, status="Active", district="Test Unified",
                  county="Los Angeles", lat="34.05", lon="-118.25",
                  nces_dist="0622710", nces_school="12345", charter="N"):
    return [cds, status, county, district, name, "1 Main St", "Los Angeles",
            "90012", charter, soc, grades, lat, lon, nces_dist, nces_school]


def make_directory(rows):
    out = io.StringIO()
    out.write("\t".join(DIRECTORY_HEADER) + "\n")
    for row in rows:
        out.write("\t".join(row) + "\n")
    return out.getvalue().encode("utf-8")


CAASPP_HEADER = [
    "County Code", "District Code", "School Code", "Filler", "Subgroup ID",
    "Grade", "Test Type", "Filler2", "Test Id", "Filler3",
    "Students with Scores", "F1", "F2", "F3", "F4",
    "Percentage Standard Met and Above",
]


def caaspp_row(county, district, school, test, met, tested=200, subgroup="1", grade="13"):
    row = [""] * len(CAASPP_HEADER)
    row[0], row[1], row[2] = county, district, school
    row[4], row[5], row[8] = subgroup, grade, test
    row[10] = str(tested)
    row[15] = str(met)
    return row


def make_caaspp(rows):
    out = io.StringIO()
    out.write("^".join(CAASPP_HEADER) + "\n")
    for row in rows:
        out.write("^".join(row) + "\n")
    return out.getvalue().encode("utf-8")


def test_directory_reading():
    data = make_directory([
        directory_row("19000000000001", "Eagle Rock Elementary", "60", "K-5"),
        directory_row("19000000000002", "Closed Elementary", "60", "K-5", status="Closed"),
        # Orange County - must not appear in an LA County file.
        directory_row("30000000000003", "Anaheim Elementary", "60", "K-5",
                      county="Orange"),
        directory_row("19000000000004", "Wilson Middle", "62", "6-8"),
        directory_row("19000000000005", "Hoover High", "64", "9-12"),
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


def test_caaspp_reading():
    data = make_caaspp([
        caaspp_row("19", "64733", "0000001", "1", "62.5"),
        caaspp_row("19", "64733", "0000001", "2", "48.0"),
        # A district total. Counting this as a school would put a fake school
        # in the ranking and shift every decile.
        caaspp_row("19", "64733", "0000000", "1", "55.0"),
        # Another county.
        caaspp_row("30", "11111", "0000009", "1", "70.0"),
        # A subgroup other than "all students".
        caaspp_row("19", "64733", "0000002", "1", "30.0", subgroup="128"),
        # A single grade rather than the all-grades summary.
        caaspp_row("19", "64733", "0000003", "1", "80.0", grade="3"),
    ])
    scores = sd.read_caaspp(data)
    check("only real LA County schools survive the filters", len(scores) == 1, str(list(scores)))
    key = "19647330000001"
    check("the CDS code is assembled from county+district+school",
          key in scores, str(list(scores)))
    check("ELA and Math land on the same school", scores[key]["ela"] == 62.5 and scores[key]["math"] == 48.0,
          str(scores.get(key)))
    check("a district TOTAL row is not counted as a school",
          "19647330000000" not in scores)
    check("a subgroup row is not counted as the school's score",
          "19647330000002" not in scores)
    check("a single-grade row is not counted as the all-grades score",
          "19647330000003" not in scores)


def test_end_to_end():
    """main() run against both synthetic files, in a temp directory."""
    directory_rows = []
    caaspp_rows = []
    # Twenty elementary schools with a spread of scores, so deciles mean
    # something, plus one middle and one high.
    for i in range(1, 21):
        cds = f"1900000{i:07d}"
        directory_rows.append(
            directory_row(cds, f"Elementary {i}", "60", "K-5", nces_school=f"{i:05d}")
        )
        caaspp_rows.append(caaspp_row("19", "00000", f"{i:07d}", "1", f"{30 + i * 2}"))
        caaspp_rows.append(caaspp_row("19", "00000", f"{i:07d}", "2", f"{25 + i * 2}"))
    # A school with almost no test-takers: a decile from 5 children is noise.
    directory_rows.append(directory_row("19000009999901", "Tiny Elementary", "60", "K-5"))
    caaspp_rows.append(caaspp_row("19", "00000", "9999901", "1", "99", tested=5))
    # A K-8, which must be rated under both elementary and middle.
    directory_rows.append(directory_row("19000009999902", "Spans Both", "60", "K-8"))
    caaspp_rows.append(caaspp_row("19", "00000", "9999902", "1", "70"))
    caaspp_rows.append(caaspp_row("19", "00000", "9999902", "2", "60"))

    with tempfile.TemporaryDirectory() as tmp:
        dir_path = os.path.join(tmp, "pubschls.txt")
        caaspp_path = os.path.join(tmp, "caaspp.txt")
        out_path = os.path.join(tmp, "schools.json")
        with open(dir_path, "wb") as handle:
            handle.write(make_directory(directory_rows))
        with open(caaspp_path, "wb") as handle:
            handle.write(make_caaspp(caaspp_rows))

        code = sd.main(["--out", out_path, "--directory", dir_path, "--caaspp", caaspp_path])
        check("the script runs end to end and exits clean", code == 0, f"exit {code}")

        with open(out_path, encoding="utf-8") as handle:
            payload = json.load(handle)

    schools = payload["schools"]
    check("every school reaches the file", len(schools) == 22, f"{len(schools)}")
    check("the meta names the rating basis, so the card can too",
          "CAASPP" in payload["meta"]["ratingBasis"]
          and "not the GreatSchools rating" in payload["meta"]["ratingBasis"],
          payload["meta"]["ratingBasis"][:60])

    rated = [s for s in schools.values() if "ratings" in s]
    check("schools with scores carry a rating", len(rated) == 21, f"{len(rated)} rated")
    check(
        "a school code of all zeroes is a district total and never a school",
        "19000000000000" not in schools,
        "the fixture deliberately avoids it; the guard is what makes that necessary",
    )
    check(
        "a school with five test-takers gets NO rating rather than a loud wrong one",
        "ratings" not in schools["19000009999901"],
        str(schools["19000009999901"].get("ratings")),
    )
    both = schools["19000009999902"]
    check(
        "a K-8 counts under both levels it serves",
        set(both["levels"]) == {"elementary", "middle"},
        str(both.get("levels")),
    )
    # It is the only middle school here, so it must NOT get a middle rating:
    # "1 of 10" from a pool of one is a damning verdict drawn from nothing.
    check(
        "a level with too few schools to rank yields no rating, not a bottom rating",
        set(both["ratings"]) == {"elementary"},
        str(both.get("ratings")),
    )
    check(
        "...and the run records which level it could not rank",
        any("middle" in entry for entry in payload["meta"]["unrankedLevels"]),
        str(payload["meta"]["unrankedLevels"]),
    )
    best = schools["1900000" + f"{20:07d}"]["ratings"]["elementary"]
    worst = schools["1900000" + f"{1:07d}"]["ratings"]["elementary"]
    check("the highest-scoring school rates above the lowest", best > worst, f"{best} vs {worst}")
    check(
        "the NCES index is built, which is how a SABS polygon finds its school",
        payload["byNces"].get("062271000020") == "1900000" + f"{20:07d}",
        str(list(payload["byNces"].items())[:2]),
    )
    check(
        "a name index exists as the fallback join",
        len(payload["byName"]) >= 20,
        f"{len(payload['byName'])} names",
    )


def test_your_ratings_win():
    """The override folder is the answer to 'GreatSchools has no free API'."""
    directory_rows = [
        directory_row(f"1900000{i:07d}", f"Elementary {i}", "60", "K-5") for i in range(1, 21)
    ]
    caaspp_rows = []
    for i in range(1, 21):
        caaspp_rows.append(caaspp_row("19", "00000", f"{i:07d}", "1", f"{30 + i * 2}"))

    with tempfile.TemporaryDirectory() as tmp:
        override_dir = os.path.join(tmp, "school-ratings")
        os.makedirs(override_dir)
        with open(os.path.join(override_dir, "mine.csv"), "w", encoding="utf-8") as handle:
            handle.write("school,district,rating\n")
            handle.write("Elementary 1,Test Unified,9\n")

        original = sd.OVERRIDE_DIR
        sd.OVERRIDE_DIR = override_dir
        try:
            dir_path = os.path.join(tmp, "pubschls.txt")
            caaspp_path = os.path.join(tmp, "caaspp.txt")
            out_path = os.path.join(tmp, "schools.json")
            with open(dir_path, "wb") as handle:
                handle.write(make_directory(directory_rows))
            with open(caaspp_path, "wb") as handle:
                handle.write(make_caaspp(caaspp_rows))
            sd.main(["--out", out_path, "--directory", dir_path, "--caaspp", caaspp_path])
            with open(out_path, encoding="utf-8") as handle:
                payload = json.load(handle)
        finally:
            sd.OVERRIDE_DIR = original

    worst = payload["schools"]["1900000" + f"{1:07d}"]
    check(
        "a rating you supplied beats the computed one",
        worst["ratings"]["elementary"] == 9,
        str(worst.get("ratings")),
    )
    check(
        "...and the file records that it was yours, so the card can say so",
        worst.get("ratingSource") == "yours",
        str(worst.get("ratingSource")),
    )
    check(
        "the run reports how many you overrode",
        payload["meta"]["overridden"] == 1,
        str(payload["meta"]["overridden"]),
    )


def main():
    test_levels()
    test_name_matching()
    test_deciles()
    test_directory_reading()
    test_caaspp_reading()
    test_end_to_end()
    test_your_ratings_win()
    print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'All school-data checks passed.'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
